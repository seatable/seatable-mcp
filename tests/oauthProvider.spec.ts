import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'

let server: Server
let port: number
let provider: OAuthProvider

function startTestServer(): Promise<void> {
    provider = new OAuthProvider()
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, `http://localhost`)
        if (url.pathname === '/oauth/authorize') {
            await provider.handleAuthorize(req, res, url)
        } else if (url.pathname === '/oauth/token') {
            await provider.handleToken(req, res)
        } else {
            res.writeHead(404).end()
        }
    })
    return new Promise((resolve) => {
        server.listen(0, () => {
            port = (server.address() as any).port
            resolve()
        })
    })
}

function base(path: string) {
    return `http://localhost:${port}${path}`
}

describe('OAuthProvider', () => {
    beforeAll(async () => {
        await startTestServer()
    })

    afterAll(() => {
        provider.destroy()
        server.close()
    })

    it('GET /oauth/authorize renders HTML form', async () => {
        const res = await fetch(base('/oauth/authorize?client_id=test&redirect_uri=http://example.com/cb&state=abc123'))
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        expect(html).toContain('SeaTable MCP')
        expect(html).toContain('api_token')
        expect(html).toContain('abc123') // state preserved
    })

    it('POST /oauth/authorize without token returns error', async () => {
        const res = await fetch(base('/oauth/authorize?redirect_uri=http://example.com/cb&state=xyz'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'api_token=',
            redirect: 'manual',
        })
        expect(res.status).toBe(400)
        const html = await res.text()
        expect(html).toContain('Please enter your API token')
    })

    it('POST /oauth/authorize redirects with code', async () => {
        const res = await fetch(base('/oauth/authorize'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'api_token=my-secret-token&redirect_uri=http://example.com/cb&state=xyz',
            redirect: 'manual',
        })
        expect(res.status).toBe(302)
        const location = res.headers.get('location')!
        expect(location).toContain('http://example.com/cb')
        expect(location).toContain('code=')
        expect(location).toContain('state=xyz')
    })

    it('full OAuth flow: authorize → token exchange', async () => {
        // Step 1: POST authorize to get a code
        const authorizeRes = await fetch(base('/oauth/authorize'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'api_token=test-api-token-123&redirect_uri=http://example.com/cb&state=s1',
            redirect: 'manual',
        })
        const location = new URL(authorizeRes.headers.get('location')!)
        const code = location.searchParams.get('code')!
        expect(code).toBeTruthy()

        // Step 2: Exchange code for token
        const tokenRes = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}&redirect_uri=http://example.com/cb`,
        })
        expect(tokenRes.status).toBe(200)
        const tokenData = await tokenRes.json()
        expect(tokenData.access_token).toBe('test-api-token-123')
        expect(tokenData.token_type).toBe('Bearer')
        expect(tokenData.refresh_token).toBe('test-api-token-123')
    })

    it('code is single-use', async () => {
        // Get a code
        const authorizeRes = await fetch(base('/oauth/authorize'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'api_token=single-use-token&redirect_uri=http://example.com/cb',
            redirect: 'manual',
        })
        const location = new URL(authorizeRes.headers.get('location')!)
        const code = location.searchParams.get('code')!

        // First exchange succeeds
        const res1 = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}`,
        })
        expect(res1.status).toBe(200)

        // Second exchange fails
        const res2 = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}`,
        })
        expect(res2.status).toBe(400)
        const err = await res2.json()
        expect(err.error).toBe('invalid_grant')
    })

    it('invalid code returns error', async () => {
        const res = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=authorization_code&code=bogus-code',
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toBe('invalid_grant')
    })

    it('unsupported grant_type returns error', async () => {
        const res = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials',
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toBe('unsupported_grant_type')
    })

    it('refresh_token grant returns same token', async () => {
        const res = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=refresh_token&refresh_token=my-api-token',
        })
        expect(res.status).toBe(200)
        const data = await res.json()
        expect(data.access_token).toBe('my-api-token')
        expect(data.token_type).toBe('Bearer')
    })

    it('redirect_uri mismatch returns error', async () => {
        // Get a code with specific redirect_uri
        const authorizeRes = await fetch(base('/oauth/authorize'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'api_token=mismatch-token&redirect_uri=http://example.com/cb',
            redirect: 'manual',
        })
        const location = new URL(authorizeRes.headers.get('location')!)
        const code = location.searchParams.get('code')!

        // Exchange with different redirect_uri
        const res = await fetch(base('/oauth/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}&redirect_uri=http://evil.com/cb`,
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toBe('invalid_grant')
        expect(data.error_description).toContain('redirect_uri')
    })
})
