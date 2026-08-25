import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/auth/tokenValidator', () => ({
    TokenValidator: class {
        async validate(token: string): Promise<boolean> {
            return token === 'good-token'
        }
        async looksLikeAccountToken(): Promise<boolean> {
            return false
        }
        cleanup(): void {}
        destroy(): void {}
    },
}))

import { startHttpServer } from '../src/http/httpServer'

let server: ReturnType<typeof import('node:http').createServer>
let baseUrl: string

/**
 * The OAuth endpoints bypassed the rate limiter entirely — it only ran inside
 * handleMcpRequest. That left POST /authorize usable as an unauthenticated,
 * unthrottled oracle for testing arbitrary SeaTable API tokens, with every
 * attempt forwarded to the SeaTable backend.
 */
beforeAll(async () => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_MODE = 'managed'
    process.env.SEATABLE_MOCK = 'true'
    process.env.SEATABLE_TOKEN_SECRET = 'oauth-rate-limit-spec-secret-long-enough'
    delete process.env.SEATABLE_API_TOKEN

    server = await startHttpServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    delete process.env.SEATABLE_MODE
    delete process.env.SEATABLE_TOKEN_SECRET
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Each test uses its own X-Forwarded-For so the per-IP buckets stay independent. */
function asIp(ip: string) {
    return { 'x-forwarded-for': ip }
}

async function postAuthorize(ip: string, token = 'wrong-token') {
    return fetch(`${baseUrl}/authorize`, {
        method: 'POST',
        headers: { ...asIp(ip), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_token: token, client_id: 'x', redirect_uri: 'http://127.0.0.1:7777/cb', response_type: 'code' }).toString(),
        redirect: 'manual',
    })
}

describe('OAuth endpoints are rate limited', () => {
    it('throttles repeated token submissions from one IP', async () => {
        const ip = '203.0.113.10'
        let throttled = 0
        for (let i = 0; i < 25; i++) {
            const res = await postAuthorize(ip)
            if (res.status === 429) throttled++
        }
        expect(throttled).toBeGreaterThan(0)
    })

    it('answers a throttled request with retry-after', async () => {
        const ip = '203.0.113.11'
        let last: Response | undefined
        for (let i = 0; i < 25; i++) {
            last = await postAuthorize(ip)
            if (last.status === 429) break
        }
        expect(last!.status).toBe(429)
        expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0)
    })

    it('throttles the registration endpoint', async () => {
        const ip = '203.0.113.12'
        let throttled = 0
        for (let i = 0; i < 45; i++) {
            const res = await fetch(`${baseUrl}/register`, {
                method: 'POST',
                headers: { ...asIp(ip), 'content-type': 'application/json' },
                body: JSON.stringify({ client_name: 'flood', redirect_uris: ['http://127.0.0.1:7777/cb'] }),
            })
            if (res.status === 429) throttled++
        }
        expect(throttled).toBeGreaterThan(0)
    })

    it('throttles the token endpoint', async () => {
        const ip = '203.0.113.13'
        let throttled = 0
        for (let i = 0; i < 45; i++) {
            const res = await fetch(`${baseUrl}/token`, {
                method: 'POST',
                headers: { ...asIp(ip), 'content-type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=authorization_code&code=guess',
            })
            if (res.status === 429) throttled++
        }
        expect(throttled).toBeGreaterThan(0)
    })

    it('lets a normal authorization flow through unthrottled', async () => {
        const ip = '203.0.113.20'
        const reg = await fetch(`${baseUrl}/register`, {
            method: 'POST',
            headers: { ...asIp(ip), 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'Honest', redirect_uris: ['http://127.0.0.1:7777/cb'] }),
        })
        expect(reg.status).toBe(201)
        const clientId = (await reg.json()).client_id

        const form = await fetch(
            `${baseUrl}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:7777/cb')}&code_challenge=abc&code_challenge_method=S256`,
            { headers: asIp(ip) },
        )
        expect(form.status).not.toBe(429)

        const meta = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { headers: asIp(ip) })
        expect(meta.status).toBe(200)
    })

    it('does not throttle the health endpoint', async () => {
        const ip = '203.0.113.30'
        for (let i = 0; i < 40; i++) {
            const res = await fetch(`${baseUrl}/health`, { headers: asIp(ip) })
            expect(res.status).toBe(200)
        }
    })
})
