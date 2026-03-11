import type { AddressInfo } from 'node:net'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the metrics server to avoid port conflicts in tests
vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

import { startHttpServer } from '../src/http/httpServer'

let server: ReturnType<typeof import('node:http').createServer>
let baseUrl: string

beforeAll(async () => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_MOCK = 'true'

    server = await startHttpServer({ port: 0 })
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
    if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

describe('HTTP Server', () => {
    it('GET /health returns 200 with status ok', async () => {
        const res = await fetch(`${baseUrl}/health`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty('status', 'ok')
        expect(body).toHaveProperty('version')
    })

    it('GET / returns 200 with server info', async () => {
        const res = await fetch(`${baseUrl}/`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty('name', 'seatable-mcp')
        expect(body).toHaveProperty('version')
        expect(body).toHaveProperty('docs')
    })

    it('GET /.well-known/mcp/server-card.json returns valid card', async () => {
        const res = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty('serverInfo')
        expect(body).toHaveProperty('tools')
        expect(Array.isArray(body.tools)).toBe(true)
        expect(body.tools.length).toBeGreaterThan(0)
    })

    it('GET /unknown returns 404', async () => {
        const res = await fetch(`${baseUrl}/unknown`)
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body).toHaveProperty('error', 'Not found')
    })

    it('POST /mcp without session-id creates a new session', async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '1.0' },
                },
            }),
        })
        expect(res.status).toBe(200)
        const sessionId = res.headers.get('mcp-session-id')
        expect(sessionId).toBeTruthy()
    })

    it('POST /mcp with invalid session-id returns 404', async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'mcp-session-id': 'nonexistent-session',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {},
            }),
        })
        expect(res.status).toBe(404)
    })

    it('DELETE /mcp with valid session-id returns 200', async () => {
        // First create a session
        const initRes = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '1.0' },
                },
            }),
        })
        const sessionId = initRes.headers.get('mcp-session-id')
        expect(sessionId).toBeTruthy()

        // Then delete it
        const deleteRes = await fetch(`${baseUrl}/mcp`, {
            method: 'DELETE',
            headers: { 'mcp-session-id': sessionId! },
        })
        expect(deleteRes.status).toBe(200)
    })

    it('POST /mcp with oversized body aborts connection', async () => {
        const oversizedBody = 'x'.repeat(11 * 1024 * 1024) // > 10 MB
        try {
            const res = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: oversizedBody,
            })
            // Either the server destroys the socket (fetch error) or returns an error status
            expect(res.ok).toBe(false)
        } catch {
            // Connection destroyed by server — expected behavior
            expect(true).toBe(true)
        }
    })
})

describe('CORS handling', () => {
    let corsServer: ReturnType<typeof import('node:http').createServer>
    let corsBaseUrl: string

    beforeEach(async () => {
        process.env.CORS_ALLOWED_ORIGINS = 'https://cloud.seatable.io,https://seatable-demo.de'
        corsServer = await startHttpServer({ port: 0 })
        const addr = corsServer.address() as AddressInfo
        corsBaseUrl = `http://127.0.0.1:${addr.port}`
    })

    afterEach(async () => {
        delete process.env.CORS_ALLOWED_ORIGINS
        if (corsServer) {
            await new Promise<void>((resolve) => corsServer.close(() => resolve()))
        }
    })

    it('sets CORS headers for allowed origin', async () => {
        const res = await fetch(`${corsBaseUrl}/health`, {
            headers: { origin: 'https://cloud.seatable.io' },
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('access-control-allow-origin')).toBe('https://cloud.seatable.io')
        expect(res.headers.get('access-control-allow-credentials')).toBe('true')
        expect(res.headers.get('access-control-expose-headers')).toBe('mcp-session-id')
    })

    it('does not set CORS headers for disallowed origin', async () => {
        const res = await fetch(`${corsBaseUrl}/health`, {
            headers: { origin: 'https://evil.com' },
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('does not set CORS headers when no origin header is sent', async () => {
        const res = await fetch(`${corsBaseUrl}/health`)
        expect(res.status).toBe(200)
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('responds to OPTIONS preflight with 204', async () => {
        const res = await fetch(`${corsBaseUrl}/mcp`, {
            method: 'OPTIONS',
            headers: {
                origin: 'https://seatable-demo.de',
                'access-control-request-method': 'POST',
            },
        })
        expect(res.status).toBe(204)
        expect(res.headers.get('access-control-allow-origin')).toBe('https://seatable-demo.de')
        expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS')
    })

    it('OPTIONS from disallowed origin returns 204 without CORS headers', async () => {
        const res = await fetch(`${corsBaseUrl}/mcp`, {
            method: 'OPTIONS',
            headers: {
                origin: 'https://evil.com',
                'access-control-request-method': 'POST',
            },
        })
        expect(res.status).toBe(204)
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
})

describe('No CORS when env is unset', () => {
    it('does not set CORS headers on the main server', async () => {
        const res = await fetch(`${baseUrl}/health`, {
            headers: { origin: 'https://cloud.seatable.io' },
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
})

describe('Session idle timeout', () => {
    let idleServer: ReturnType<typeof import('node:http').createServer>
    let idleBaseUrl: string

    beforeEach(async () => {
        idleServer = await startHttpServer({
            port: 0,
            sessionIdleTimeoutMs: 200,
            sessionCheckIntervalMs: 50,
        })
        const addr = idleServer.address() as AddressInfo
        idleBaseUrl = `http://127.0.0.1:${addr.port}`
    })

    afterEach(async () => {
        if (idleServer) {
            await new Promise<void>((resolve) => idleServer.close(() => resolve()))
        }
    })

    it('closes idle sessions after timeout', async () => {
        // Create a session
        const initRes = await fetch(`${idleBaseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '1.0' },
                },
            }),
        })
        const sessionId = initRes.headers.get('mcp-session-id')
        expect(sessionId).toBeTruthy()

        // Session should be valid immediately
        const res1 = await fetch(`${idleBaseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
                'mcp-session-id': sessionId!,
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {},
            }),
        })
        expect(res1.status).toBe(200)

        // Wait for idle timeout + check interval to pass
        await new Promise((r) => setTimeout(r, 350))

        // Session should now be gone
        const res2 = await fetch(`${idleBaseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'mcp-session-id': sessionId!,
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/list',
                params: {},
            }),
        })
        expect(res2.status).toBe(404)
    })
})
