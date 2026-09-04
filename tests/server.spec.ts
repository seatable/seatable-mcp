import { beforeAll, describe, expect, it, vi } from 'vitest'

import { buildServer, getStaticToolDefinitions, SeaTableMCPServer } from '../src/mcp/server'
import { registerEchoArgs } from '../src/mcp/tools/echoArgs'
import { registerPingSeatable } from '../src/mcp/tools/pingSeatable'
import type { ClientLike } from '../src/mcp/tools/types'
import { ContextualClient } from '../src/seatable/contextualClient'
import { MockSeaTableClient } from '../src/seatable/mockClient'
import { logger } from '../src/logger'

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_MOCK = 'true'
})

/** Helper to access private members for testing */
function getTools(server: SeaTableMCPServer) {
    return (server as any).tools as Map<string, any>
}

function callTool(server: SeaTableMCPServer, name: string, args?: Record<string, unknown>) {
    return (server as any).handleCallTool({
        params: { name, arguments: args },
    })
}

function listTools(server: SeaTableMCPServer) {
    return (server as any).handleListTools()
}

/** Simulate tool registration with/without debug flag */
function getToolNames(debug: boolean): string[] {
    const names: string[] = []
    const adapter = { registerTool: (name: string) => { names.push(name) } }
    const deps: any = { client: {}, env: { SEATABLE_ENABLE_DEBUG_TOOLS: debug }, getInputSchema: () => ({ type: 'object', additionalProperties: true }) }
    registerPingSeatable(adapter as any, deps)
    if (debug) registerEchoArgs(adapter as any, deps)
    return names
}

/** Registry with one client per base, mimicking ClientRegistry for multi-base tests */
function createMultiBaseRegistry(baseNames: string[]) {
    const clients = new Map<string, ClientLike>()
    for (const name of baseNames) {
        clients.set(name, {
            getBaseInfo: () => ({ dtableUuid: `uuid_${name}`, appName: `app_${name}` }),
            getMetadata: async () => ({ tables: [{ _id: `tbl_${name}`, name: `Table_${name}`, columns: [] }] }),
        } as unknown as ClientLike)
    }
    return {
        baseNames,
        isMultiBase: baseNames.length > 1,
        resolve(baseName?: string): ClientLike {
            if (!baseName) {
                throw new Error(`Multiple bases available (${baseNames.join(', ')}). Specify "base" parameter.`)
            }
            const client = clients.get(baseName)
            if (!client) throw new Error(`Unknown base "${baseName}". Available: ${baseNames.join(', ')}`)
            return client
        },
    }
}

describe('SeaTableMCPServer', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        server = buildServer()
    })

    it('buildServer() in mock mode registers all 18 tools', () => {
        const tools = getTools(server)
        expect(tools.size).toBe(21)
    })

    it('getToolDefinitions() returns array with name, description, inputSchema', () => {
        const defs = server.getToolDefinitions()
        expect(defs.length).toBe(21)
        for (const def of defs) {
            expect(def).toHaveProperty('name')
            expect(def).toHaveProperty('description')
            expect(def).toHaveProperty('inputSchema')
            expect(def.inputSchema.type).toBe('object')
        }
    })

    it('getStaticToolDefinitions() works without a real client', () => {
        const defs = getStaticToolDefinitions()
        expect(defs.length).toBe(21)
        expect(defs[0]).toHaveProperty('name')
    })

    it('handleCallTool with valid tool returns result', async () => {
        const result = await callTool(server, 'list_tables', {})
        expect(result).toHaveProperty('content')
        expect(result.content[0].type).toBe('text')
        expect(result.isError).toBeUndefined()
    })

    it('handleCallTool with unknown tool returns isError', async () => {
        const result = await callTool(server, 'nonexistent_tool', {})
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('Unknown tool')
    })

    it('handleCallTool catches handler errors and returns isError', async () => {
        // get_row with a non-existent row should throw in MockSeaTableClient
        const result = await callTool(server, 'get_row', {
            table: 'Table1',
            row_id: 'does-not-exist',
        })
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('Error in tool get_row')
    })

    it('handleListTools in multi-base mode injects base property with enum', async () => {
        const mockClient = new MockSeaTableClient() as unknown as ClientLike
        const multiBaseServer = new SeaTableMCPServer(mockClient, {
            contextualClient: { runWithBase: (_n: any, fn: any) => fn() } as any,
            baseNames: ['CRM', 'Projects'],
        })

        const result = await listTools(multiBaseServer)
        const listTablesTool = result.tools.find((t: any) => t.name === 'list_tables')
        expect(listTablesTool.inputSchema.properties).toHaveProperty('base')
        expect(listTablesTool.inputSchema.properties.base.enum).toEqual(['CRM', 'Projects'])
    })

    it('does not register echo_args when debug flag is disabled', () => {
        const names = getToolNames(false)
        expect(names).toContain('ping_seatable')
        expect(names).not.toContain('echo_args')
    })

    it('registers echo_args when debug flag is enabled', () => {
        const names = getToolNames(true)
        expect(names).toContain('echo_args')
    })

    it('handleCallTool succeeds in multi-base mode with two bases', async () => {
        const registry = createMultiBaseRegistry(['CRM', 'Projects'])
        const contextualClient = new ContextualClient(registry as any)
        const multiBaseServer = new SeaTableMCPServer(contextualClient as unknown as ClientLike, {
            contextualClient,
            baseNames: registry.baseNames,
        })

        const result = await callTool(multiBaseServer, 'list_tables', { base: 'CRM' })
        expect(result.isError).toBeUndefined()
        expect(result.content[0].text).toContain('Table_CRM')
    })

    it('logs base info of the resolved base in multi-base mode', async () => {
        const registry = createMultiBaseRegistry(['CRM', 'Projects'])
        const contextualClient = new ContextualClient(registry as any)
        const multiBaseServer = new SeaTableMCPServer(contextualClient as unknown as ClientLike, {
            contextualClient,
            baseNames: registry.baseNames,
        })

        const infoSpy = vi.spyOn(logger, 'info')
        let calls: unknown[][]
        try {
            await callTool(multiBaseServer, 'list_tables', { base: 'Projects' })
            calls = infoSpy.mock.calls.map((call) => [...call])
        } finally {
            infoSpy.mockRestore()
        }

        const completed = calls.find((call) => call[1] === 'Tool call completed') as [Record<string, unknown>, string] | undefined
        expect(completed).toBeDefined()
        expect(completed![0]).toMatchObject({ dtable_uuid: 'uuid_Projects', app_name: 'app_Projects' })
    })

    it('handleListTools in multi-base mode does NOT inject base into list_bases', async () => {
        const mockClient = new MockSeaTableClient() as unknown as ClientLike
        const multiBaseServer = new SeaTableMCPServer(mockClient, {
            contextualClient: { runWithBase: (_n: any, fn: any) => fn() } as any,
            baseNames: ['CRM', 'Projects'],
        })

        const result = await listTools(multiBaseServer)
        const listBasesTool = result.tools.find((t: any) => t.name === 'list_bases')
        expect(listBasesTool).toBeDefined()
        expect(listBasesTool.inputSchema.properties).not.toHaveProperty('base')
    })
})
