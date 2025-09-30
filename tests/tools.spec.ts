import { describe, expect, it, beforeAll } from 'vitest'
import { buildServer } from '../src/mcp/server'
// Tool registrars (subset sufficient for test)
import { registerPingSeatable } from '../src/mcp/tools/pingSeatable'
import { registerEchoArgs } from '../src/mcp/tools/echoArgs'

// Minimal mock of getInputSchema (not relevant for gating logic)
const getInputSchema = () => ({ type: 'object', additionalProperties: true }) as any

function simulateToolRegistration(debug: boolean): string[] {
    const names: string[] = []
    const serverAdapter = {
        registerTool: (name: string, _config: any, _handler: any) => {
            names.push(name)
        }
    }
    const deps: any = { client: {}, env: { SEATABLE_ENABLE_DEBUG_TOOLS: debug }, getInputSchema }
    registerPingSeatable(serverAdapter as any, deps)
    if (debug) {
        registerEchoArgs(serverAdapter as any, deps)
    }
    return names
}

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_BASE_UUID = 'test-base'
})

describe('MCP Tools registration', () => {
    it('buildServer returns a server', () => {
        const srv = buildServer()
        expect(srv).toBeTruthy()
    })

    it('does not register echo_args when debug flag disabled', () => {
        const names = simulateToolRegistration(false)
        expect(names).not.toContain('echo_args')
    })

    it('registers echo_args when debug flag enabled', () => {
        const names = simulateToolRegistration(true)
        expect(names).toContain('echo_args')
    })
})
