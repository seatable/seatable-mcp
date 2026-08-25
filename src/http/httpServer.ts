import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { OAuthProvider } from '../auth/oauthProvider.js'
import { TokenValidator } from '../auth/tokenValidator.js'
import { getEnv, type ServerMode, VERSION } from '../config/env.js'
import { logger } from '../logger.js'
import { buildServer, getStaticToolDefinitions } from '../mcp/server.js'
import { activeConnections, activeSessions, httpRequestsTotal } from '../metrics/index.js'
import { startMetricsServer } from '../metrics/metricsServer.js'
import { RateLimitManager } from '../ratelimit/index.js'

export interface StartHttpServerOptions {
    host?: string
    port?: number
    /** Session idle timeout in ms (default: 10 minutes) */
    sessionIdleTimeoutMs?: number
    /** Interval for checking idle sessions in ms (default: 60 seconds) */
    sessionCheckIntervalMs?: number
}

type ActiveSession = {
    transport: StreamableHTTPServerTransport
    apiToken?: string
    /** Digest of the SeaTable API token that created this session; every later request must resolve to the same one. */
    apiTokenDigest?: Buffer
    lastActivity: number
    close: () => Promise<void>
}

function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest()
}

/** Session IDs are credentials-adjacent routing values — log a fingerprint, never the value. */
function sessionFingerprint(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
}

const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let totalSize = 0
        req.on('data', (chunk) => {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            totalSize += buf.length
            if (totalSize > MAX_BODY_SIZE) {
                req.destroy()
                reject(new Error('Request body too large'))
                return
            }
            chunks.push(buf)
        })
        req.on('end', () => {
            if (!chunks.length) {
                resolve(undefined)
                return
            }
            try {
                const data = Buffer.concat(chunks).toString('utf-8')
                resolve(JSON.parse(data))
            } catch (error) {
                reject(error)
            }
        })
        req.on('error', reject)
    })
}

/**
 * Hosts allowed as remote https callbacks in the OAuth flow. Unset means the
 * built-in list of hosted MCP clients; '*' disables curation (dangerous).
 */
function parseTrustedRedirectHosts(): string[] | undefined {
    const raw = process.env.SEATABLE_OAUTH_TRUSTED_REDIRECT_HOSTS
    if (raw === undefined) return undefined
    return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
}

function parseCorsOrigins(): string[] {
    const raw = process.env.CORS_ALLOWED_ORIGINS
    if (!raw) return []
    return raw.split(',').map(o => o.trim()).filter(Boolean)
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
    const origin = req.headers.origin
    if (!origin || !allowedOrigins.includes(origin)) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, anthropic-version, x-api-key')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
}

export async function startHttpServer(options: StartHttpServerOptions = {}) {
    const host = options.host ?? process.env.HOST ?? '0.0.0.0'
    const port = options.port ?? Number(process.env.PORT ?? 3000)

    const corsOrigins = parseCorsOrigins()

    const env = getEnv()
    const mode: ServerMode = env.SEATABLE_MODE
    const tokenValidator = mode === 'managed' ? new TokenValidator(env.SEATABLE_SERVER_URL) : undefined
    const rateLimiter = mode === 'managed' ? new RateLimitManager() : undefined

    const oauthProvider = mode === 'managed' ? new OAuthProvider({
        hostname: process.env.SEATABLE_MCP_HOSTNAME,
        secret: env.SEATABLE_TOKEN_SECRET,
        trustedRedirectHosts: parseTrustedRedirectHosts(),
        validateToken: tokenValidator ? (token) => tokenValidator.validate(token) : undefined,
        looksLikeAccountToken: tokenValidator ? (token) => tokenValidator.looksLikeAccountToken(token) : undefined,
        getClientIp: (req) => getClientIp(req),
    }) : undefined

    const toolDefinitions = getStaticToolDefinitions()
    const sessions = new Map<string, ActiveSession>()

    function extractBearerToken(req: IncomingMessage): string | undefined {
        const auth = req.headers.authorization
        if (!auth) return undefined
        return auth.startsWith('Bearer ') ? auth.slice(7) : auth
    }

    /**
     * Turns a presented Bearer credential into the SeaTable API token behind it.
     *
     * Accepts both an OAuth access token we issued (sealed, resolved locally) and a
     * raw SeaTable API token (for clients that configure one directly). Either way
     * the underlying token is validated against SeaTable, so a revoked token stops
     * working within the validator's cache window.
     */
    async function resolveApiToken(bearer: string): Promise<string | undefined> {
        const candidate = oauthProvider?.resolveAccessToken(bearer) ?? bearer
        if (!(await tokenValidator!.validate(candidate))) return undefined
        return candidate
    }

    const trustProxy = env.TRUST_PROXY ?? true

    function getClientIp(req: IncomingMessage): string {
        if (trustProxy) {
            const forwarded = req.headers['x-forwarded-for']
            if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
        }
        return req.socket.remoteAddress ?? 'unknown'
    }

    /**
     * Throttle an OAuth endpoint by client IP. Returns true when the request was
     * rejected and a response has already been sent.
     */
    function oauthThrottled(req: IncomingMessage, res: ServerResponse, isTokenSubmission = false): boolean {
        if (!rateLimiter) return false
        const ip = getClientIp(req)
        const checks = isTokenSubmission
            ? [rateLimiter.tokenSubmission.check(ip), rateLimiter.oauth.check(ip)]
            : [rateLimiter.oauth.check(ip)]
        for (const result of checks) {
            if (!result.allowed) {
                logger.warn({ ip, endpoint: req.url }, 'OAuth rate limit exceeded')
                res.writeHead(429, {
                    'content-type': 'text/plain',
                    'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
                }).end('Too many requests')
                return true
            }
        }
        return false
    }

    async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // Rate limiting (managed mode only)
        if (rateLimiter) {
            const ip = getClientIp(req)
            const sessionId_ = req.headers['mcp-session-id'] as string | undefined
            const token = sessionId_ ? sessions.get(sessionId_)?.apiToken : undefined
            const result = rateLimiter.check({ ip, token })
            if (!result.allowed) {
                logger.warn({ ip, reason: result.reason }, 'Rate limit exceeded')
                const retryAfter = Math.ceil(result.retryAfterMs / 1000)
                res.writeHead(429, {
                    'content-type': 'text/plain',
                    'retry-after': String(retryAfter),
                }).end(result.reason)
                return
            }
        }

        // Parse body for POST requests
        const body = req.method === 'POST' ? await parseJsonBody(req) : undefined

        // Extract session ID from header
        const sessionId = req.headers['mcp-session-id'] as string | undefined

        // For POST without session ID: this is an initialization request → new session
        if (req.method === 'POST' && !sessionId) {
            // Pre-auth rate limiting: cap new session creation per IP to prevent token-validation flooding
            if (rateLimiter) {
                const preAuthResult = rateLimiter.preAuth.check(getClientIp(req))
                if (!preAuthResult.allowed) {
                    logger.warn({ ip: getClientIp(req) }, 'Pre-auth rate limit exceeded')
                    const retryAfter = Math.ceil(preAuthResult.retryAfterMs / 1000)
                    res.writeHead(429, {
                        'content-type': 'text/plain',
                        'retry-after': String(retryAfter),
                    }).end('Too many authentication attempts')
                    return
                }
            }

            // In managed mode: require and validate Bearer token
            let apiToken: string | undefined
            if (mode === 'managed') {
                const bearer = extractBearerToken(req)
                if (!bearer) {
                    logger.warn({ ip: getClientIp(req) }, 'Missing Authorization header')
                    res.writeHead(401, { 'content-type': 'text/plain' }).end('Missing Authorization header')
                    return
                }
                apiToken = await resolveApiToken(bearer)
                if (!apiToken) {
                    logger.warn({ ip: getClientIp(req) }, 'Invalid API token')
                    res.writeHead(401, { 'content-type': 'text/plain' }).end('Invalid API token')
                    return
                }
            }

            // Connection limit (managed mode)
            if (rateLimiter && apiToken) {
                if (!rateLimiter.connections.acquire(apiToken)) {
                    logger.warn({ ip: getClientIp(req) }, 'Connection limit exceeded')
                    res.writeHead(429, { 'content-type': 'text/plain' }).end('Too many concurrent connections')
                    return
                }
                activeConnections.inc()
            }

            const mcpServer = buildServer(apiToken ? { apiToken } : undefined)
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    mcpServer.setSessionId(id)
                    logger.info({ session: sessionFingerprint(id) }, 'Session initialized')
                    sessions.set(id, {
                        transport,
                        apiToken,
                        apiTokenDigest: apiToken ? digest(apiToken) : undefined,
                        lastActivity: Date.now(),
                        close: cleanup,
                    })
                    activeSessions.inc()
                },
            })

            let cleaned = false
            const cleanup = async () => {
                if (cleaned) return
                cleaned = true
                activeSessions.dec()
                if (apiToken && rateLimiter) {
                    rateLimiter.connections.release(apiToken)
                    activeConnections.dec()
                }
                if (transport.sessionId) {
                    sessions.delete(transport.sessionId)
                }
                try {
                    await transport.close()
                } catch (error) {
                    logger.debug({ err: error }, 'Error closing transport')
                }
                try {
                    await mcpServer.close()
                } catch (error) {
                    logger.debug({ err: error }, 'Error closing MCP server')
                }
            }

            transport.onclose = () => {
                void cleanup()
            }

            await mcpServer.connect(transport)
            await transport.handleRequest(req, res, body)
            return
        }

        // For requests with an existing session ID: authenticate first, then look up the session.
        // The session ID is a routing value, never an authorization credential.
        if (sessionId) {
            let presentedDigest: Buffer | undefined
            if (mode === 'managed') {
                const bearer = extractBearerToken(req)
                if (!bearer) {
                    logger.warn({ ip: getClientIp(req), session: sessionFingerprint(sessionId) }, 'Session request without Authorization header')
                    res.writeHead(401, { 'content-type': 'text/plain' }).end('Missing Authorization header')
                    return
                }
                const apiToken = await resolveApiToken(bearer)
                if (!apiToken) {
                    logger.warn({ ip: getClientIp(req), session: sessionFingerprint(sessionId) }, 'Session request with invalid credential')
                    res.writeHead(401, { 'content-type': 'text/plain' }).end('Invalid API token')
                    return
                }
                presentedDigest = digest(apiToken)
            }

            const session = sessions.get(sessionId)
            if (!session) {
                logger.debug({ session: sessionFingerprint(sessionId) }, 'Session not found')
                res.writeHead(404, { 'content-type': 'text/plain' }).end('Session expired. Please reconnect to start a new session.')
                return
            }

            if (presentedDigest) {
                const owner = session.apiTokenDigest
                if (!owner || owner.length !== presentedDigest.length || !timingSafeEqual(owner, presentedDigest)) {
                    logger.warn({ ip: getClientIp(req), session: sessionFingerprint(sessionId) }, 'Session request from a different identity')
                    res.writeHead(403, { 'content-type': 'text/plain' }).end('Credential does not match this session')
                    return
                }
            }

            session.lastActivity = Date.now()
            await session.transport.handleRequest(req, res, body)
            return
        }

        // GET/DELETE without session ID
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing mcp-session-id header')
    }

    const server = createServer(async (req, res) => {
        // Security headers on every response
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('X-Frame-Options', 'DENY')

        res.on('finish', () => {
            httpRequestsTotal.inc({ method: req.method ?? 'UNKNOWN', status: String(res.statusCode) })
        })

        if (!req.url) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing request URL')
            return
        }

        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

        // CORS handling
        if (corsOrigins.length > 0) {
            setCorsHeaders(req, res, corsOrigins)
            if (req.method === 'OPTIONS') {
                res.writeHead(204).end()
                return
            }
        }

        if (url.pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
            try {
                await handleMcpRequest(req, res)
            } catch (error) {
                logger.error({ err: error }, 'Error handling MCP request')
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal server error')
                }
            }
            return
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: VERSION }))
            return
        }

        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'seatable-mcp', version: VERSION, docs: 'https://github.com/seatable/seatable-mcp' }))
            return
        }

        if (req.method === 'GET' && url.pathname === '/.well-known/openai-apps-challenge' && process.env.OPENAI_APPS_CHALLENGE_TOKEN) {
            res.writeHead(200, { 'content-type': 'text/plain' }).end(process.env.OPENAI_APPS_CHALLENGE_TOKEN)
            return
        }

        if (req.method === 'GET' && url.pathname === '/.well-known/mcp/server-card.json') {
            const card = {
                serverInfo: { name: '@seatable/mcp-seatable', version: VERSION },
                authentication: mode === 'managed'
                    ? { required: true, schemes: ['oauth', 'bearer'] }
                    : { required: false },
                capabilities: { tools: true, resources: false, prompts: false },
                tools: toolDefinitions,
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card))
            return
        }

        // OAuth endpoints (managed mode only)
        if (oauthProvider && req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
            oauthProvider.handleMetadata(req, res)
            return
        }

        if (oauthProvider && (url.pathname === '/authorize' || url.pathname === '/oauth/authorize') && (req.method === 'GET' || req.method === 'POST')) {
            if (oauthThrottled(req, res, req.method === 'POST')) return
            try {
                await oauthProvider.handleAuthorize(req, res, url)
            } catch (error) {
                logger.error({ err: error }, 'Error handling OAuth authorize')
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal server error')
                }
            }
            return
        }

        if (oauthProvider && (url.pathname === '/token' || url.pathname === '/oauth/token') && req.method === 'POST') {
            if (oauthThrottled(req, res)) return
            try {
                await oauthProvider.handleToken(req, res)
            } catch (error) {
                logger.error({ err: error }, 'Error handling OAuth token exchange')
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal server error')
                }
            }
            return
        }

        if (oauthProvider && url.pathname === '/register' && req.method === 'POST') {
            if (oauthThrottled(req, res)) return
            try {
                await oauthProvider.handleRegister(req, res)
            } catch (error) {
                logger.error({ err: error }, 'Error handling OAuth client registration')
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal server error')
                }
            }
            return
        }

        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }))
    })

    await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve())
        server.once('error', (error) => reject(error))
        server.listen(port, host)
    })

    logger.info({ host, port, endpoint: '/mcp' }, 'Streamable HTTP server listening')

    // Idle session cleanup
    const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 10 * 60 * 1000
    const sessionCheckIntervalMs = options.sessionCheckIntervalMs ?? 60 * 1000
    const idleCheckInterval = setInterval(() => {
        const now = Date.now()
        for (const [sessionId, session] of sessions.entries()) {
            if (now - session.lastActivity > sessionIdleTimeoutMs) {
                logger.info({ session: sessionFingerprint(sessionId) }, 'Closing idle session')
                void session.close()
            }
        }
    }, sessionCheckIntervalMs)

    // Start Prometheus metrics server on a separate port
    await startMetricsServer()

    const shutdown = async () => {
        clearInterval(idleCheckInterval)
        tokenValidator?.destroy()
        rateLimiter?.destroy()
        oauthProvider?.destroy()
        const sessionCount = sessions.size
        for (const [sessionId, session] of sessions.entries()) {
            logger.debug({ session: sessionFingerprint(sessionId) }, 'Closing session during shutdown')
            await session.close()
        }
        await new Promise<void>((resolve) => server.close(() => resolve()))
        logger.info({ closedSessions: sessionCount }, 'Shutdown complete')
    }

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    for (const signal of signals) {
        process.once(signal, () => {
            logger.info({ signal }, 'Received shutdown signal')
            shutdown().catch((error) => {
                logger.error({ err: error }, 'Error during shutdown')
            })
        })
    }

    return server
}
