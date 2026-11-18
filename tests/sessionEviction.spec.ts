import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

const VALID_TOKENS = new Set(['chatgpt-token', 'evicted-token', 'idle-token', 'visible-token', 'busy-token', 'tenant-a', 'tenant-b'])

vi.mock('../src/auth/tokenValidator', () => ({
    TokenValidator: class {
        async validate(token: string): Promise<boolean> {
            return VALID_TOKENS.has(token)
        }
        cleanup(): void {}
        destroy(): void {}
    },
}))

const logCalls: { fields: Record<string, unknown>; msg: string }[] = []
vi.mock('../src/logger', () => {
    const record = (a: unknown, b?: unknown) => {
        if (typeof a === 'object' && a !== null) logCalls.push({ fields: a as Record<string, unknown>, msg: String(b ?? '') })
        else logCalls.push({ fields: {}, msg: String(a) })
    }
    return { logger: { fatal: record, error: record, warn: record, info: record, debug: record, trace: record } }
})

import { startHttpServer } from '../src/http/httpServer'
import { rateLimitExceededTotal, sessionsEvictedTotal } from '../src/metrics/index'

/**
 * ChatGPT opens a fresh MCP session for every tool call and never sends DELETE.
 * Each session goes initialize → notifications/initialized → a GET it aborts
 * within milliseconds → one tools/call, and is then never touched again.
 *
 * On 15 November 2026 one ChatGPT Business user opened 29 sessions in about two
 * minutes this way. Every one of them had done real work, so each held its slot
 * for the full 10-minute idle timeout, and the 21st call met "429 Too many
 * concurrent connections". The pool limits how many sessions may *work* at
 * once; it must not limit how many a client has walked away from.
 */

const JSON_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
}

const INIT_BODY = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } },
})

const find = (needle: string) => logCalls.filter((c) => c.msg.includes(needle))

async function counterValue(counter: { get(): Promise<{ values: { value: number; labels: Record<string, unknown> }[] }> }, labels: Record<string, string> = {}): Promise<number> {
    const { values } = await counter.get()
    return values
        .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
        .reduce((sum, v) => sum + v.value, 0)
}

describe('Session eviction at the connection limit', () => {
    let server: ReturnType<typeof import('node:http').createServer>
    let baseUrl: string
    let port: number

    beforeAll(async () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_MODE = 'managed'
        process.env.SEATABLE_MOCK = 'true'
        process.env.SEATABLE_TOKEN_SECRET = 'session-eviction-spec-secret-long-enough'
        delete process.env.SEATABLE_API_TOKEN

        // Only the clock is faked, so the per-token request limit (60/min) sees
        // the requests spread over time as they were, not crammed into one burst.
        vi.useFakeTimers({ toFake: ['Date'] })

        server = await startHttpServer({ port: 0 })
        port = (server.address() as AddressInfo).port
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
        vi.useRealTimers()
        delete process.env.SEATABLE_MODE
        delete process.env.SEATABLE_TOKEN_SECRET
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    beforeEach(() => {
        logCalls.length = 0
        // A fresh rate-limit window for every test.
        vi.setSystemTime(Date.now() + 61_000)
    })

    // Every session gets its own IP: ChatGPT's egress addresses rotate, and the
    // per-IP limits are not what this test is about.
    let ipCounter = 0
    const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`

    function headers(token: string, ip: string, sessionId?: string): Record<string, string> {
        return {
            ...JSON_HEADERS,
            authorization: `Bearer ${token}`,
            'x-forwarded-for': ip,
            ...(sessionId && { 'mcp-session-id': sessionId }),
        }
    }

    async function init(token: string, ip = nextIp()): Promise<Response> {
        return fetch(`${baseUrl}/mcp`, { method: 'POST', headers: headers(token, ip), body: INIT_BODY })
    }

    /** The full ChatGPT sequence for one tool call. Returns the status of each step. */
    async function chatgptToolCall(token: string): Promise<{ init: number; call?: number; sessionId?: string }> {
        const ip = nextIp()
        const initRes = await init(token, ip)
        await initRes.text()
        const sessionId = initRes.headers.get('mcp-session-id') ?? undefined
        if (initRes.status !== 200 || !sessionId) return { init: initRes.status }

        const notified = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: headers(token, ip, sessionId),
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })
        expect(notified.status).toBe(202)

        // Opened and dropped at once — what Caddy logged as "aborting with incomplete response".
        const abort = new AbortController()
        const stream = await fetch(`${baseUrl}/mcp`, {
            method: 'GET',
            headers: { ...headers(token, ip, sessionId), accept: 'text/event-stream' },
            signal: abort.signal,
        })
        expect(stream.status).toBe(200)
        abort.abort()

        const call = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: headers(token, ip, sessionId),
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tables', arguments: {} } }),
        })
        await call.text()
        return { init: initRes.status, call: call.status, sessionId }
    }

    /**
     * Holds a POST on the session in flight: the body is never finished, so the
     * request is still being worked on from the server's point of view.
     */
    function holdRequestOpen(token: string, sessionId: string): { release: () => Promise<void> } {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: { ...headers(token, nextIp(), sessionId), 'transfer-encoding': 'chunked' },
        })
        req.on('error', () => {})
        req.write('{"jsonrpc":"2.0","id":9,')
        return {
            release: () =>
                new Promise<void>((resolve) => {
                    req.on('close', () => resolve())
                    req.destroy()
                }),
        }
    }

    async function close(token: string, sessionId: string): Promise<void> {
        await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: headers(token, nextIp(), sessionId) })
    }

    it('serves the 15 November pattern: 29 sessions, each used for one tool call', async () => {
        // 29 sessions over two minutes, as on 15 November.
        const results = []
        for (let i = 0; i < 29; i++) {
            results.push(await chatgptToolCall('chatgpt-token'))
            vi.setSystemTime(Date.now() + 4_000)
        }

        expect(results.map((r) => r.init)).toEqual(Array(29).fill(200))
        expect(results.map((r) => r.call)).toEqual(Array(29).fill(200))
        expect(find('Connection limit exceeded')).toHaveLength(0)

        // The oldest sessions made room; the newest are the ones still alive.
        const evicted = find('Session evicted')
        expect(evicted).toHaveLength(9)
        const stillAlive = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: headers('chatgpt-token', nextIp(), results[28].sessionId),
            body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
        })
        expect(stillAlive.status).toBe(200)

        for (const r of results) await close('chatgpt-token', r.sessionId!)
    })

    it('answers 404 on an evicted session, so a client knows to initialize again', async () => {
        const ids: string[] = []
        for (let i = 0; i < 20; i++) {
            const res = await init('evicted-token')
            ids.push(res.headers.get('mcp-session-id')!)
        }
        expect((await init('evicted-token')).status).toBe(200)

        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: headers('evicted-token', nextIp(), ids[0]),
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        })
        expect(res.status).toBe(404)

        for (const id of ids) await close('evicted-token', id)
    })

    it('evicts the session that has been idle longest, not the oldest one', async () => {
        const ids: string[] = []
        for (let i = 0; i < 20; i++) {
            const res = await init('idle-token')
            ids.push(res.headers.get('mcp-session-id')!)
            vi.setSystemTime(Date.now() + 1_000)
        }
        // The first session is still in use; the second is now the stalest.
        const touched = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: headers('idle-token', nextIp(), ids[0]),
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        })
        expect(touched.status).toBe(200)

        expect((await init('idle-token')).status).toBe(200)

        const probe = async (id: string) =>
            (await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: headers('idle-token', nextIp(), id),
                body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
            })).status
        expect(await probe(ids[0])).toBe(200)
        expect(await probe(ids[1])).toBe(404)

        for (const id of ids) await close('idle-token', id)
    })

    it('never closes a session that has a request in flight, and then answers 429', async () => {
        const ids: string[] = []
        for (let i = 0; i < 20; i++) {
            const res = await init('busy-token')
            ids.push(res.headers.get('mcp-session-id')!)
        }
        const held = ids.map((id) => holdRequestOpen('busy-token', id))
        // Let the server see every held request before the next initialize.
        await new Promise((r) => setTimeout(r, 100))

        const rejectedBefore = await counterValue(rateLimitExceededTotal, { type: 'connections' })
        const blocked = await init('busy-token')
        expect(blocked.status).toBe(429)
        expect(find('Session evicted')).toHaveLength(0)
        expect(await counterValue(rateLimitExceededTotal, { type: 'connections' })).toBe(rejectedBefore + 1)

        // The rejection names whose pool is full, without the credential.
        const denied = find('Connection limit exceeded').at(-1)!.fields
        expect(denied).toMatchObject({ active: 20, busy: 20, limit: 20 })
        expect(String(denied.token)).toMatch(/^[0-9a-f]{12}$/)

        // Once the work is done, the same sessions become evictable again.
        await Promise.all(held.map((h) => h.release()))
        await new Promise((r) => setTimeout(r, 50))
        expect((await init('busy-token')).status).toBe(200)

        for (const id of ids) await close('busy-token', id)
    })

    it("never evicts another tenant's session", async () => {
        const a: string[] = []
        for (let i = 0; i < 20; i++) a.push((await init('tenant-a')).headers.get('mcp-session-id')!)
        const b: string[] = []
        for (let i = 0; i < 25; i++) {
            const res = await init('tenant-b')
            expect(res.status).toBe(200)
            b.push(res.headers.get('mcp-session-id')!)
        }

        for (const id of a) {
            const res = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: headers('tenant-a', nextIp(), id),
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
            })
            expect(res.status).toBe(200)
        }

        for (const id of a) await close('tenant-a', id)
        for (const id of b) await close('tenant-b', id)
    })

    it('makes evictions and the tenant behind each session visible', async () => {
        const before = await counterValue(sessionsEvictedTotal)
        const ids: string[] = []
        for (let i = 0; i < 21; i++) ids.push((await init('visible-token')).headers.get('mcp-session-id')!)

        expect(await counterValue(sessionsEvictedTotal)).toBe(before + 1)

        const evicted = find('Session evicted').at(-1)!.fields
        expect(String(evicted.token)).toMatch(/^[0-9a-f]{12}$/)
        expect(evicted).toHaveProperty('session')
        expect(evicted).toHaveProperty('idleMs')

        // "Session initialized" carries the tenant, so a burst can be attributed.
        const initialized = find('Session initialized')
        expect(initialized).toHaveLength(21)
        for (const line of initialized) expect(line.fields.token).toBe(evicted.token)
        expect(JSON.stringify(logCalls)).not.toContain('visible-token')

        for (const id of ids) await close('visible-token', id)
    })
})
