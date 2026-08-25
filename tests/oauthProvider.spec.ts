import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'

let server: Server
let port: number
let provider: OAuthProvider

const SECRET = 'oauth-provider-spec-secret-value-long-enough'
const CB = 'https://client.example/cb'

function startTestServer(): Promise<void> {
    // This spec covers the flow and its bindings; callback curation has its own spec.
    provider = new OAuthProvider({ secret: SECRET, trustedRedirectHosts: ['client.example'] })
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

function pkcePair() {
    const verifier = base64UrlEncode(randomBytes(32))
    return { verifier, challenge: base64UrlEncode(createHash('sha256').update(verifier).digest()) }
}

async function registerClient(redirectUris: string[] = [CB], clientName = 'Test Client'): Promise<string> {
    const res = await fetch(base('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }),
    })
    expect(res.status).toBe(201)
    return (await res.json()).client_id as string
}

/** Runs a valid authorization and returns the issued code. */
async function getCode(opts: { clientId: string; challenge: string; apiToken: string; redirectUri?: string; state?: string }) {
    const res = await fetch(base('/authorize'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            api_token: opts.apiToken,
            client_id: opts.clientId,
            redirect_uri: opts.redirectUri ?? CB,
            response_type: 'code',
            code_challenge: opts.challenge,
            code_challenge_method: 'S256',
            ...(opts.state ? { state: opts.state } : {}),
        }).toString(),
        redirect: 'manual',
    })
    return res
}

function exchange(params: Record<string, string>) {
    return fetch(base('/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    })
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
            expect(data.issuer).toBeTruthy()
            expect(data.authorization_endpoint).toContain('/authorize')
            expect(data.token_endpoint).toContain('/token')
            expect(data.registration_endpoint).toContain('/register')
            expect(data.response_types_supported).toEqual(['code'])
            expect(data.grant_types_supported).toContain('authorization_code')
        })

        it('advertises S256 only — plain PKCE is not offered', async () => {
            const data = await (await fetch(base('/.well-known/oauth-authorization-server'))).json()
            expect(data.code_challenge_methods_supported).toEqual(['S256'])
        })
    })

    describe('dynamic client registration', () => {
        it('POST /register returns a client_id and echoes the registration', async () => {
            const res = await fetch(base('/register'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ client_name: 'my-client', redirect_uris: [CB] }),
            })
            expect(res.status).toBe(201)
            const data = await res.json()
            expect(data.client_id).toBeTruthy()
            expect(data.client_name).toBe('my-client')
            expect(data.redirect_uris).toEqual([CB])
            expect(data.token_endpoint_auth_method).toBe('none')
        })
    })

    describe('authorize', () => {
        it('GET /authorize renders HTML form for a registered client', async () => {
            const clientId = await registerClient()
            const { challenge } = pkcePair()
            const res = await fetch(base(
                `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${challenge}&code_challenge_method=S256`,
            ))
            expect(res.status).toBe(200)
            expect(res.headers.get('content-type')).toContain('text/html')
            const html = await res.text()
            expect(html).toContain('name="api_token"')
            expect(html).toContain('SeaTable MCP')
        })

        it('POST /authorize without token returns error', async () => {
            const clientId = await registerClient()
            const { challenge } = pkcePair()
            const res = await fetch(base('/authorize'), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    api_token: '',
                    client_id: clientId,
                    redirect_uri: CB,
                    response_type: 'code',
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                }).toString(),
                redirect: 'manual',
            })
            expect(res.status).toBe(400)
            expect(await res.text()).toContain('Please enter your API token')
        })

        it('POST /authorize redirects to the registered callback with a code', async () => {
            const clientId = await registerClient()
            const { challenge } = pkcePair()
            const res = await getCode({ clientId, challenge, apiToken: 'my-secret-token', state: 'xyz' })
            expect(res.status).toBe(302)
            const location = res.headers.get('location')!
            expect(location).toContain(CB)
            expect(location).toContain('code=')
            expect(location).toContain('state=xyz')
        })
    })

    describe('token exchange', () => {
        it('full OAuth flow: register -> authorize -> token exchange', async () => {
            const clientId = await registerClient()
            const { challenge, verifier } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'test-api-token-123', state: 's1' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!
            expect(code).toBeTruthy()

            const tokenRes = await exchange({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: CB,
                code_verifier: verifier,
            })
            expect(tokenRes.status).toBe(200)
            const tokenData = await tokenRes.json()
            expect(tokenData.token_type).toBe('Bearer')
            expect(tokenData.expires_in).toBeGreaterThan(0)
            // The API token is sealed inside the access token, never handed out as-is.
            expect(tokenData.access_token).not.toBe('test-api-token-123')
            expect(provider.resolveAccessToken(tokenData.access_token)).toBe('test-api-token-123')
        })

        it('code is single-use', async () => {
            const clientId = await registerClient()
            const { challenge, verifier } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'single-use-token' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!

            const params = {
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: CB,
                code_verifier: verifier,
            }
            expect((await exchange(params)).status).toBe(200)

            const res2 = await exchange(params)
            expect(res2.status).toBe(400)
            expect((await res2.json()).error).toBe('invalid_grant')
        })

        it('invalid code returns error', async () => {
            const res = await exchange({ grant_type: 'authorization_code', code: 'bogus-code' })
            expect(res.status).toBe(400)
            expect((await res.json()).error).toBe('invalid_grant')
        })

        it('unsupported grant_type returns error', async () => {
            const res = await exchange({ grant_type: 'client_credentials' })
            expect(res.status).toBe(400)
            expect((await res.json()).error).toBe('unsupported_grant_type')
        })

        it('refresh_token grant issues a fresh access token for the same base', async () => {
            const clientId = await registerClient()
            const { challenge, verifier } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'refreshable-token' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!
            const first = await (await exchange({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: CB,
                code_verifier: verifier,
            })).json()

            const res = await exchange({
                grant_type: 'refresh_token',
                refresh_token: first.refresh_token,
                client_id: clientId,
            })
            expect(res.status).toBe(200)
            const data = await res.json()
            expect(data.token_type).toBe('Bearer')
            expect(provider.resolveAccessToken(data.access_token)).toBe('refreshable-token')
        })

        it('redirect_uri mismatch returns error', async () => {
            const clientId = await registerClient()
            const { challenge, verifier } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'mismatch-token' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!

            const res = await exchange({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: 'https://other.example/cb',
                code_verifier: verifier,
            })
            expect(res.status).toBe(400)
            const data = await res.json()
            expect(data.error).toBe('invalid_grant')
            expect(data.error_description).toContain('redirect_uri')
        })
    })

    describe('PKCE', () => {
        it('S256 PKCE flow succeeds with correct verifier', async () => {
            const clientId = await registerClient()
            const { challenge, verifier } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'pkce-token' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!

            const tokenRes = await exchange({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: CB,
                code_verifier: verifier,
            })
            expect(tokenRes.status).toBe(200)
            expect(provider.resolveAccessToken((await tokenRes.json()).access_token)).toBe('pkce-token')
        })

        it('S256 PKCE flow fails with wrong verifier', async () => {
            const clientId = await registerClient()
            const { challenge } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'pkce-token' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!

            const tokenRes = await exchange({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: CB,
                code_verifier: 'wrong-verifier',
            })
            expect(tokenRes.status).toBe(400)
            const data = await tokenRes.json()
            expect(data.error).toBe('invalid_grant')
            expect(data.error_description).toContain('PKCE')
        })

        it('PKCE fails when the verifier is missing', async () => {
            const clientId = await registerClient()
            const { challenge } = pkcePair()
            const authorizeRes = await getCode({ clientId, challenge, apiToken: 'pkce-token' })
            const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!

            const tokenRes = await exchange({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                redirect_uri: CB,
            })
            expect(tokenRes.status).toBe(400)
            expect((await tokenRes.json()).error_description).toContain('code_verifier')
        })
    })
})
