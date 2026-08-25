import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const logCalls: { fields: Record<string, unknown>; msg: string }[] = []
vi.mock('../src/logger', () => {
    const record = (a: unknown, b?: unknown) => {
        if (typeof a === 'object' && a !== null) logCalls.push({ fields: a as Record<string, unknown>, msg: String(b ?? '') })
        else logCalls.push({ fields: {}, msg: String(a) })
    }
    return { logger: { fatal: record, error: record, warn: record, info: record, debug: record, trace: record } }
})

import { OAuthProvider } from '../src/auth/oauthProvider.js'

/**
 * After the external report, the forensic questions could not be answered from
 * the logs: no client IP, no callback destination, no link between an issued
 * code and its exchange, and several rejection paths logged nothing at all.
 */

const SECRET = 'oauth-observability-spec-secret-long-enough'
const CB = 'http://127.0.0.1:6611/cb'
const API_TOKEN = 'the-users-actual-base-token'
const CHALLENGE = 'Zm9vYmFyLWNoYWxsZW5nZS12YWx1ZS1oZXJlLXh4eHh4'

let server: Server
let port: number
let provider: OAuthProvider

const base = (p: string) => `http://localhost:${port}${p}`
const find = (needle: string) => logCalls.filter((c) => c.msg.includes(needle))

async function registerClient(name = 'Acme Client'): Promise<string> {
    const res = await fetch(base('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ client_name: name, redirect_uris: [CB] }),
    })
    return (await res.json()).client_id as string
}

async function issueCode(clientId: string): Promise<string> {
    const res = await fetch(base('/authorize'), {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': '198.51.100.7',
            'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams({
            api_token: API_TOKEN, client_id: clientId, redirect_uri: CB,
            response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256',
        }).toString(),
        redirect: 'manual',
    })
    return new URL(res.headers.get('location')!).searchParams.get('code')!
}

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A complete, valid authorization -- the fixed CHALLENGE above has no verifier. */
async function fullFlow(clientId: string): Promise<{ refresh_token: string }> {
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const authorized = await fetch(base('/authorize'), {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': '198.51.100.7',
            'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams({
            api_token: API_TOKEN, client_id: clientId, redirect_uri: CB,
            response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
        }).toString(),
        redirect: 'manual',
    })
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!
    const res = await exchange({
        grant_type: 'authorization_code', code, client_id: clientId,
        redirect_uri: CB, code_verifier: verifier,
    })
    return await res.json()
}

function exchange(params: Record<string, string>) {
    return fetch(base('/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7' },
        body: new URLSearchParams(params).toString(),
    })
}

beforeAll(async () => {
    provider = new OAuthProvider({
        secret: SECRET,
        validateToken: async (t) => t === API_TOKEN,
        getClientIp: (req) => (req.headers['x-forwarded-for'] as string) ?? 'unknown',
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

beforeEach(() => { logCalls.length = 0 })

describe('an issued code is attributable', () => {
    it('records client, callback and IP when a code is issued', async () => {
        const clientId = await registerClient('Acme Client')
        await issueCode(clientId)

        const issued = find('authorization code issued')
        expect(issued).toHaveLength(1)
        expect(issued[0].fields.clientName).toBe('Acme Client')
        expect(issued[0].fields.callback).toBe('http://127.0.0.1:6611')
        expect(issued[0].fields.ip).toBe('198.51.100.7')
    })

    it('links the exchange back to the authorization with a flow id', async () => {
        const clientId = await registerClient()
        const code = await issueCode(clientId)
        await exchange({
            grant_type: 'authorization_code', code, client_id: clientId,
            redirect_uri: CB, code_verifier: 'irrelevant-verifier',
        })

        const flow = find('authorization code issued')[0].fields.flow
        expect(flow).toBeTruthy()
        expect(logCalls.filter((c) => c.fields.flow === flow && c.msg.includes('exchange')).length).toBeGreaterThan(0)
    })

    it('never writes the code or the API token to the log', async () => {
        const clientId = await registerClient()
        const code = await issueCode(clientId)
        await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CB })

        const serialized = JSON.stringify(logCalls)
        expect(serialized).not.toContain(code)
        expect(serialized).not.toContain(API_TOKEN)
        // the flow id must be derived, not the code truncated
        expect(serialized).not.toContain(code.slice(0, 12))
    })

    it('records the IP on a rejected token submission', async () => {
        const clientId = await registerClient()
        await fetch(base('/authorize'), {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-forwarded-for': '198.51.100.99',
                'sec-fetch-site': 'same-origin',
            },
            body: new URLSearchParams({
                api_token: 'wrong', client_id: clientId, redirect_uri: CB,
                response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256',
            }).toString(),
            redirect: 'manual',
        })
        const rejected = find('invalid API token')
        expect(rejected).toHaveLength(1)
        expect(rejected[0].fields.ip).toBe('198.51.100.99')
    })
})

describe('token renewal is visible', () => {
    it('logs a successful refresh, not only a failed one', async () => {
        const clientId = await registerClient()
        const first = await fullFlow(clientId)
        expect(first.refresh_token).toBeTruthy()

        logCalls.length = 0
        await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })

        const refreshed = find('refresh')
        expect(refreshed.length).toBeGreaterThan(0)
        expect(refreshed.some((c) => c.msg.toLowerCase().includes('reject'))).toBe(false)
    })

    it('never writes the refresh token itself to the log', async () => {
        const clientId = await registerClient()
        const first = await fullFlow(clientId)
        expect(first.refresh_token).toBeTruthy()

        logCalls.length = 0
        await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })
        const serialized = JSON.stringify(logCalls)
        expect(serialized).not.toContain(first.refresh_token)
        expect(serialized).not.toContain(API_TOKEN)
    })
})

describe('a registration is reconstructable', () => {
    it('records the callbacks a client registered, not just its name', async () => {
        await registerClient('Acme Client')
        const reg = find('dynamic client registration')
        expect(reg).toHaveLength(1)
        expect(reg[0].fields.clientName).toBe('Acme Client')
        expect(reg[0].fields.callbacks).toEqual([CB])
        expect(reg[0].fields.ip).toBe('198.51.100.7')
    })

    it('caps what an unknown caller can write into the log', async () => {
        const many = Array.from({ length: 12 }, (_, i) => `https://c${i}.example/${'x'.repeat(400)}`)
        await fetch(base('/register'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
            body: JSON.stringify({ client_name: 'Noisy', redirect_uris: many }),
        })
        const reg = find('dynamic client registration')
        expect(reg).toHaveLength(1)
        const logged = reg[0].fields.callbacks as string[]
        expect(logged.length).toBeLessThanOrEqual(5)
        for (const entry of logged) expect(entry.length).toBeLessThanOrEqual(120)
    })
})

describe('no rejection path is silent', () => {
    it('logs a missing code_verifier', async () => {
        const clientId = await registerClient()
        const code = await issueCode(clientId)
        await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CB })
        expect(find('code_verifier').length).toBeGreaterThan(0)
    })

    it('logs an unsupported grant type', async () => {
        await exchange({ grant_type: 'client_credentials' })
        expect(find('grant_type').length).toBeGreaterThan(0)
    })

    it('logs an expired authorization code distinctly', async () => {
        await exchange({ grant_type: 'authorization_code', code: 'no-such-code', client_id: 'x', redirect_uri: CB })
        expect(find('invalid/expired code').length).toBeGreaterThan(0)
    })

    it('logs a rejected callback with the destination that was attempted', async () => {
        const clientId = await registerClient()
        await fetch(base(
            `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}`
            + `&redirect_uri=${encodeURIComponent('https://attacker.example/cb')}`
            + `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
        ), { headers: { 'x-forwarded-for': '198.51.100.66' } })

        const rejected = find('redirect_uri not registered')
        expect(rejected).toHaveLength(1)
        expect(rejected[0].fields.callback).toBe('https://attacker.example')
        expect(rejected[0].fields.ip).toBe('198.51.100.66')
    })
})
