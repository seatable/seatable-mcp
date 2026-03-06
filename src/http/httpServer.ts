import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

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
    lastActivity: number
    close: () => Promise<void>
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

export async function startHttpServer(options: StartHttpServerOptions = {}) {
    const host = options.host ?? process.env.HOST ?? '0.0.0.0'
    const port = options.port ?? Number(process.env.PORT ?? 3000)

    const env = getEnv()
    const mode: ServerMode = env.SEATABLE_MODE
    const tokenValidator = mode === 'managed' ? new TokenValidator(env.SEATABLE_SERVER_URL) : undefined
    const rateLimiter = mode === 'managed' ? new RateLimitManager() : undefined

    const toolDefinitions = getStaticToolDefinitions()
    const sessions = new Map<string, ActiveSession>()

    function extractBearerToken(req: IncomingMessage): string | undefined {
        const auth = req.headers.authorization
        if (!auth) return undefined
        return auth.startsWith('Bearer ') ? auth.slice(7) : auth
    }

    function getClientIp(req: IncomingMessage): string {
        const forwarded = req.headers['x-forwarded-for']
        if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
        return req.socket.remoteAddress ?? 'unknown'
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
            // In managed mode: require and validate Bearer token
            let apiToken: string | undefined
            if (mode === 'managed') {
                apiToken = extractBearerToken(req)
                if (!apiToken) {
                    logger.warn({ ip: getClientIp(req) }, 'Missing Authorization header')
                    res.writeHead(401, { 'content-type': 'text/plain' }).end('Missing Authorization header')
                    return
                }
                const valid = await tokenValidator!.validate(apiToken)
                if (!valid) {
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
                    logger.info({ sessionId: id }, 'Session initialized')
                    sessions.set(id, { transport, apiToken, lastActivity: Date.now(), close: cleanup })
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

        // For requests with an existing session ID: look up the session
        if (sessionId) {
            const session = sessions.get(sessionId)
            if (!session) {
                logger.debug({ sessionId }, 'Session not found')
                res.writeHead(404, { 'content-type': 'text/plain' }).end('Session expired. Please reconnect to start a new session.')
                return
            }
            session.lastActivity = Date.now()
            await session.transport.handleRequest(req, res, body)
            return
        }

        // GET/DELETE without session ID
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing mcp-session-id header')
    }

    const server = createServer(async (req, res) => {
        res.on('finish', () => {
            httpRequestsTotal.inc({ method: req.method ?? 'UNKNOWN', status: String(res.statusCode) })
        })

        if (!req.url) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing request URL')
            return
        }

        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

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

        if (req.method === 'GET' && url.pathname === '/.well-known/mcp/server-card.json') {
            const card = {
                serverInfo: { name: '@seatable/mcp-seatable', version: VERSION },
                authentication: { required: true, schemes: ['bearer'] },
                capabilities: { tools: true, resources: false, prompts: false },
                tools: toolDefinitions,
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card))
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
                logger.info({ sessionId }, 'Closing idle session')
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
        const sessionCount = sessions.size
        for (const [sessionId, session] of sessions.entries()) {
            logger.debug({ sessionId }, 'Closing session during shutdown')
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
