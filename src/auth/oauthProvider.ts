import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { logger } from '../logger.js'

interface AuthorizationCode {
    apiToken: string
    redirectUri: string
    expiresAt: number
}

const CODE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000

export class OAuthProvider {
    private readonly codes = new Map<string, AuthorizationCode>()
    private readonly cleanupInterval: ReturnType<typeof setInterval>

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref()
        }
    }

    /**
     * GET /oauth/authorize — renders the authorization form
     * POST /oauth/authorize — processes the form submission
     */
    async handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const clientId = url.searchParams.get('client_id') ?? ''
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const responseType = url.searchParams.get('response_type') ?? ''

        if (req.method === 'GET') {
            // Render the authorization form
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(this.renderAuthorizePage(clientId, redirectUri, state, responseType))
            return
        }

        if (req.method === 'POST') {
            const body = await this.parseFormBody(req)
            const apiToken = body.get('api_token') ?? ''
            const formRedirectUri = body.get('redirect_uri') ?? redirectUri
            const formState = body.get('state') ?? state

            if (!apiToken) {
                res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
                res.end(this.renderAuthorizePage(clientId, formRedirectUri, formState, responseType, 'Please enter your API token.'))
                return
            }

            if (!formRedirectUri) {
                res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing redirect_uri')
                return
            }

            // Generate authorization code and store with the API token
            const code = randomBytes(32).toString('hex')
            this.codes.set(code, {
                apiToken,
                redirectUri: formRedirectUri,
                expiresAt: Date.now() + CODE_TTL_MS,
            })

            logger.info('OAuth authorization code issued')

            // Redirect back to the client with the code
            const redirect = new URL(formRedirectUri)
            redirect.searchParams.set('code', code)
            if (formState) {
                redirect.searchParams.set('state', formState)
            }

            res.writeHead(302, { location: redirect.toString() })
            res.end()
            return
        }

        res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
    }

    /**
     * POST /oauth/token — exchanges authorization code for access token
     */
    async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
            return
        }

        const body = await this.parseFormBody(req)
        const grantType = body.get('grant_type')
        const code = body.get('code')
        const redirectUri = body.get('redirect_uri')

        // Support both authorization_code and refresh_token grant types
        if (grantType === 'refresh_token') {
            const refreshToken = body.get('refresh_token') ?? ''
            // The refresh token IS the API token — just return it again
            if (!refreshToken) {
                res.writeHead(400, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ error: 'invalid_request', error_description: 'Missing refresh_token' }))
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
                access_token: refreshToken,
                token_type: 'Bearer',
                refresh_token: refreshToken,
            }))
            return
        }

        if (grantType !== 'authorization_code') {
            res.writeHead(400, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'unsupported_grant_type' }))
            return
        }

        if (!code) {
            res.writeHead(400, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'invalid_request', error_description: 'Missing code' }))
            return
        }

        const stored = this.codes.get(code)
        if (!stored) {
            logger.warn('OAuth token exchange with invalid/expired code')
            res.writeHead(400, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }))
            return
        }

        // Single-use: delete immediately
        this.codes.delete(code)

        // Check expiry
        if (Date.now() > stored.expiresAt) {
            res.writeHead(400, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'invalid_grant', error_description: 'Authorization code expired' }))
            return
        }

        // Validate redirect_uri matches
        if (redirectUri && redirectUri !== stored.redirectUri) {
            res.writeHead(400, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }))
            return
        }

        logger.info('OAuth token exchange successful')

        // Return the API token as the OAuth access token
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
            access_token: stored.apiToken,
            token_type: 'Bearer',
            // Include refresh_token so clients can refresh without re-auth
            refresh_token: stored.apiToken,
        }))
    }

    destroy(): void {
        clearInterval(this.cleanupInterval)
        this.codes.clear()
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
        const raw = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
            req.on('error', reject)
        })

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
            // application/x-www-form-urlencoded
            const params = new URLSearchParams(raw)
            for (const [key, value] of params) {
                result.set(key, value)
            }
        }

        return result
    }

    private renderAuthorizePage(clientId: string, redirectUri: string, state: string, responseType: string, error?: string): string {
        const errorHtml = error ? `<div class="error">${this.escapeHtml(error)}</div>` : ''

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SeaTable MCP — Authorize</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f5f5f5;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }
        .card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.1);
            padding: 40px;
            max-width: 440px;
            width: 100%;
        }
        h1 { font-size: 1.4em; margin-bottom: 8px; color: #333; }
        .subtitle { color: #666; margin-bottom: 24px; font-size: 0.95em; line-height: 1.5; }
        label { display: block; font-weight: 600; margin-bottom: 6px; color: #444; font-size: 0.9em; }
        input[type="password"] {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 1em;
            margin-bottom: 20px;
        }
        input[type="password"]:focus { outline: none; border-color: #ff8c00; box-shadow: 0 0 0 3px rgba(255,140,0,0.15); }
        button {
            width: 100%;
            padding: 12px;
            background: #ff8c00;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 1em;
            font-weight: 600;
            cursor: pointer;
        }
        button:hover { background: #e07b00; }
        .error { background: #fee; color: #c00; padding: 10px 12px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9em; }
        .hint { margin-top: 16px; font-size: 0.8em; color: #999; line-height: 1.4; }
    </style>
</head>
<body>
    <div class="card">
        <h1>SeaTable MCP</h1>
        <p class="subtitle">Enter your SeaTable API token to authorize access to your base.</p>
        ${errorHtml}
        <form method="POST" action="/oauth/authorize">
            <input type="hidden" name="redirect_uri" value="${this.escapeHtml(redirectUri)}">
            <input type="hidden" name="state" value="${this.escapeHtml(state)}">
            <input type="hidden" name="client_id" value="${this.escapeHtml(clientId)}">
            <input type="hidden" name="response_type" value="${this.escapeHtml(responseType)}">
            <label for="api_token">API Token</label>
            <input type="password" id="api_token" name="api_token" placeholder="Enter your SeaTable API token" required autofocus>
            <button type="submit">Authorize</button>
            <p class="hint">Your API token will be used as your access credential. Use a read-only token for minimal permissions.</p>
        </form>
    </div>
</body>
</html>`
    }

    private escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }
}
