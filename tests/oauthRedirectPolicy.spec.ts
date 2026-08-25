import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'

/**
 * Which callbacks may receive an authorization code, and how much friction the
 * user meets on the way.
 *
 * With open dynamic registration, "registered client" is not a trust statement —
 * an attacker registers honestly. The dividing line is whether the code leaves
 * the user's machine:
 *
 *   loopback / private-use scheme  stays local, safe by construction
 *   trusted remote host            curated, no friction
 *   unknown remote host            allowed, but only after an explicit,
 *                                  un-skippable acknowledgement
 *
 * The attacker controls the entry link, so nothing in that link may switch the
 * acknowledgement off.
 */

const SECRET = 'oauth-redirect-policy-spec-secret-long-enough'
const CHALLENGE = 'Zm9vYmFyLWNoYWxsZW5nZS12YWx1ZS1oZXJlLXh4eHh4'
const UNKNOWN = 'https://unknown-service.example/cb'

let server: Server
let port: number
let provider: OAuthProvider

const base = (p: string) => `http://localhost:${port}${p}`

async function register(uri: string, clientName = 'Client') {
    return fetch(base('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [uri] }),
    })
}

async function registerOk(uri: string, clientName = 'Client'): Promise<string> {
    const res = await register(uri, clientName)
    expect(res.status).toBe(201)
    return (await res.json()).client_id as string
}

function authorizeUrl(clientId: string, uri: string, extra = '') {
    return base(
        `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`
        + `&redirect_uri=${encodeURIComponent(uri)}`
        + `&code_challenge=${CHALLENGE}&code_challenge_method=S256${extra}`,
    )
}

function postAuthorize(
    fields: Record<string, string>,
    fetchSite: string | null = 'same-origin',
) {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (fetchSite) headers['sec-fetch-site'] = fetchSite
    return fetch(base('/authorize'), {
        method: 'POST',
        headers,
        body: new URLSearchParams(fields).toString(),
        redirect: 'manual',
    })
}

function flowFields(clientId: string, uri: string) {
    return {
        client_id: clientId,
        redirect_uri: uri,
        response_type: 'code',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        state: 'st',
    }
}

const hasTokenField = (html: string) => html.includes('name="api_token"')
const hasAcknowledgement = (html: string) => html.includes('name="acknowledged"')

beforeAll(async () => {
    provider = new OAuthProvider({
        secret: SECRET,
        trustedRedirectHosts: ['claude.ai', 'chatgpt.com'],
        validateToken: async (token) => token === 'valid-token',
    })
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, 'http://localhost')
        if (url.pathname === '/authorize') await provider.handleAuthorize(req, res, url)
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

describe('callbacks that stay on the user machine need no friction', () => {
    it.each([
        'http://127.0.0.1:8765/cb',
        'http://localhost:3000/callback',
        'http://[::1]:9000/cb',
        'cursor://anysphere.cursor-retrieval/oauth/callback',
        'vscode://mcp/auth',
        'com.example.desktop:/oauth2redirect',
    ])('goes straight to the token form for %s', async (uri) => {
        const clientId = await registerOk(uri)
        const html = await (await fetch(authorizeUrl(clientId, uri))).text()
        expect(hasTokenField(html)).toBe(true)
        expect(hasAcknowledgement(html)).toBe(false)
    })

    it('goes straight to the token form for a curated remote host', async () => {
        const uri = 'https://claude.ai/api/mcp/auth_callback'
        const clientId = await registerOk(uri)
        const html = await (await fetch(authorizeUrl(clientId, uri))).text()
        expect(hasTokenField(html)).toBe(true)
        expect(hasAcknowledgement(html)).toBe(false)
    })
})

describe('callbacks that never work at all', () => {
    it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'blob:https://x/y'])(
        'refuses to register %s',
        async (uri) => {
            expect((await register(uri)).status).toBe(400)
        },
    )

    it('refuses plaintext http to a remote host', async () => {
        expect((await register('http://example.com/cb')).status).toBe(400)
    })
})

describe('an unknown remote host is allowed, but not quietly', () => {
    it('registers without complaint — curation is not a gate', async () => {
        expect((await register(UNKNOWN)).status).toBe(201)
    })

    it('shows the destination instead of the token field', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await fetch(authorizeUrl(clientId, UNKNOWN))
        expect(res.status).toBe(200)
        const html = await res.text()
        expect(html).toContain('unknown-service.example')
        expect(hasAcknowledgement(html)).toBe(true)
        expect(hasTokenField(html)).toBe(false)
    })

    it('reveals the token field only after an acknowledgement from our own page', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await postAuthorize({ ...flowFields(clientId, UNKNOWN), acknowledged: 'yes' }, 'same-origin')
        expect(res.status).toBe(200)
        const html = await res.text()
        expect(hasTokenField(html)).toBe(true)
        // the destination stays visible next to the field
        expect(html).toContain('unknown-service.example')
    })

    it('issues a code once the user acknowledged and submitted a token', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await postAuthorize(
            { ...flowFields(clientId, UNKNOWN), acknowledged: 'yes', api_token: 'valid-token' },
            'same-origin',
        )
        expect(res.status).toBe(302)
        expect(res.headers.get('location')!.startsWith(UNKNOWN)).toBe(true)
    })
})

describe('the acknowledgement cannot be switched off by the attacker', () => {
    it('ignores an acknowledgement smuggled into the entry link', async () => {
        const clientId = await registerOk(UNKNOWN)
        const html = await (await fetch(authorizeUrl(clientId, UNKNOWN, '&acknowledged=yes'))).text()
        expect(hasTokenField(html)).toBe(false)
        expect(hasAcknowledgement(html)).toBe(true)
    })

    it('rejects a token submission that never passed the acknowledgement', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await postAuthorize({ ...flowFields(clientId, UNKNOWN), api_token: 'valid-token' }, 'same-origin')
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
        const html = await res.text()
        expect(hasAcknowledgement(html)).toBe(true)
        expect(hasTokenField(html)).toBe(false)
    })

    it('rejects an acknowledgement auto-submitted from a foreign page', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await postAuthorize({ ...flowFields(clientId, UNKNOWN), acknowledged: 'yes' }, 'cross-site')
        const html = await res.text()
        expect(hasTokenField(html)).toBe(false)
        expect(hasAcknowledgement(html)).toBe(true)
    })

    it('rejects a cross-site auto-submit that carries the token as well', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await postAuthorize(
            { ...flowFields(clientId, UNKNOWN), acknowledged: 'yes', api_token: 'valid-token' },
            'cross-site',
        )
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
    })

    it('falls back to friction when the browser sends no Sec-Fetch-Site at all', async () => {
        const clientId = await registerOk(UNKNOWN)
        const res = await postAuthorize({ ...flowFields(clientId, UNKNOWN), acknowledged: 'yes' }, null)
        const html = await res.text()
        expect(hasTokenField(html)).toBe(false)
    })
})

describe('the consent screen does not lend credibility it cannot verify', () => {
    it('marks the application name as self-reported', async () => {
        const uri = 'http://127.0.0.1:4321/cb'
        const clientId = await registerOk(uri, 'Claude')
        const html = await (await fetch(authorizeUrl(clientId, uri))).text()
        expect(html).toContain('Claude')
        expect(html.toLowerCase()).toContain('self-reported')
    })

    it('names the destination on the warning page, not just the claimed identity', async () => {
        const clientId = await registerOk(UNKNOWN, 'Totally Legit Sync')
        const html = await (await fetch(authorizeUrl(clientId, UNKNOWN))).text()
        const destinationAt = html.indexOf('unknown-service.example')
        const nameAt = html.indexOf('Totally Legit Sync')
        expect(destinationAt).toBeGreaterThan(-1)
        // the destination is introduced before the self-declared name
        expect(destinationAt).toBeLessThan(nameAt)
    })
})

describe('policy helpers', () => {
    it('separates "usable at all" from "needs no friction"', () => {
        expect(provider.isPermittedRedirectUri(UNKNOWN)).toBe(true)
        expect(provider.isTrustedRedirectUri(UNKNOWN)).toBe(false)

        expect(provider.isPermittedRedirectUri('http://127.0.0.1:1/cb')).toBe(true)
        expect(provider.isTrustedRedirectUri('http://127.0.0.1:1/cb')).toBe(true)

        expect(provider.isPermittedRedirectUri('javascript:alert(1)')).toBe(false)
        expect(provider.isPermittedRedirectUri('http://example.com/cb')).toBe(false)
    })

    it('matches curated hosts exactly — no suffix tricks', () => {
        for (const uri of ['https://claude.ai.evil.example/cb', 'https://evilclaude.ai/cb', 'https://sub.claude.ai/cb']) {
            expect(provider.isTrustedRedirectUri(uri)).toBe(false)
            // still permitted — it just meets the acknowledgement
            expect(provider.isPermittedRedirectUri(uri)).toBe(true)
        }
    })
})
