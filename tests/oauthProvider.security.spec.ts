import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'

/**
 * Adversarial tests for the OAuth bridge.
 *
 * Every test here models what a *hostile* client does deliberately,
 * not what an honest client does by mistake. Derived from the
 * external security report against v1.5.2 (ST-02).
 */

const SECRET = 'oauth-security-spec-secret-value-long-enough'
const HONEST_CB = 'https://honest-client.example/callback'
const ATTACKER_CB = 'https://attacker.example.invalid/callback'

let server: Server
let port: number
let provider: OAuthProvider

function base(path: string) {
    return `http://localhost:${port}${path}`
}

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pkcePair() {
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    return { verifier, challenge }
}

async function registerClient(redirectUris: string[], clientName = 'Honest Client'): Promise<string> {
    const res = await fetch(base('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.client_id).toBeTruthy()
    return body.client_id as string
}

/** Drives a complete, well-behaved authorization and returns the code. */
async function authorize(opts: {
    clientId: string
    redirectUri: string
    challenge: string
    apiToken?: string
}): Promise<{ status: number; location: string | null; code: string | null }> {
    const body = new URLSearchParams({
        api_token: opts.apiToken ?? 'victim-seatable-api-token',
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        code_challenge: opts.challenge,
        code_challenge_method: 'S256',
        state: 'st',
    })
    const res = await fetch(base('/authorize'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'manual',
    })
    const location = res.headers.get('location')
    const code = location ? new URL(location).searchParams.get('code') : null
    return { status: res.status, location, code }
}

function exchange(params: Record<string, string>) {
    return fetch(base('/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    })
}

beforeAll(async () => {
    // Both hosts are trusted here on purpose: this spec proves the *bindings*
    // hold even when the attacker's callback is itself registerable.
    provider = new OAuthProvider({
        secret: SECRET,
        trustedRedirectHosts: ['honest-client.example', 'attacker.example.invalid'],
    })
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, 'http://localhost')
        if (url.pathname === '/authorize') await provider.handleAuthorize(req, res, url)
        else if (url.pathname === '/token') await provider.handleToken(req, res)
        else if (url.pathname === '/register') await provider.handleRegister(req, res)
        else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => {
        server.listen(0, () => {
            port = (server.address() as any).port
            resolve()
        })
    })
})

afterAll(async () => {
    provider.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('ST-02 / client and callback binding', () => {
    it('rejects an unregistered client_id before rendering the form', async () => {
        const res = await fetch(
            base(`/authorize?response_type=code&client_id=unknown-client-ZZ&redirect_uri=${encodeURIComponent(ATTACKER_CB)}`),
        )
        expect(res.status).toBe(400)
        const html = await res.text()
        // The token prompt must not be shown to the victim at all
        expect(html).not.toContain('name="api_token"')
    })

    it('rejects a registered client using a callback it never registered', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge } = pkcePair()
        const res = await fetch(
            base(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(ATTACKER_CB)}&code_challenge=${challenge}&code_challenge_method=S256`),
        )
        expect(res.status).toBe(400)
        const html = await res.text()
        expect(html).not.toContain('name="api_token"')
    })

    it('refuses to redirect to a foreign callback even if POSTed directly', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge } = pkcePair()
        const result = await authorize({ clientId, redirectUri: ATTACKER_CB, challenge })
        expect(result.status).toBe(400)
        expect(result.location).toBeNull()
    })

    it('shows the client name and callback origin on the consent screen', async () => {
        const clientId = await registerClient([HONEST_CB], 'Acme MCP Client')
        const { challenge } = pkcePair()
        const res = await fetch(
            base(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(HONEST_CB)}&code_challenge=${challenge}&code_challenge_method=S256`),
        )
        expect(res.status).toBe(200)
        const html = await res.text()
        expect(html).toContain('Acme MCP Client')
        expect(html).toContain('honest-client.example')
    })

    it('allows loopback redirects on a different port (RFC 8252)', async () => {
        const clientId = await registerClient(['http://127.0.0.1:1234/cb'], 'Desktop Client')
        const { challenge } = pkcePair()
        const res = await fetch(
            base(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:59876/cb')}&code_challenge=${challenge}&code_challenge_method=S256`),
        )
        expect(res.status).toBe(200)
    })
})

describe('ST-02 / registration rejects unusable callbacks', () => {
    it('rejects non-http(s) redirect schemes', async () => {
        for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
            const res = await fetch(base('/register'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ client_name: 'evil', redirect_uris: [uri] }),
            })
            expect(res.status).toBe(400)
        }
    })

    it('accepts an untrusted https host at registration — it meets the acknowledgement later', async () => {
        const res = await fetch(base('/register'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'stranger', redirect_uris: ['https://not-trusted.example/cb'] }),
        })
        expect(res.status).toBe(201)
        // ...but the token field is withheld until the destination is acknowledged.
        const clientId = (await res.json()).client_id
        const { challenge } = pkcePair()
        const form = await fetch(base(
            `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`
            + `&redirect_uri=${encodeURIComponent('https://not-trusted.example/cb')}`
            + `&code_challenge=${challenge}&code_challenge_method=S256`,
        ))
        const html = await form.text()
        expect(html).not.toContain('name="api_token"')
        expect(html).toContain('name="acknowledged"')
    })

    it('rejects plaintext http callbacks that are not loopback', async () => {
        const res = await fetch(base('/register'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'insecure', redirect_uris: ['http://example.com/cb'] }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects a registration without any redirect_uris', async () => {
        const res = await fetch(base('/register'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'no-callback' }),
        })
        expect(res.status).toBe(400)
    })
})

describe('ST-02 / authorization code bindings at the token endpoint', () => {
    it('rejects an exchange that omits redirect_uri', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge, verifier } = pkcePair()
        const { code } = await authorize({ clientId, redirectUri: HONEST_CB, challenge })
        expect(code).toBeTruthy()

        const res = await exchange({
            grant_type: 'authorization_code',
            code: code!,
            client_id: clientId,
            code_verifier: verifier,
        })
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe('invalid_grant')
    })

    it('rejects an exchange by a different client than the one the code was issued to', async () => {
        const victimClient = await registerClient([HONEST_CB])
        const attackerClient = await registerClient([ATTACKER_CB], 'Attacker Client')
        const { challenge, verifier } = pkcePair()
        const { code } = await authorize({ clientId: victimClient, redirectUri: HONEST_CB, challenge })

        const res = await exchange({
            grant_type: 'authorization_code',
            code: code!,
            client_id: attackerClient,
            redirect_uri: HONEST_CB,
            code_verifier: verifier,
        })
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe('invalid_grant')
    })

    it('rejects an exchange that omits client_id entirely', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge, verifier } = pkcePair()
        const { code } = await authorize({ clientId, redirectUri: HONEST_CB, challenge })

        const res = await exchange({
            grant_type: 'authorization_code',
            code: code!,
            redirect_uri: HONEST_CB,
            code_verifier: verifier,
        })
        expect(res.status).toBe(400)
    })
})

describe('ST-02 / PKCE is mandatory, not optional', () => {
    it('rejects an authorization request without a code_challenge', async () => {
        const clientId = await registerClient([HONEST_CB])
        const res = await fetch(
            base(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(HONEST_CB)}`),
        )
        expect(res.status).toBe(400)
        const html = await res.text()
        expect(html).not.toContain('name="api_token"')
    })

    it('rejects the downgrade to code_challenge_method=plain', async () => {
        const clientId = await registerClient([HONEST_CB])
        const res = await fetch(
            base(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(HONEST_CB)}&code_challenge=plain-value&code_challenge_method=plain`),
        )
        expect(res.status).toBe(400)
    })

    it('rejects an authorization request that omits response_type=code', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge } = pkcePair()
        const res = await fetch(
            base(`/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(HONEST_CB)}&code_challenge=${challenge}&code_challenge_method=S256`),
        )
        expect(res.status).toBe(400)
    })
})

describe('ST-02 / the raw SeaTable token must never leave the server', () => {
    it('does not return the API token as access_token or refresh_token', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge, verifier } = pkcePair()
        const { code } = await authorize({
            clientId,
            redirectUri: HONEST_CB,
            challenge,
            apiToken: 'VICTIM-RAW-TOKEN-XYZ',
        })

        const res = await exchange({
            grant_type: 'authorization_code',
            code: code!,
            client_id: clientId,
            redirect_uri: HONEST_CB,
            code_verifier: verifier,
        })
        expect(res.status).toBe(200)
        const data = await res.json()

        expect(data.access_token).not.toBe('VICTIM-RAW-TOKEN-XYZ')
        expect(data.refresh_token).not.toBe('VICTIM-RAW-TOKEN-XYZ')
        expect(JSON.stringify(data)).not.toContain('VICTIM-RAW-TOKEN-XYZ')
        expect(data.access_token).not.toBe(data.refresh_token)
        expect(data.expires_in).toBeGreaterThan(0)
    })

    it('resolves its own access token back to the API token server-side', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge, verifier } = pkcePair()
        const { code } = await authorize({
            clientId,
            redirectUri: HONEST_CB,
            challenge,
            apiToken: 'RESOLVE-ME-123',
        })
        const data = await (await exchange({
            grant_type: 'authorization_code',
            code: code!,
            client_id: clientId,
            redirect_uri: HONEST_CB,
            code_verifier: verifier,
        })).json()

        expect(provider.resolveAccessToken(data.access_token)).toBe('RESOLVE-ME-123')
        // A refresh token must not be accepted as an access token
        expect(provider.resolveAccessToken(data.refresh_token)).toBeUndefined()
    })

    it('rejects an arbitrary attacker-chosen refresh_token instead of echoing it', async () => {
        const res = await exchange({
            grant_type: 'refresh_token',
            refresh_token: 'attacker-supplied-value',
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toBe('invalid_grant')
    })

    it('rotates the refresh token on use', async () => {
        const clientId = await registerClient([HONEST_CB])
        const { challenge, verifier } = pkcePair()
        const { code } = await authorize({ clientId, redirectUri: HONEST_CB, challenge, apiToken: 'ROT-1' })
        const first = await (await exchange({
            grant_type: 'authorization_code',
            code: code!,
            client_id: clientId,
            redirect_uri: HONEST_CB,
            code_verifier: verifier,
        })).json()

        const refreshed = await exchange({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: clientId,
        })
        expect(refreshed.status).toBe(200)
        const second = await refreshed.json()
        expect(second.access_token).toBeTruthy()
        expect(second.refresh_token).not.toBe(first.refresh_token)
        expect(provider.resolveAccessToken(second.access_token)).toBe('ROT-1')
    })
})

describe('ST-02 / the honest client still works end to end', () => {
    it('completes register -> authorize -> exchange', async () => {
        const clientId = await registerClient([HONEST_CB], 'Well Behaved Client')
        const { challenge, verifier } = pkcePair()

        const form = await fetch(
            base(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(HONEST_CB)}&code_challenge=${challenge}&code_challenge_method=S256&state=abc`),
        )
        expect(form.status).toBe(200)
        expect(await form.text()).toContain('name="api_token"')

        const { status, location, code } = await authorize({ clientId, redirectUri: HONEST_CB, challenge })
        expect(status).toBe(302)
        expect(location!.startsWith(HONEST_CB)).toBe(true)
        expect(new URL(location!).searchParams.get('state')).toBe('st')

        const res = await exchange({
            grant_type: 'authorization_code',
            code: code!,
            client_id: clientId,
            redirect_uri: HONEST_CB,
            code_verifier: verifier,
        })
        expect(res.status).toBe(200)
        expect((await res.json()).token_type).toBe('Bearer')
    })
})
