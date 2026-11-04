import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

const VALID_TOKENS = new Set(['token-a', 'token-b', 'token-slots'])

vi.mock('../src/auth/tokenValidator', () => ({
    TokenValidator: class {
        async validate(token: string): Promise<boolean> {
            return VALID_TOKENS.has(token)
        }
        cleanup(): void {}
        destroy(): void {}
    },
}))

import { startHttpServer } from '../src/http/httpServer'

/*
 * Parsing a 10 MB body costs far more memory than the body itself, so a caller
 * without a valid credential must not get that far. These requests never finish
 * their body: a server that waits for it never answers.
 */

let server: ReturnType<typeof import('node:http').createServer>
let port: number

const JSON_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
}

const INITIALIZE = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
})

/** Sends the headers and part of a body, never the end. Resolves with the status, or 'no answer'. */
function statusForUnfinishedBody(headers: Record<string, string>): Promise<number | 'no answer'> {
    return new Promise((resolve) => {
        const req = httpRequest({ port, path: '/mcp', method: 'POST', headers: { ...JSON_HEADERS, ...headers } })
        const timer = setTimeout(() => {
            req.destroy()
            resolve('no answer')
        }, 1000)
        req.on('response', (res) => {
            clearTimeout(timer)
            res.resume()
            req.destroy()
            resolve(res.statusCode!)
        })
        req.on('error', () => {})
        req.write('{"jsonrpc":"2.0",')
    })
}

function post(body: string, headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body })
}

async function initSession(token: string): Promise<string> {
    const res = await post(INITIALIZE, { authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    await res.text()
    return res.headers.get('mcp-session-id')!
}

beforeAll(async () => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_MODE = 'managed'
    process.env.SEATABLE_MOCK = 'true'
    process.env.SEATABLE_TOKEN_SECRET = 'auth-before-body-spec-secret-long-enough'
    delete process.env.SEATABLE_API_TOKEN

    server = await startHttpServer({ port: 0 })
    port = (server.address() as AddressInfo).port
})

afterAll(async () => {
    delete process.env.SEATABLE_MODE
    delete process.env.SEATABLE_TOKEN_SECRET
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('the body is read only after authentication', () => {
    it('answers a new session without a token before the body arrives', async () => {
        expect(await statusForUnfinishedBody({})).toBe(401)
    })

    it('answers a new session with an invalid token before the body arrives', async () => {
        expect(await statusForUnfinishedBody({ authorization: 'Bearer wrong' })).toBe(401)
    })

    it('answers a session request without a token before the body arrives', async () => {
        const sessionId = await initSession('token-a')
        expect(await statusForUnfinishedBody({ 'mcp-session-id': sessionId })).toBe(401)
    })

    it('answers a request for an unknown session before the body arrives', async () => {
        expect(await statusForUnfinishedBody({
            authorization: 'Bearer token-a',
            'mcp-session-id': 'does-not-exist',
        })).toBe(404)
    })

    it('answers a request from a different identity before the body arrives', async () => {
        const sessionId = await initSession('token-a')
        expect(await statusForUnfinishedBody({
            authorization: 'Bearer token-b',
            'mcp-session-id': sessionId,
        })).toBe(403)
    })
})

describe('authenticated requests', () => {
    it('still work with a body that arrives in parts', async () => {
        const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest({
                port,
                path: '/mcp',
                method: 'POST',
                headers: { ...JSON_HEADERS, authorization: 'Bearer token-a' },
            })
            req.on('response', (res) => {
                res.resume()
                resolve(res.statusCode!)
            })
            req.on('error', reject)
            req.write(INITIALIZE.slice(0, 20))
            setTimeout(() => req.end(INITIALIZE.slice(20)), 50)
        })
        expect(status).toBe(200)
    })

    it('do not hold a connection slot when the body is not JSON', async () => {
        // The limit is 20 slots per token.
        for (let i = 0; i < 21; i++) {
            const res = await post('{not json', { authorization: 'Bearer token-slots' })
            expect(res.status).not.toBe(429)
            await res.text()
        }
        await initSession('token-slots')
    })

    it('get a 404 when the session ends while the body is on its way', async () => {
        const authorization = 'Bearer token-a'
        const sessionId = await initSession('token-a')
        const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

        const status = new Promise<number>((resolve, reject) => {
            const req = httpRequest({
                port,
                path: '/mcp',
                method: 'POST',
                headers: { ...JSON_HEADERS, authorization, 'mcp-session-id': sessionId },
            })
            req.on('response', (res) => {
                res.resume()
                resolve(res.statusCode!)
            })
            req.on('error', reject)
            req.write(body.slice(0, 10), async () => {
                await new Promise((r) => setTimeout(r, 50))
                const closed = await fetch(`http://127.0.0.1:${port}/mcp`, {
                    method: 'DELETE',
                    headers: { ...JSON_HEADERS, authorization, 'mcp-session-id': sessionId },
                })
                await closed.text()
                req.end(body.slice(10))
            })
        })

        expect(await status).toBe(404)
    })
})

// Runs last: it uses up the pre-auth budget of this IP.
describe('the pre-auth limit', () => {
    it('applies before the body arrives', async () => {
        const statuses: Array<number | 'no answer'> = []
        for (let i = 0; i < 35; i++) statuses.push(await statusForUnfinishedBody({}))
        expect(statuses).toContain(429)
        expect(statuses).not.toContain('no answer')
    })
})
