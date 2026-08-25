import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'

/**
 * Nearly half of all real authorization attempts were rejected with a bare
 * "Invalid API token". Two causes: whitespace picked up while copying, and the
 * SeaTable account API token pasted where a base API token is required.
 */

const SECRET = 'oauth-token-input-spec-secret-long-enough'
const CB = 'http://127.0.0.1:5599/cb'
const VALID = 'the-one-valid-base-token'
const CHALLENGE = 'Zm9vYmFyLWNoYWxsZW5nZS12YWx1ZS1oZXJlLXh4eHh4'

let server: Server
let port: number
let provider: OAuthProvider
const seenByValidator: string[] = []
let accountTokens = new Set<string>()

const base = (p: string) => `http://localhost:${port}${p}`

async function registerClient(): Promise<string> {
    const res = await fetch(base('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [CB] }),
    })
    return (await res.json()).client_id as string
}

function submit(clientId: string, apiToken: string) {
    return fetch(base('/authorize'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        body: new URLSearchParams({
            api_token: apiToken,
            client_id: clientId,
            redirect_uri: CB,
            response_type: 'code',
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
        }).toString(),
        redirect: 'manual',
    })
}

beforeAll(async () => {
    provider = new OAuthProvider({
        secret: SECRET,
        validateToken: async (token) => {
            seenByValidator.push(token)
            return token === VALID
        },
        looksLikeAccountToken: async (token) => accountTokens.has(token),
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

describe('copy-paste whitespace', () => {
    it('accepts a token pasted with surrounding whitespace and a newline', async () => {
        const clientId = await registerClient()
        seenByValidator.length = 0
        const res = await submit(clientId, `  ${VALID}\n`)
        expect(res.status).toBe(302)
        expect(seenByValidator).toContain(VALID)
    })

    it('treats a whitespace-only entry as an empty field, not an invalid token', async () => {
        const clientId = await registerClient()
        seenByValidator.length = 0
        const res = await submit(clientId, '   \n\t ')
        expect(res.status).toBe(400)
        expect(await res.text()).toContain('Please enter your API token')
        expect(seenByValidator).toHaveLength(0)
    })
})

describe('account token pasted instead of base token', () => {
    it('names the actual mistake and where to find the right token', async () => {
        const clientId = await registerClient()
        accountTokens = new Set(['an-account-level-token'])
        const res = await submit(clientId, 'an-account-level-token')
        expect(res.status).toBe(400)
        const html = await res.text()
        expect(html).toContain('account')
        expect(html).toContain('API Tokens')
        // the form stays so the user can correct it right away
        expect(html).toContain('name="api_token"')
    })

    it('falls back to the generic message for a token that is neither', async () => {
        const clientId = await registerClient()
        accountTokens = new Set()
        const res = await submit(clientId, 'complete-nonsense')
        expect(res.status).toBe(400)
        const html = await res.text()
        expect(html).toContain('Invalid API token')
        expect(html).not.toContain('account API token')
    })

    it('never echoes the submitted token back into the page', async () => {
        const clientId = await registerClient()
        accountTokens = new Set()
        const res = await submit(clientId, 'secret-nonsense-value-42')
        expect(await res.text()).not.toContain('secret-nonsense-value-42')
    })
})
