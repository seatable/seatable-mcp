import { beforeAll, describe, expect, it } from 'vitest'

import { buildServer, SeaTableMCPServer } from '../src/mcp/server'

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_MOCK = 'true'
})

/** Call a tool handler via the server's internal handleCallTool */
function callTool(server: SeaTableMCPServer, name: string, args?: Record<string, unknown>) {
    return (server as any).handleCallTool({
        params: { name, arguments: args ?? {} },
    })
}

function parseContent(result: any): any {
    return JSON.parse(result.content[0].text)
}

describe('Tool handlers (mock integration)', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        server = buildServer()
    })

    // --- list_tables ---

    it('list_tables returns table list', async () => {
        const result = await callTool(server, 'list_tables')
        const data = parseContent(result)
        expect(Array.isArray(data)).toBe(true)
        expect(data[0]).toHaveProperty('name', 'Table1')
    })

    // --- add_row ---

    it('add_row creates a row and returns _id', async () => {
        const result = await callTool(server, 'add_row', {
            table: 'Table1',
            row: { Name: 'Alice' },
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data).toHaveProperty('_id')
        expect(data.Name).toBe('Alice')
    })

    // --- append_rows ---

    it('append_rows creates multiple rows', async () => {
        const result = await callTool(server, 'append_rows', {
            table: 'Table1',
            rows: [{ Name: 'Bob' }, { Name: 'Carol' }],
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data.rows).toHaveLength(2)
        expect(data.rows[0]).toHaveProperty('_id')
    })

    it('append_rows rejects >100 rows (Zod max limit)', async () => {
        const rows = Array.from({ length: 101 }, (_, i) => ({ Name: `Row${i}` }))
        const result = await callTool(server, 'append_rows', {
            table: 'Table1',
            rows,
        })
        expect(result.isError).toBe(true)
    })

    // --- get_row ---

    it('get_row returns a row by ID', async () => {
        // First add a row to get a known ID
        const addResult = await callTool(server, 'add_row', {
            table: 'Table1',
            row: { Name: 'GetMe' },
        })
        const { _id } = parseContent(addResult)

        const result = await callTool(server, 'get_row', {
            table: 'Table1',
            row_id: _id,
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data._id).toBe(_id)
        expect(data.Name).toBe('GetMe')
    })

    it('get_row returns error for unknown row ID', async () => {
        const result = await callTool(server, 'get_row', {
            table: 'Table1',
            row_id: 'nonexistent',
        })
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('row not found')
    })

    // --- list_rows ---

    it('list_rows returns paginated results', async () => {
        const result = await callTool(server, 'list_rows', {
            table: 'Table1',
            page: 1,
            page_size: 10,
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data).toHaveProperty('rows')
        expect(Array.isArray(data.rows)).toBe(true)
        expect(data).toHaveProperty('page', 1)
    })

    // --- update_rows ---

    it('update_rows updates an existing row', async () => {
        // Add a row first
        const addResult = await callTool(server, 'add_row', {
            table: 'Table1',
            row: { Name: 'UpdateMe' },
        })
        const { _id } = parseContent(addResult)

        const result = await callTool(server, 'update_rows', {
            table: 'Table1',
            updates: [{ row_id: _id, values: { Name: 'Updated' } }],
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data.rows[0].Name).toBe('Updated')
    })

    // --- delete_rows ---

    it('delete_rows deletes a row by ID', async () => {
        const addResult = await callTool(server, 'add_row', {
            table: 'Table1',
            row: { Name: 'DeleteMe' },
        })
        const { _id } = parseContent(addResult)

        const result = await callTool(server, 'delete_rows', {
            table: 'Table1',
            row_ids: [_id],
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data.results[0]).toEqual({ row_id: _id, success: true })
    })

    it('delete_rows rejects >100 row_ids', async () => {
        const row_ids = Array.from({ length: 101 }, (_, i) => `row_${i}`)
        const result = await callTool(server, 'delete_rows', {
            table: 'Table1',
            row_ids,
        })
        expect(result.isError).toBe(true)
    })

    // --- search_rows ---

    it('search_rows finds rows by query', async () => {
        // Add a row with a known value
        await callTool(server, 'add_row', {
            table: 'Table1',
            row: { Name: 'SearchTarget' },
        })

        const result = await callTool(server, 'search_rows', {
            table: 'Table1',
            query: { Name: 'SearchTarget' },
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data.rows.length).toBeGreaterThanOrEqual(1)
        expect(data.rows[0].Name).toBe('SearchTarget')
    })

    // --- list_collaborators ---

    it('list_collaborators returns collaborator list', async () => {
        const result = await callTool(server, 'list_collaborators')
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(Array.isArray(data)).toBe(true)
        expect(data[0]).toHaveProperty('email')
        expect(data[0]).toHaveProperty('name')
    })
})
