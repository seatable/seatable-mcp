import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { logger } from '../logger.js'
import { TokenCipher } from './tokenCipher.js'

interface AuthorizationCode {
    apiToken: string
    /** The client the code was issued to. The same client must present it at /token. */
    clientId: string
    redirectUri: string
    codeChallenge: string
    expiresAt: number
}

interface AuthorizePageOptions {
    client: ClientRegistration
    clientId: string
    redirectUri: string
    callbackOrigin: string
    state: string
    responseType: string
    codeChallenge: string
    codeChallengeMethod: string
}

interface ClientRegistration extends Record<string, unknown> {
    /** client_name */
    n: string
    /** registered redirect_uris */
    r: string[]
}

const CODE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour
const MIN_REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1 year
const CLEANUP_INTERVAL_MS = 60 * 1000

export interface OAuthProviderOptions {
    hostname?: string
    /** Optional callback to validate an API token before issuing an authorization code. */
    validateToken?: (token: string) => Promise<boolean>
    /**
     * Hostnames whose https callbacks may receive an authorization code.
     * Exact, case-insensitive match — no subdomain wildcards. Loopback and
     * private-use schemes are always allowed and need no entry here.
     * A single '*' disables curation entirely (dangerous; see README).
     * Defaults to DEFAULT_TRUSTED_REDIRECT_HOSTS.
     */
    trustedRedirectHosts?: string[]
    /**
     * Lifetime of an issued access token, in ms. Defaults to one hour.
     * Shorter narrows the window after a SeaTable token is revoked; longer
     * spares users a re-prompt if their client renews badly.
     */
    accessTokenTtlMs?: number
    /** Resolves the client IP for audit logging. Falls back to 'unknown'. */
    getClientIp?: (req: IncomingMessage) => string
    /**
     * Distinguishes the two SeaTable token types. Called only after validation
     * failed, to turn "Invalid API token" into a message that names the mistake.
     */
    looksLikeAccountToken?: (token: string) => Promise<boolean>
    /**
     * Secret used to seal access tokens, refresh tokens and client registrations.
     * Must be stable across restarts, otherwise every client is forced to re-authorize.
     */
    secret?: string
}

function parseRedirectUri(raw: string): URL | undefined {
    try {
        const url = new URL(raw)
        return url.hash ? undefined : url
    } catch {
        return undefined
    }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * Hosted MCP clients whose callbacks live on their own servers. These are the
 * only destinations that receive an authorization code over the network, so
 * they are curated rather than open. Operators extend or replace this via
 * SEATABLE_OAUTH_TRUSTED_REDIRECT_HOSTS.
 */
export const DEFAULT_TRUSTED_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com']

/** Schemes that can execute or read local content and must never be a callback. */
const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'file', 'blob', 'vbscript', 'about', 'view-source'])

function isLoopback(url: URL): boolean {
    return LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Exact string match, with the RFC 8252 §7.3 carve-out: a loopback client may
 * use a different port than it registered, because the port is picked at runtime.
 */
function redirectUriMatches(registered: string, candidate: string): boolean {
    if (registered === candidate) return true
    try {
        const a = new URL(registered)
        const b = new URL(candidate)
        if (!isLoopback(a) || !isLoopback(b)) return false
        return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname
    } catch {
        return false
    }
}

export class OAuthProvider {
    private readonly codes = new Map<string, AuthorizationCode>()
    private readonly cleanupInterval: ReturnType<typeof setInterval>
    private readonly configuredHostname?: string
    private readonly validateToken?: (token: string) => Promise<boolean>
    private readonly cipher: TokenCipher
    private readonly trustedRedirectHosts: Set<string>
    private readonly getClientIp?: (req: IncomingMessage) => string
    private readonly accessTokenTtlMs: number
    private readonly refreshTokenTtlMs: number
    private readonly looksLikeAccountToken?: (token: string) => Promise<boolean>

    constructor(options?: OAuthProviderOptions) {
        this.configuredHostname = options?.hostname
        this.validateToken = options?.validateToken
        this.getClientIp = options?.getClientIp
        this.accessTokenTtlMs = options?.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS
        // A refresh token that outlives its access token is the whole point, so
        // never let a long access lifetime silently invert the relationship.
        this.refreshTokenTtlMs = Math.max(MIN_REFRESH_TOKEN_TTL_MS, this.accessTokenTtlMs)
        this.looksLikeAccountToken = options?.looksLikeAccountToken
        this.trustedRedirectHosts = new Set(
            (options?.trustedRedirectHosts ?? DEFAULT_TRUSTED_REDIRECT_HOSTS)
                .map((host) => host.trim().toLowerCase())
                .filter(Boolean),
        )
        // Without a configured secret, fall back to an ephemeral one. Tokens then
        // stop working after a restart, which is acceptable for dev/test but not
        // for production — startHttpServer refuses to boot managed mode without it.
        this.cipher = new TokenCipher(options?.secret || randomBytes(32).toString('hex'))
        this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref()
        }
    }

    private clientIp(req: IncomingMessage): string {
        return this.getClientIp?.(req) ?? 'unknown'
    }

    /**
     * May this callback be used at all?
     *
     * Rejects only destinations that can never be safe: schemes that execute or
     * read local content, and plaintext http to a remote host. An unknown https
     * host is permitted — it meets the acknowledgement instead (see below).
     */
    isPermittedRedirectUri(raw: string): boolean {
        const url = parseRedirectUri(raw)
        if (!url) return false

        const scheme = url.protocol.replace(/:$/, '').toLowerCase()
        if (FORBIDDEN_SCHEMES.has(scheme)) return false
        if (scheme === 'http') return isLoopback(url)
        if (scheme === 'https') return true

        // Private-use / app scheme (RFC 8252 §7.1): the code is handed to a
        // locally installed application, never transmitted to a remote host.
        return /^[a-z][a-z0-9+.-]*$/.test(scheme)
    }

    /**
     * May this callback receive an authorization code without further friction?
     *
     * The question is not whether we recognise the client — with open dynamic
     * registration an attacker registers honestly — but whether the code would
     * leave the user's machine:
     *
     *   loopback              stays on the user's own machine
     *   private-use scheme    goes to a locally installed app
     *   https + curated host  a known hosted client (ChatGPT, Claude, ...)
     *
     * Everything else is still allowed, but only after the user has explicitly
     * acknowledged where their token is about to be sent. Curation therefore
     * removes friction; it is not a gate, and an empty list breaks nothing.
     */
    isTrustedRedirectUri(raw: string): boolean {
        if (!this.isPermittedRedirectUri(raw)) return false
        const url = parseRedirectUri(raw)!

        const scheme = url.protocol.replace(/:$/, '').toLowerCase()
        if (scheme !== 'https') return true
        if (isLoopback(url)) return true
        if (this.trustedRedirectHosts.has('*')) return true
        return this.trustedRedirectHosts.has(url.hostname.toLowerCase())
    }

    /**
     * Resolves one of our own access tokens back to the SeaTable API token it seals.
     * Returns undefined for anything we did not issue, or that has expired.
     */
    resolveAccessToken(accessToken: string): string | undefined {
        const payload = this.cipher.open<{ t: string }>('access', accessToken)
        return typeof payload?.t === 'string' ? payload.t : undefined
    }

    /**
     * Derive the base URL from SEATABLE_MCP_HOSTNAME or the incoming Host header.
     */
    private resolveBaseUrl(req: IncomingMessage): string {
        if (this.configuredHostname) {
            return `https://${this.configuredHostname}`
        }
        const host = req.headers.host ?? 'localhost'
        const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
        return `${proto}://${host}`
    }

    /**
     * GET /.well-known/oauth-authorization-server — RFC 8414 metadata
     */
    handleMetadata(req: IncomingMessage, res: ServerResponse): void {
        const baseUrl = this.resolveBaseUrl(req)
        const metadata = {
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            // S256 only — 'plain' offers no protection against a stolen code.
            code_challenge_methods_supported: ['S256'],
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
    }

    /**
     * POST /register — Dynamic Client Registration (RFC 7591)
     *
     * The returned client_id is a sealed envelope containing the client's name and
     * its redirect_uris. That makes the registration tamper-proof and verifiable at
     * /authorize without any server-side storage: a client_id we did not issue
     * cannot be opened, and the callback list inside it cannot be edited.
     */
    async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
            return
        }

        const body = await this.parseBody(req)
        const clientName = (body.get('client_name') ?? 'mcp-client').slice(0, 200)
        const redirectUris = this.parseRedirectUris(body.get('redirect_uris'))

        if (redirectUris.length === 0) {
            this.registrationError(res, 'invalid_redirect_uri', 'At least one redirect_uri is required')
            return
        }

        const rejected = redirectUris.filter((uri) => !this.isPermittedRedirectUri(uri))
        if (rejected.length > 0) {
            logger.warn({ clientName, count: rejected.length }, 'OAuth registration rejected: callback not permitted')
            this.registrationError(
                res,
                'invalid_redirect_uri',
                'A callback must use https, a private-use application scheme, or http on a loopback address.',
            )
            return
        }

        const registration: ClientRegistration = { n: clientName, r: redirectUris }
        const clientId = this.cipher.seal('client', registration, CLIENT_TTL_MS)

        // The registered callbacks are what /authorize later checks against, so a
        // rejected authorization is only explainable if they were recorded here.
        // Both fields come from an unauthenticated caller: cap count and length.
        logger.info(
            {
                clientName,
                callbacks: redirectUris.slice(0, 5).map((uri) => uri.slice(0, 120)),
                ip: this.clientIp(req),
            },
            'OAuth dynamic client registration',
        )

        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
            client_id: clientId,
            client_name: clientName,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_id_issued_at: Math.floor(Date.now() / 1000),
        }))
    }

    /**
     * GET /authorize — renders the authorization form
     * POST /authorize — processes the form submission
     *
     * Both paths validate the request the same way, and neither shows the token
     * prompt until the client, the callback and the PKCE challenge all check out.
     */
    async handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
            return
        }

        const form = req.method === 'POST' ? await this.parseFormBody(req) : new Map<string, string>()
        const pick = (key: string) => form.get(key) ?? url.searchParams.get(key) ?? ''

        const clientId = pick('client_id')
        const redirectUri = pick('redirect_uri')
        const state = pick('state')
        const responseType = pick('response_type')
        const codeChallenge = pick('code_challenge')
        const codeChallengeMethod = pick('code_challenge_method')

        const client = clientId ? this.cipher.open<ClientRegistration>('client', clientId) : undefined
        if (!client) {
            logger.warn('OAuth authorize rejected: unknown or expired client registration')
            this.authorizeError(res, 'Unknown client', 'This application is not registered with SeaTable MCP, or its registration has expired. Nothing has been sent to it.')
            return
        }

        if (responseType !== 'code') {
            this.authorizeError(res, 'Unsupported request', 'Only the authorization code flow is supported.')
            return
        }

        if (redirectUri && !this.isPermittedRedirectUri(redirectUri)) {
            logger.warn({ clientName: client.n, callback: safeCallback(redirectUri), ip: this.clientIp(req) }, 'OAuth authorize rejected: callback not permitted')
            this.authorizeError(res, 'Callback not permitted', 'SeaTable does not deliver authorizations to this kind of address. Nothing has been sent.')
            return
        }

        if (!redirectUri || !client.r.some((registered) => redirectUriMatches(registered, redirectUri))) {
            logger.warn(
                { clientName: client.n, callback: safeCallback(redirectUri), ip: this.clientIp(req) },
                'OAuth authorize rejected: redirect_uri not registered',
            )
            this.authorizeError(res, 'Unregistered callback address', 'This application asked SeaTable to send your authorization to an address it never registered. This is what a phishing attempt looks like — nothing has been sent.')
            return
        }

        if (!codeChallenge || codeChallengeMethod !== 'S256') {
            logger.warn({ clientName: client.n, ip: this.clientIp(req) }, 'OAuth authorize rejected: missing or downgraded PKCE')
            this.authorizeError(res, 'Insecure request', 'This application did not provide a valid PKCE challenge (S256 is required).')
            return
        }

        const callbackOrigin = new URL(redirectUri).origin
        const pageOpts = { client, clientId, redirectUri, callbackOrigin, state, responseType, codeChallenge, codeChallengeMethod }

        /*
         * An unfamiliar remote destination must be acknowledged before the token
         * field appears. The attacker writes the entry link, so the acknowledgement
         * is read from our own form body only — never from the query string — and
         * a POST auto-submitted by a foreign page is refused via Sec-Fetch-Site.
         */
        const needsAcknowledgement = !this.isTrustedRedirectUri(redirectUri)
        const acknowledged = needsAcknowledgement
            ? form.get('acknowledged') === 'yes' && req.headers['sec-fetch-site'] === 'same-origin'
            : true

        if (!acknowledged) {
            if (req.method === 'POST') {
                logger.warn({ clientName: client.n, callback: safeCallback(redirectUri), ip: this.clientIp(req) }, 'OAuth authorize: unacknowledged destination')
            }
            // 200 on first view, 400 when a submission tried to skip the step.
            res.writeHead(req.method === 'POST' ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(this.renderAcknowledgementPage(pageOpts))
            return
        }

        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(this.renderAuthorizePage({ ...pageOpts, acknowledged: needsAcknowledgement }))
            return
        }

        // POST that passed the acknowledgement: the token itself is the payload.
        const apiToken = (form.get('api_token') ?? '').trim()
        const renderWithError = (message: string) => {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
            res.end(this.renderAuthorizePage({ ...pageOpts, acknowledged: needsAcknowledgement, error: message }))
        }

        if (!apiToken) {
            // Coming straight from the acknowledgement page there is nothing to
            // complain about yet — this is the first sight of the token field.
            if (!form.has('api_token')) {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                res.end(this.renderAuthorizePage({ ...pageOpts, acknowledged: needsAcknowledgement }))
                return
            }
            renderWithError('Please enter your API token.')
            return
        }

        if (this.validateToken && !(await this.validateToken(apiToken))) {
            // Half of all real rejections are the wrong *kind* of token, not a
            // wrong token. Say which, instead of leaving the user guessing.
            const isAccountToken = this.looksLikeAccountToken
                ? await this.looksLikeAccountToken(apiToken).catch(() => false)
                : false
            logger.warn(
                { ip: this.clientIp(req), clientName: client.n, kind: isAccountToken ? 'account_token' : 'unknown' },
                'OAuth authorization rejected: invalid API token',
            )
            renderWithError(
                isAccountToken
                    ? 'That is an account API token. This connection needs a base API token: open the base, then Advanced \u2192 API Tokens \u2192 Add API Token.'
                    : 'Invalid API token. Please check your token and try again.',
            )
            return
        }

        const code = randomBytes(32).toString('hex')
        this.codes.set(code, {
            apiToken,
            clientId,
            redirectUri,
            codeChallenge,
            expiresAt: Date.now() + CODE_TTL_MS,
        })

        logger.info(
            { flow: flowId(code), clientName: client.n, callback: safeCallback(redirectUri), ip: this.clientIp(req) },
            'OAuth authorization code issued',
        )

        const redirect = new URL(redirectUri)
        redirect.searchParams.set('code', code)
        if (state) {
            redirect.searchParams.set('state', state)
        }

        res.writeHead(302, { location: redirect.toString() })
        res.end()
    }

    /**
     * POST /token — exchanges an authorization code (or refresh token) for an access token.
     *
     * The issued access token is a sealed envelope around the SeaTable API token,
     * never the API token itself.
     */
    async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
            return
        }

        const body = await this.parseFormBody(req)
        const grantType = body.get('grant_type')

        if (grantType === 'refresh_token') {
            this.handleRefreshGrant(body, res)
            return
        }

        if (grantType !== 'authorization_code') {
            logger.warn({ grantType: String(grantType ?? '(none)').slice(0, 40) }, 'OAuth token exchange rejected: unsupported grant_type')
            this.tokenError(res, 'unsupported_grant_type')
            return
        }

        const code = body.get('code')
        const clientId = body.get('client_id')
        const redirectUri = body.get('redirect_uri')
        const codeVerifier = body.get('code_verifier')

        if (!code) {
            this.tokenError(res, 'invalid_request', 'Missing code')
            return
        }

        const stored = this.codes.get(code)
        // Single-use: consume the code before any further check, so a failed
        // attempt cannot be retried with different parameters.
        this.codes.delete(code)

        if (!stored) {
            logger.warn({ flow: flowId(code) }, 'OAuth token exchange with invalid/expired code')
            this.tokenError(res, 'invalid_grant', 'Invalid or expired authorization code')
            return
        }

        if (Date.now() > stored.expiresAt) {
            logger.warn({ flow: flowId(code) }, 'OAuth token exchange rejected: authorization code expired')
            this.tokenError(res, 'invalid_grant', 'Authorization code expired')
            return
        }

        // The code belongs to one client only.
        if (!clientId || !constantTimeEquals(clientId, stored.clientId)) {
            logger.warn({ flow: flowId(code) }, 'OAuth token exchange rejected: client_id does not match the code')
            this.tokenError(res, 'invalid_grant', 'client_id does not match the authorization code')
            return
        }

        // redirect_uri is required here, not optional — omitting it must not skip the check.
        if (!redirectUri || redirectUri !== stored.redirectUri) {
            logger.warn({ flow: flowId(code) }, 'OAuth token exchange rejected: redirect_uri missing or mismatched')
            this.tokenError(res, 'invalid_grant', 'redirect_uri mismatch')
            return
        }

        if (!codeVerifier) {
            logger.warn({ flow: flowId(code) }, 'OAuth token exchange rejected: missing code_verifier')
            this.tokenError(res, 'invalid_grant', 'Missing code_verifier')
            return
        }

        const expected = base64UrlEncode(createHash('sha256').update(codeVerifier).digest())
        if (!constantTimeEquals(expected, stored.codeChallenge)) {
            logger.warn({ flow: flowId(code) }, 'OAuth token exchange rejected: PKCE verification failed')
            this.tokenError(res, 'invalid_grant', 'PKCE verification failed')
            return
        }

        logger.info({ flow: flowId(code) }, 'OAuth token exchange successful')
        this.issueTokens(res, stored.apiToken, stored.clientId)
    }

    destroy(): void {
        clearInterval(this.cleanupInterval)
        this.codes.clear()
    }

    private handleRefreshGrant(body: Map<string, string>, res: ServerResponse): void {
        const refreshToken = body.get('refresh_token') ?? ''
        if (!refreshToken) {
            this.tokenError(res, 'invalid_request', 'Missing refresh_token')
            return
        }

        const payload = this.cipher.open<{ t: string; c: string }>('refresh', refreshToken)
        if (!payload || typeof payload.t !== 'string') {
            logger.warn('OAuth refresh rejected: unknown or expired refresh token')
            this.tokenError(res, 'invalid_grant', 'Invalid or expired refresh token')
            return
        }

        const clientId = body.get('client_id')
        if (clientId && !constantTimeEquals(clientId, payload.c)) {
            logger.warn('OAuth refresh rejected: client_id does not match the refresh token')
            this.tokenError(res, 'invalid_grant', 'client_id does not match the refresh token')
            return
        }

        // A silent refresh is the normal, healthy case -- and therefore the one
        // worth being able to see. Without this line there is no way to tell a
        // client that renews cleanly from one that re-prompts its user hourly.
        logger.info({ clientId: fingerprint(payload.c) }, 'OAuth access token refreshed')
        this.issueTokens(res, payload.t, payload.c)
    }

    private issueTokens(res: ServerResponse, apiToken: string, clientId: string): void {
        const accessToken = this.cipher.seal('access', { t: apiToken }, this.accessTokenTtlMs)
        const refreshToken = this.cipher.seal('refresh', { t: apiToken, c: clientId }, this.refreshTokenTtlMs)

        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: Math.floor(this.accessTokenTtlMs / 1000),
            refresh_token: refreshToken,
        }))
    }

    private tokenError(res: ServerResponse, error: string, description?: string): void {
        res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify(description ? { error, error_description: description } : { error }))
    }

    private registrationError(res: ServerResponse, error: string, description: string): void {
        res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error, error_description: description }))
    }

    private parseRedirectUris(raw: string | undefined): string[] {
        if (!raw) return []
        let value: unknown = raw
        if (raw.startsWith('[')) {
            try {
                value = JSON.parse(raw)
            } catch {
                return []
            }
        }
        const list = Array.isArray(value) ? value : [value]
        return list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 20)
    }

    private cleanup(): void {
        const now = Date.now()
        for (const [code, entry] of this.codes) {
            if (now >= entry.expiresAt) {
                this.codes.delete(code)
            }
        }
    }

    private async parseFormBody(req: IncomingMessage): Promise<Map<string, string>> {
        const raw = await this.readBody(req)
        const result = new Map<string, string>()
        const contentType = req.headers['content-type'] ?? ''

        if (contentType.includes('application/json')) {
            try {
                const json = JSON.parse(raw)
                for (const [key, value] of Object.entries(json)) {
                    if (typeof value === 'string') result.set(key, value)
                }
            } catch { /* ignore */ }
        } else {
            const params = new URLSearchParams(raw)
            for (const [key, value] of params) {
                result.set(key, value)
            }
        }

        return result
    }

    private async parseBody(req: IncomingMessage): Promise<Map<string, string>> {
        const raw = await this.readBody(req)
        const result = new Map<string, string>()
        try {
            const json = JSON.parse(raw)
            for (const [key, value] of Object.entries(json)) {
                result.set(key, typeof value === 'string' ? value : JSON.stringify(value))
            }
        } catch {
            const params = new URLSearchParams(raw)
            for (const [key, value] of params) {
                result.set(key, value)
            }
        }
        return result
    }

    private readBody(req: IncomingMessage): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            req.on('data', (chunk) => {
                const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
                size += buf.length
                if (size > 64 * 1024) {
                    req.destroy()
                    reject(new Error('Request body too large'))
                    return
                }
                chunks.push(buf)
            })
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
            req.on('error', reject)
        })
    }

    /** An error page that deliberately does not render the API token prompt. */
    private authorizeError(res: ServerResponse, heading: string, message: string): void {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SeaTable MCP — Authorization refused</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .card { background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); padding: 40px; max-width: 440px; width: 100%; }
        h1 { font-size: 1.3em; margin-bottom: 12px; color: #c00; }
        p { color: #555; line-height: 1.6; font-size: 0.95em; }
    </style>
</head>
<body>
    <div class="card">
        <h1>${this.escapeHtml(heading)}</h1>
        <p>${this.escapeHtml(message)}</p>
    </div>
</body>
</html>`)
    }

    private renderAcknowledgementPage(opts: AuthorizePageOptions): string {
        return this.page(`
        <h1>Where is this going?</h1>
        <p class="subtitle">Before you enter anything, check the destination.</p>
        <div class="destination">
            <span class="destination-label">Your API token will be sent to</span>
            <span class="destination-host">${this.escapeHtml(opts.callbackOrigin)}</span>
        </div>
        <div class="warning">
            SeaTable does not recognise this destination. That does not necessarily mean it is
            malicious — but it does mean we cannot vouch for it. Only continue if
            <strong>you</strong> started this connection yourself, from software you trust.
            If you arrived here from a link or a message, close this page.
        </div>
        <p class="claimed">The application calls itself
            &ldquo;${this.escapeHtml(opts.client.n)}&rdquo; &mdash; self-reported, not verified by SeaTable.</p>
        <form method="POST" action="/authorize">
            ${this.hiddenFlowFields(opts)}
            <input type="hidden" name="acknowledged" value="yes">
            <button type="submit">I started this connection</button>
        </form>
        <p class="hint">If you did not, simply close this page. Nothing has been sent yet.</p>`)
    }

    private renderAuthorizePage(opts: AuthorizePageOptions & { acknowledged?: boolean; error?: string }): string {
        const errorHtml = opts.error ? `<div class="error">${this.escapeHtml(opts.error)}</div>` : ''

        return this.page(`
        <h1>SeaTable MCP</h1>
        <p class="subtitle">An application is asking for access to your SeaTable base.</p>
        <div class="destination">
            <span class="destination-label">Your authorization will be sent to</span>
            <span class="destination-host">${this.escapeHtml(opts.callbackOrigin)}</span>
        </div>
        <p class="claimed">The application calls itself
            &ldquo;${this.escapeHtml(opts.client.n)}&rdquo; &mdash; self-reported, not verified by SeaTable.</p>
        ${errorHtml}
        <form method="POST" action="/authorize">
            ${this.hiddenFlowFields(opts)}
            ${opts.acknowledged ? '<input type="hidden" name="acknowledged" value="yes">' : ''}
            <label for="api_token">API Token</label>
            <input type="password" id="api_token" name="api_token" placeholder="Enter your SeaTable API token" required autofocus>
            <button type="submit">Authorize</button>
            <p class="hint">Use a base API token, not your account token. A read-only token keeps the permissions minimal.</p>
        </form>`)
    }

    private hiddenFlowFields(opts: AuthorizePageOptions): string {
        const field = (name: string, value: string) =>
            `<input type="hidden" name="${name}" value="${this.escapeHtml(value)}">`
        return [
            field('redirect_uri', opts.redirectUri),
            field('state', opts.state),
            field('client_id', opts.clientId),
            field('response_type', opts.responseType),
            field('code_challenge', opts.codeChallenge),
            field('code_challenge_method', opts.codeChallengeMethod),
        ].join('\n            ')
    }

    /** Shared chrome for every page this provider renders. */
    private page(body: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SeaTable MCP &mdash; Authorize</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .card { background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); padding: 40px; max-width: 460px; width: 100%; }
        h1 { font-size: 1.4em; margin-bottom: 8px; color: #333; }
        .subtitle { color: #666; margin-bottom: 20px; font-size: 0.95em; line-height: 1.5; }
        .destination { display: block; background: #f7f9fb; border: 1px solid #e3e8ee; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
        .destination-label { display: block; color: #789; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .destination-host { display: block; font-size: 1.05em; font-weight: 700; color: #1a2b3c; word-break: break-all; }
        .warning { background: #fff4e5; color: #8a4b00; border: 1px solid #ffcc80; padding: 12px 14px; border-radius: 6px; margin-bottom: 14px; font-size: 0.88em; line-height: 1.55; }
        .claimed { color: #888; font-size: 0.82em; line-height: 1.5; margin-bottom: 18px; }
        label { display: block; font-weight: 600; margin-bottom: 6px; color: #444; font-size: 0.9em; }
        input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 1em; margin-bottom: 20px; }
        input[type="password"]:focus { outline: none; border-color: #ff8c00; box-shadow: 0 0 0 3px rgba(255,140,0,0.15); }
        button { width: 100%; padding: 12px; background: #ff8c00; color: white; border: none; border-radius: 6px; font-size: 1em; font-weight: 600; cursor: pointer; }
        button:hover { background: #e07b00; }
        .error { background: #fee; color: #c00; padding: 10px 12px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9em; }
        .hint { margin-top: 16px; font-size: 0.8em; color: #999; line-height: 1.4; }
    </style>
</head>
<body>
    <div class="card">${body}
    </div>
</body>
</html>`
    }

    private escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }
}

/**
 * Correlation id for one authorization, derived from the code so that the
 * /authorize and /token log lines can be paired without ever writing the code
 * itself (or a prefix of it) to disk.
 */
/**
 * A callback as written to the log: the full destination, because for an
 * incident the question is where the code actually went, not just which host.
 * The value comes from an unauthenticated caller, so it is capped.
 */
function safeCallback(raw: string): string {
    return raw.slice(0, 200)
}

/** Short, non-reversible handle for a sealed value that is too long to log. */
function fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function flowId(code: string): string {
    return createHash('sha256').update(`flow:${code}`).digest('hex').slice(0, 12)
}

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

function constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8')
    const bufB = Buffer.from(b, 'utf-8')
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
}
