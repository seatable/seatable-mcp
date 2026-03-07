import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'

let server: Server
let port: number
let provider: OAuthProvider

function startTestServer(): Promise<void> {
    provider = new OAuthProvider('http://localhost:0')
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, `http://localhost`)
        if (url.pathname === '/.well-known/oauth-authorization-server') {
            provider.handleMetadata(req, res)
        } else if (url.pathname === '/authorize') {
            await provider.handleAuthorize(req, res, url)
        } else if (url.pathname === '/token') {
            await provider.handleToken(req, res)
        } else if (url.pathname === '/register') {
            await provider.handleRegister(req, res)
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

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

describe('OAuthProvider', () => {
    beforeAll(async () => {
        await startTestServer()
    })

    afterAll(() => {
        provider.destroy()
        server.close()
    })

    describe('metadata discovery', () => {
        it('GET /.well-known/oauth-authorization-server returns metadata', async () => {
            const res = await fetch(base('/.well-known/oauth-authorization-server'))
            expect(res.status).toBe(200)
            const data = await res.json()
            expect(data.authorization_endpoint).toContain('/authorize')
            expect(data.token_endpoint).toContain('/token')
            expect(data.registration_endpoint).toContain('/register')
            expect(data.response_types_supported).toContain('code')
            expect(data.grant_types_supported).toContain('authorization_code')
            expect(data.grant_types_supported).toContain('refresh_token')
            expect(data.code_challenge_methods_supported).toContain('S256')
        })
    })

    describe('dynamic client registration', () => {
        it('POST /register returns a client_id', async () => {
            const res = await fetch(base('/register'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ client_name: 'test-client', redirect_uris: ['http://example.com/cb'] }),
            })
            expect(res.status).toBe(201)
            const data = await res.json()
            expect(data.client_id).toBeTruthy()
            expect(data.client_name).toBe('test-client')
        })
    })

    describe('authorize', () => {
        it('GET /authorize renders HTML form', async () => {
            const res = await fetch(base('/authorize?client_id=test&redirect_uri=http://example.com/cb&state=abc123'))
            expect(res.status).toBe(200)
            expect(res.headers.get('content-type')).toContain('text/html')
            const html = await res.text()
            expect(html).toContain('SeaTable MCP')
            expect(html).toContain('api_token')
            expect(html).toContain('abc123')
        })

        it('POST /authorize without token returns error', async () => {
            const res = await fetch(base('/authorize?redirect_uri=http://example.com/cb&state=xyz'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'api_token=',
                redirect: 'manual',
            })
            expect(res.status).toBe(400)
            const html = await res.text()
            expect(html).toContain('Please enter your API token')
        })

        it('POST /authorize redirects with code', async () => {
            const res = await fetch(base('/authorize'), {
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
    })

    describe('token exchange', () => {
        it('full OAuth flow: authorize -> token exchange', async () => {
            const authorizeRes = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'api_token=test-api-token-123&redirect_uri=http://example.com/cb&state=s1',
                redirect: 'manual',
            })
            const location = new URL(authorizeRes.headers.get('location')!)
            const code = location.searchParams.get('code')!
            expect(code).toBeTruthy()

            const tokenRes = await fetch(base('/token'), {
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
            const authorizeRes = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'api_token=single-use-token&redirect_uri=http://example.com/cb',
                redirect: 'manual',
            })
            const location = new URL(authorizeRes.headers.get('location')!)
            const code = location.searchParams.get('code')!

            const res1 = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `grant_type=authorization_code&code=${code}`,
            })
            expect(res1.status).toBe(200)

            const res2 = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `grant_type=authorization_code&code=${code}`,
            })
            expect(res2.status).toBe(400)
            const err = await res2.json()
            expect(err.error).toBe('invalid_grant')
        })

        it('invalid code returns error', async () => {
            const res = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=authorization_code&code=bogus-code',
            })
            expect(res.status).toBe(400)
            const data = await res.json()
            expect(data.error).toBe('invalid_grant')
        })

        it('unsupported grant_type returns error', async () => {
            const res = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=client_credentials',
            })
            expect(res.status).toBe(400)
            const data = await res.json()
            expect(data.error).toBe('unsupported_grant_type')
        })

        it('refresh_token grant returns same token', async () => {
            const res = await fetch(base('/token'), {
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
            const authorizeRes = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'api_token=mismatch-token&redirect_uri=http://example.com/cb',
                redirect: 'manual',
            })
            const location = new URL(authorizeRes.headers.get('location')!)
            const code = location.searchParams.get('code')!

            const res = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `grant_type=authorization_code&code=${code}&redirect_uri=http://other.com/cb`,
            })
            expect(res.status).toBe(400)
            const data = await res.json()
            expect(data.error).toBe('invalid_grant')
            expect(data.error_description).toContain('redirect_uri')
        })
    })

    describe('PKCE', () => {
        it('S256 PKCE flow succeeds with correct verifier', async () => {
            const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
            const codeChallenge = base64UrlEncode(
                createHash('sha256').update(codeVerifier).digest()
            )

            const authorizeRes = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `api_token=pkce-token&redirect_uri=http://example.com/cb&code_challenge=${codeChallenge}&code_challenge_method=S256`,
                redirect: 'manual',
            })
            const location = new URL(authorizeRes.headers.get('location')!)
            const code = location.searchParams.get('code')!

            const tokenRes = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `grant_type=authorization_code&code=${code}&code_verifier=${codeVerifier}`,
            })
            expect(tokenRes.status).toBe(200)
            const data = await tokenRes.json()
            expect(data.access_token).toBe('pkce-token')
        })

        it('S256 PKCE flow fails with wrong verifier', async () => {
            const codeChallenge = base64UrlEncode(
                createHash('sha256').update('correct-verifier').digest()
            )

            const authorizeRes = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `api_token=pkce-token&redirect_uri=http://example.com/cb&code_challenge=${codeChallenge}&code_challenge_method=S256`,
                redirect: 'manual',
            })
            const location = new URL(authorizeRes.headers.get('location')!)
            const code = location.searchParams.get('code')!

            const tokenRes = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `grant_type=authorization_code&code=${code}&code_verifier=wrong-verifier`,
            })
            expect(tokenRes.status).toBe(400)
            const data = await tokenRes.json()
            expect(data.error).toBe('invalid_grant')
            expect(data.error_description).toContain('PKCE')
        })

        it('PKCE fails when verifier is missing but challenge was sent', async () => {
            const codeChallenge = base64UrlEncode(
                createHash('sha256').update('some-verifier').digest()
            )

            const authorizeRes = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `api_token=pkce-token&redirect_uri=http://example.com/cb&code_challenge=${codeChallenge}&code_challenge_method=S256`,
                redirect: 'manual',
            })
            const location = new URL(authorizeRes.headers.get('location')!)
            const code = location.searchParams.get('code')!

            const tokenRes = await fetch(base('/token'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `grant_type=authorization_code&code=${code}`,
            })
            expect(tokenRes.status).toBe(400)
            const data = await tokenRes.json()
            expect(data.error).toBe('invalid_request')
            expect(data.error_description).toContain('code_verifier')
        })
    })
})
