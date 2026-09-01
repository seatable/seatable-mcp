import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/metrics/metricsServer', () => ({
    startMetricsServer: vi.fn().mockResolvedValue(undefined),
}))

/** Tokens the fake SeaTable backend considers valid. */
const VALID_TOKENS = new Set(['token-valid'])

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

type Server = ReturnType<typeof import('node:http').createServer>

const JSON_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
}

const INITIALIZE = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
})

async function close(server: Server | undefined): Promise<void> {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * RFC 9728 + MCP authorization (revision 2025-06-18).
 *
 * An MCP server acting as an OAuth resource server MUST publish protected
 * resource metadata and MUST point at it from the WWW-Authenticate header of
 * every 401. Without both, a strictly conformant client cannot discover the
 * authorization server and fails to connect before any OAuth window opens.
 *
 * Written against the gap reported on 2026-09-01: /.well-known/oauth-protected-resource
 * answered 404 and the 401 carried no WWW-Authenticate at all.
 */
describe('managed mode / RFC 9728 protected resource metadata', () => {
    let server: Server
    let baseUrl: string

    beforeAll(async () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_MODE = 'managed'
        process.env.SEATABLE_MOCK = 'true'
        process.env.SEATABLE_TOKEN_SECRET = 'protected-resource-spec-secret-long-enough'
        delete process.env.SEATABLE_API_TOKEN
        delete process.env.SEATABLE_MCP_HOSTNAME

        server = await startHttpServer({ port: 0 })
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        delete process.env.SEATABLE_MODE
        delete process.env.SEATABLE_TOKEN_SECRET
        await close(server)
    })

    it('serves the document at the root well-known path', async () => {
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('application/json')
    })

    it('serves the document at the path-suffixed location for the /mcp resource', async () => {
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('application/json')
    })

    it('names the MCP endpoint as the resource identifier', async () => {
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
        const body = await res.json()
        expect(body.resource).toBe(`${baseUrl}/mcp`)
    })

    it('advertises bearer tokens in the Authorization header', async () => {
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
        const body = await res.json()
        expect(body.bearer_methods_supported).toContain('header')
    })

    /**
     * The regression that would break Claude and ChatGPT: once WWW-Authenticate
     * exists, conformant clients follow it INSTEAD of probing the legacy
     * /.well-known/oauth-authorization-server path. If the two documents disagree
     * about the issuer, clients that work today stop working.
     */
    it('points at the same issuer the authorization server metadata reports', async () => {
        const [asRes, prRes] = await Promise.all([
            fetch(`${baseUrl}/.well-known/oauth-authorization-server`),
            fetch(`${baseUrl}/.well-known/oauth-protected-resource`),
        ])
        const asMeta = await asRes.json()
        const prMeta = await prRes.json()

        expect(Array.isArray(prMeta.authorization_servers)).toBe(true)
        expect(prMeta.authorization_servers).toContain(asMeta.issuer)
    })

    it('uses the configured public hostname for absolute URLs', async () => {
        process.env.SEATABLE_MCP_HOSTNAME = 'mcp.seatable.com'
        let hostnameServer: Server | undefined
        try {
            hostnameServer = await startHttpServer({ port: 0 })
            const port = (hostnameServer.address() as AddressInfo).port
            const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)
            const body = await res.json()
            expect(body.resource).toBe('https://mcp.seatable.com/mcp')
            expect(body.authorization_servers).toContain('https://mcp.seatable.com')
        } finally {
            delete process.env.SEATABLE_MCP_HOSTNAME
            await close(hostnameServer)
        }
    })
})

describe('managed mode / WWW-Authenticate on 401', () => {
    let server: Server
    let baseUrl: string

    beforeAll(async () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_MODE = 'managed'
        process.env.SEATABLE_MOCK = 'true'
        process.env.SEATABLE_TOKEN_SECRET = 'protected-resource-spec-secret-long-enough'
        delete process.env.SEATABLE_API_TOKEN
        delete process.env.SEATABLE_MCP_HOSTNAME

        server = await startHttpServer({ port: 0 })
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        delete process.env.SEATABLE_MODE
        delete process.env.SEATABLE_TOKEN_SECRET
        await close(server)
    })

    it('points a credential-less request at the resource metadata', async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: INITIALIZE,
        })
        expect(res.status).toBe(401)

        const challenge = res.headers.get('www-authenticate')
        expect(challenge).toBeTruthy()
        expect(challenge).toMatch(/^Bearer\b/)
        expect(challenge).toContain(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`)
    })

    /**
     * RFC 6750 section 3.1: a request that carries no credential at all must not
     * be answered with an error code — only a rejected one may be.
     */
    it('omits an error code when no credential was presented', async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: INITIALIZE,
        })
        expect(res.headers.get('www-authenticate')).not.toContain('error=')
    })

    it('reports invalid_token when a credential was presented and rejected', async () => {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: 'Bearer token-nope' },
            body: INITIALIZE,
        })
        expect(res.status).toBe(401)

        const challenge = res.headers.get('www-authenticate')
        expect(challenge).toContain('error="invalid_token"')
        expect(challenge).toContain('resource_metadata=')
    })

    it('challenges a session request that carries no credential', async () => {
        const init = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: 'Bearer token-valid' },
            body: INITIALIZE,
        })
        expect(init.status).toBe(200)
        const sessionId = init.headers.get('mcp-session-id')!
        expect(sessionId).toBeTruthy()

        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'mcp-session-id': sessionId },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        })
        expect(res.status).toBe(401)
        expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
    })

    it('challenges a session request whose credential was rejected', async () => {
        const init = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: 'Bearer token-valid' },
            body: INITIALIZE,
        })
        const sessionId = init.headers.get('mcp-session-id')!

        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'mcp-session-id': sessionId, authorization: 'Bearer token-nope' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        })
        expect(res.status).toBe(401)
        expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    })
})

/**
 * Selfhosted mode has no OAuth and no bearer requirement, so there is no
 * protected resource to describe. Advertising one would point clients at
 * endpoints that do not exist in this mode.
 */
describe('selfhosted mode / no protected resource metadata', () => {
    let server: Server
    let baseUrl: string

    beforeAll(async () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_API_TOKEN = 'test-token'
        process.env.SEATABLE_MOCK = 'true'
        delete process.env.SEATABLE_MODE
        delete process.env.SEATABLE_TOKEN_SECRET

        server = await startHttpServer({ port: 0 })
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        await close(server)
    })

    it('answers 404 at the root well-known path', async () => {
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
        expect(res.status).toBe(404)
    })

    it('answers 404 at the path-suffixed location', async () => {
        const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
        expect(res.status).toBe(404)
    })
})
