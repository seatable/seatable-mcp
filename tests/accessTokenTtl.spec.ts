import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { OAuthProvider } from '../src/auth/oauthProvider.js'
import { clearEnvOverrides, getEnv, setEnvOverrides } from '../src/config/env.js'

/**
 * How long an issued access token stays valid.
 *
 * One hour is the default compromise between "a stolen token expires soon" and
 * "the user is not asked for their API token again". Operators need to move it:
 * shorter to narrow the window after a revocation, longer if real clients turn
 * out to renew badly and would otherwise re-prompt their users hourly.
 */

const SECRET = 'access-token-ttl-spec-secret-long-enough'
const CB = 'http://127.0.0.1:5150/cb'
const API_TOKEN = 'a-base-token'

let server: Server
let port: number
let provider: OAuthProvider
let ttlMs: number | undefined

const base = (p: string) => `http://localhost:${port}${p}`

function b64url(b: Buffer) {
    return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Registers, authorizes and exchanges; returns the token endpoint's response. */
async function issue(): Promise<any> {
    const clientId = await (await fetch(base('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'ttl', redirect_uris: [CB] }),
    })).json().then((r: any) => r.client_id)

    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const authorized = await fetch(base('/authorize'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        body: new URLSearchParams({
            api_token: API_TOKEN, client_id: clientId, redirect_uri: CB,
            response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
        }).toString(),
        redirect: 'manual',
    })
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!
    return await (await fetch(base('/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code', code, client_id: clientId,
            redirect_uri: CB, code_verifier: verifier,
        }).toString(),
    })).json()
}

beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, 'http://localhost')
        if (url.pathname === '/authorize') await provider.handleAuthorize(req, res, url)
        else if (url.pathname === '/token') await provider.handleToken(req, res)
        else if (url.pathname === '/register') await provider.handleRegister(req, res)
        else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => {
        server.listen(0, () => { port = (server.address() as any).port; resolve() })
    })
})

afterAll(async () => {
    provider?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

function makeProvider(ms?: number) {
    provider?.destroy()
    ttlMs = ms
    provider = new OAuthProvider({
        secret: SECRET,
        accessTokenTtlMs: ms,
        validateToken: async (t) => t === API_TOKEN,
    })
}

describe('access token lifetime', () => {
    it('defaults to one hour', async () => {
        makeProvider(undefined)
        const res = await issue()
        expect(res.expires_in).toBe(3600)
    })

    it('honours a configured lifetime and reports it as expires_in', async () => {
        makeProvider(120_000)
        const res = await issue()
        expect(res.expires_in).toBe(120)
        expect(provider.resolveAccessToken(res.access_token)).toBe(API_TOKEN)
    })

    it('stops resolving the token once its lifetime has passed', async () => {
        makeProvider(40)
        const res = await issue()
        await new Promise((r) => setTimeout(r, 70))
        expect(provider.resolveAccessToken(res.access_token)).toBeUndefined()
    })

    it('never issues a refresh token shorter-lived than the access token', async () => {
        // A 30-day access token must not come with a 14-day refresh token.
        makeProvider(30 * 24 * 60 * 60 * 1000)
        const res = await issue()
        const refreshed = await fetch(base('/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: res.refresh_token }).toString(),
        })
        expect(refreshed.status).toBe(200)
        expect(provider.resolveAccessToken((await refreshed.json()).access_token)).toBe(API_TOKEN)
    })
})

describe('SEATABLE_ACCESS_TOKEN_TTL', () => {
    afterEach(() => clearEnvOverrides())

    const withEnv = (value?: string) => {
        setEnvOverrides({
            SEATABLE_SERVER_URL: 'https://example.com',
            SEATABLE_MODE: 'managed',
            SEATABLE_TOKEN_SECRET: 'x'.repeat(32),
            ...(value === undefined ? {} : { SEATABLE_ACCESS_TOKEN_TTL: value }),
        } as any)
    }

    it('is optional and unset by default', () => {
        withEnv(undefined)
        expect(getEnv().SEATABLE_ACCESS_TOKEN_TTL).toBeUndefined()
    })

    it('parses a value in seconds', () => {
        withEnv('120')
        expect(getEnv().SEATABLE_ACCESS_TOKEN_TTL).toBe(120)
    })

    it.each(['0', '-1', '29', 'abc', '3000000'])('rejects the unusable value %s', (value) => {
        withEnv(value)
        expect(() => getEnv()).toThrow(/SEATABLE_ACCESS_TOKEN_TTL/)
    })
})
