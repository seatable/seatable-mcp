import { beforeAll, describe, expect, it } from 'vitest'

import { buildServer, getStaticToolDefinitions, SeaTableMCPServer } from '../src/mcp/server'
import type { ClientLike } from '../src/mcp/tools/types'
import { MockSeaTableClient } from '../src/seatable/mockClient'

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

describe('SeaTableMCPServer', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        server = buildServer()
    })

    it('buildServer() in mock mode registers all 18 tools', () => {
        const tools = getTools(server)
        expect(tools.size).toBe(18)
    })

    it('getToolDefinitions() returns array with name, description, inputSchema', () => {
        const defs = server.getToolDefinitions()
        expect(defs.length).toBe(18)
        for (const def of defs) {
            expect(def).toHaveProperty('name')
            expect(def).toHaveProperty('description')
            expect(def).toHaveProperty('inputSchema')
            expect(def.inputSchema.type).toBe('object')
        }
    })

    it('getStaticToolDefinitions() works without a real client', () => {
        const defs = getStaticToolDefinitions()
        expect(defs.length).toBe(18)
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
            contextualClient: { setBase: () => {} } as any,
            baseNames: ['CRM', 'Projects'],
        })

        const result = await listTools(multiBaseServer)
        const listTablesTool = result.tools.find((t: any) => t.name === 'list_tables')
        expect(listTablesTool.inputSchema.properties).toHaveProperty('base')
        expect(listTablesTool.inputSchema.properties.base.enum).toEqual(['CRM', 'Projects'])
    })

    it('handleListTools in multi-base mode does NOT inject base into list_bases', async () => {
        const mockClient = new MockSeaTableClient() as unknown as ClientLike
        const multiBaseServer = new SeaTableMCPServer(mockClient, {
            contextualClient: { setBase: () => {} } as any,
            baseNames: ['CRM', 'Projects'],
        })

        const result = await listTools(multiBaseServer)
        const listBasesTool = result.tools.find((t: any) => t.name === 'list_bases')
        expect(listBasesTool).toBeDefined()
        expect(listBasesTool.inputSchema.properties).not.toHaveProperty('base')
    })
})
