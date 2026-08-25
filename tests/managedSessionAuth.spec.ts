import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

/** Tokens the fake SeaTable backend considers valid. */
const VALID_TOKENS = new Set(['token-account-a', 'token-account-b'])

vi.mock('../src/auth/tokenValidator', () => ({
    TokenValidator: class {
        async validate(token: string): Promise<boolean> {
            return VALID_TOKENS.has(token)
        }
        cleanup(): void {}
        destroy(): void {}
    },
}))

const logCalls: unknown[][] = []
vi.mock('../src/logger', () => {
    const record = (...args: unknown[]) => { logCalls.push(args) }
    return {
        logger: { fatal: record, error: record, warn: record, info: record, debug: record, trace: record },
    }
})

import { startHttpServer } from '../src/http/httpServer'

let server: ReturnType<typeof import('node:http').createServer>
let baseUrl: string

const JSON_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
}

async function initSession(token: string): Promise<string> {
    const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        }),
    })
    expect(res.status).toBe(200)
    const sessionId = res.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    return sessionId!
}

function callTools(sessionId: string, token?: string) {
    const headers: Record<string, string> = { ...JSON_HEADERS, 'mcp-session-id': sessionId }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    return fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
}

beforeAll(async () => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_MODE = 'managed'
    process.env.SEATABLE_MOCK = 'true'
    process.env.SEATABLE_TOKEN_SECRET = 'managed-session-auth-spec-secret-long-enough'
    delete process.env.SEATABLE_API_TOKEN

    server = await startHttpServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    delete process.env.SEATABLE_MODE
    delete process.env.SEATABLE_TOKEN_SECRET
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * Adversarial tests for established-session authorization (external report, ST-01).
 * The session ID is a routing value. It must never be an authorization credential.
 */
describe('ST-01 / every request must carry a valid credential', () => {
    it('rejects a POST that presents only the session ID', async () => {
        const sessionId = await initSession('token-account-a')
        const res = await callTools(sessionId)
        expect(res.status).toBe(401)
    })

    it('rejects a POST with an explicitly invalid bearer token', async () => {
        const sessionId = await initSession('token-account-a')
        const res = await callTools(sessionId, 'invalid-controlled-value')
        expect(res.status).toBe(401)
    })

    it('rejects a GET that presents only the session ID', async () => {
        const sessionId = await initSession('token-account-a')
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'GET',
            headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
        })
        expect(res.status).toBe(401)
    })

    it('rejects a DELETE that presents only the session ID', async () => {
        const sessionId = await initSession('token-account-a')
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'DELETE',
            headers: { 'mcp-session-id': sessionId },
        })
        expect(res.status).toBe(401)
    })
})

describe('ST-01 / sessions are bound to the identity that created them', () => {
    it("rejects account B's valid token against account A's session", async () => {
        const sessionA = await initSession('token-account-a')
        const res = await callTools(sessionA, 'token-account-b')
        expect(res.status).toBe(403)
    })

    it("rejects account A's valid token against account B's session", async () => {
        const sessionB = await initSession('token-account-b')
        const res = await callTools(sessionB, 'token-account-a')
        expect(res.status).toBe(403)
    })

    it('accepts the owning token on its own session', async () => {
        const sessionId = await initSession('token-account-a')
        const res = await callTools(sessionId, 'token-account-a')
        expect(res.status).toBe(200)
    })

    it('still returns 404 for an unknown session even with a valid token', async () => {
        const res = await callTools('11111111-2222-3333-4444-555555555555', 'token-account-a')
        expect(res.status).toBe(404)
    })
})

describe('ST-01 / session IDs are not written to the log in cleartext', () => {
    it('never logs the raw session ID', async () => {
        logCalls.length = 0
        const sessionId = await initSession('token-account-a')
        await callTools(sessionId, 'token-account-a')

        const serialized = JSON.stringify(logCalls)
        expect(serialized).not.toContain(sessionId)
    })
})
