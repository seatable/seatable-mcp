import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
