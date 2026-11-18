import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

const VALID_TOKENS = new Set(['slot-token-1', 'slot-token-2', 'slot-token-3', 'slot-token-4'])

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

/**
 * The production incident these tests encode: a client opened 14 sessions in 51
 * seconds, made one tool call, and then met "Connection limit exceeded" for
 * every further attempt. One defect fed it: slots that a failed initialize
 * never gave back. Sessions that are idle but alive are handled by eviction,
 * see tests/sessionEviction.spec.ts.
 */

const JSON_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
}

const INIT_BODY = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
})

const find = (needle: string) => logCalls.filter((c) => c.msg.includes(needle))

describe('Connection slot accounting', () => {
    let server: ReturnType<typeof import('node:http').createServer>
    let baseUrl: string

    beforeAll(async () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_MODE = 'managed'
        process.env.SEATABLE_MOCK = 'true'
        process.env.SEATABLE_TOKEN_SECRET = 'connection-slots-spec-secret-long-enough'
        delete process.env.SEATABLE_API_TOKEN

        server = await startHttpServer({ port: 0 })
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        delete process.env.SEATABLE_MODE
        delete process.env.SEATABLE_TOKEN_SECRET
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    beforeEach(() => {
        logCalls.length = 0
    })

    /**
     * A POST without a session ID that is not an initialize request acquires a
     * slot, then loses it: the transport never opens, so `onclose` never fires,
     * and the session never lands in the idle sweeper's map either. Every such
     * request used to burn one of the 20 slots until the process restarted.
     */
    it('does not leak a slot when the initialize request is rejected', async () => {
        const token = 'slot-token-1'
        const ip = '198.51.100.1'

        for (let i = 0; i < 21; i++) {
            const res = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
                // No session ID and not an initialize call — the SDK rejects this.
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            })
            expect(res.status).not.toBe(429)
        }

        // All 21 slots must have been handed back, so an honest client still gets in.
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
            body: INIT_BODY,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('mcp-session-id')).toBeTruthy()
    })

    it('releases the slot when a session is closed with DELETE', async () => {
        const token = 'slot-token-2'
        const ip = '198.51.100.2'
        const ids: string[] = []

        for (let i = 0; i < 20; i++) {
            const res = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
                body: INIT_BODY,
            })
            expect(res.status).toBe(200)
            ids.push(res.headers.get('mcp-session-id')!)
        }

        // Pool is full; DELETE frees a slot, so the next session needs no eviction.
        await fetch(`${baseUrl}/mcp`, {
            method: 'DELETE',
            headers: { 'mcp-session-id': ids[0], authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
        })

        const allowed = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
            body: INIT_BODY,
        })
        expect(allowed.status).toBe(200)
        expect(find('Session evicted')).toHaveLength(0)
        ids.push(allowed.headers.get('mcp-session-id')!)

        for (const id of ids.slice(1)) {
            await fetch(`${baseUrl}/mcp`, {
                method: 'DELETE',
                headers: { 'mcp-session-id': id, authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
            })
        }
    })
})

/**
 * getClientIp took the *first* X-Forwarded-For entry. Caddy appends the real
 * peer to whatever the client sent, so the first entry is attacker-controlled:
 * a client can pick its own rate-limit bucket, evade the per-IP limit, and
 * poison the bucket another tenant is using.
 */
describe('Client IP attribution behind the proxy', () => {
    let server: ReturnType<typeof import('node:http').createServer>
    let baseUrl: string

    beforeAll(async () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_MODE = 'managed'
        process.env.SEATABLE_MOCK = 'true'
        process.env.SEATABLE_TOKEN_SECRET = 'connection-slots-ip-spec-secret-long-enough'
        delete process.env.SEATABLE_API_TOKEN

        server = await startHttpServer({ port: 0 })
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        delete process.env.SEATABLE_MODE
        delete process.env.SEATABLE_TOKEN_SECRET
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    beforeEach(() => {
        logCalls.length = 0
    })

    it('uses the entry our own proxy appended, not the one the client sent', async () => {
        await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '10.9.9.9, 203.0.113.42' },
            body: INIT_BODY,
        })

        const warned = find('Missing Authorization header')
        expect(warned.length).toBeGreaterThan(0)
        expect(warned[warned.length - 1].fields.ip).toBe('203.0.113.42')
    })

    it('falls back to the socket peer when no header is present', async () => {
        await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: INIT_BODY })

        const warned = find('Missing Authorization header')
        expect(warned.length).toBeGreaterThan(0)
        expect(String(warned[warned.length - 1].fields.ip)).toContain('127.0.0.1')
    })
})
