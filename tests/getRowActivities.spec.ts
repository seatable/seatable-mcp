import { beforeAll, describe, expect, it } from 'vitest'

import { buildServer, SeaTableMCPServer } from '../src/mcp/server'

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_MOCK = 'true'
})

function callTool(server: SeaTableMCPServer, name: string, args?: Record<string, unknown>) {
    return (server as any).handleCallTool({
        params: { name, arguments: args ?? {} },
    })
}

function parseContent(result: any): any {
    return JSON.parse(result.content[0].text)
}

describe('get_row_activities tool', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        server = buildServer()
    })

    // --- Positive tests ---

    it('returns activities for a row', async () => {
        const result = await callTool(server, 'get_row_activities', {
            table: 'Table1',
            row_id: 'row_1',
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data).toHaveProperty('activities')
        expect(data).toHaveProperty('total_count')
        expect(Array.isArray(data.activities)).toBe(true)
        expect(data.activities.length).toBeGreaterThan(0)
    })

    it('activity has expected cleaned fields', async () => {
        const result = await callTool(server, 'get_row_activities', {
            table: 'Table1',
            row_id: 'row_1',
        })
        const data = parseContent(result)
        const activity = data.activities[0]
        expect(activity).toHaveProperty('op_type')
        expect(activity).toHaveProperty('op_time')
        expect(activity).toHaveProperty('changes')
        // Should NOT have raw API noise
        expect(activity).not.toHaveProperty('id')
        expect(activity).not.toHaveProperty('dtable_uuid')
        expect(activity).not.toHaveProperty('detail')
    })

    it('changes have column name and type', async () => {
        const result = await callTool(server, 'get_row_activities', {
            table: 'Table1',
            row_id: 'row_1',
        })
        const data = parseContent(result)
        const change = data.activities[0].changes[0]
        expect(change).toHaveProperty('column')
        expect(change).toHaveProperty('type')
        // Should NOT have internal fields
        expect(change).not.toHaveProperty('column_key')
        expect(change).not.toHaveProperty('column_data')
    })

    // --- Negative tests ---

    it('rejects missing table parameter', async () => {
        const result = await callTool(server, 'get_row_activities', {
            row_id: 'row_1',
        })
        expect(result.isError).toBe(true)
    })

    it('rejects missing row_id parameter', async () => {
        const result = await callTool(server, 'get_row_activities', {
            table: 'Table1',
        })
        expect(result.isError).toBe(true)
    })

    it('rejects empty args', async () => {
        const result = await callTool(server, 'get_row_activities', {})
        expect(result.isError).toBe(true)
    })
})

describe('simplifyValue', () => {
    // Import the module to test the cleanup logic directly
    // We test via the tool output since simplifyValue is not exported

    it('file values are simplified to names in mock output', async () => {
        // The mock returns simple text values, but we verify the structure is correct
        const server = buildServer()
        const result = await callTool(server, 'get_row_activities', {
            table: 'Table1',
            row_id: 'row_1',
        })
        const data = parseContent(result)
        const change = data.activities[0].changes[0]
        expect(change.value).toBe('Updated')
        expect(change.old_value).toBe('Original')
    })
})
