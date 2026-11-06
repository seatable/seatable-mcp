import { beforeAll, describe, expect, it } from 'vitest'

import { makeError } from '../src/errors'
import { buildServer, SeaTableMCPServer } from '../src/mcp/server'
import { normalizeWhere } from '../src/mcp/tools/findRows'

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_MOCK = 'true'
})

function callTool(server: SeaTableMCPServer, name: string, args: Record<string, unknown>) {
    return (server as any).handleCallTool({ params: { name, arguments: args } })
}

// Seen in production: a model passed `where` as a JSON string. Every row then
// evaluated to false, and "0 rows" sent the model searching other tables.
describe('find_rows with a where that is not an object', () => {
    const NAME = 'find-rows-string-where'
    const where = { or: [{ eq: { field: 'Name', value: NAME } }, { eq: { field: 'Name', value: 'other' } }] }
    let server: SeaTableMCPServer

    const find = async (args: Record<string, unknown>) => {
        const result = await callTool(server, 'find_rows', { table: 'Table1', ...args })
        return { result, text: result.content[0].text as string }
    }

    beforeAll(async () => {
        server = buildServer()
        await callTool(server, 'add_row', { table: 'Table1', row: { Name: NAME } })
    })

    it('reads a JSON string like the object it contains', async () => {
        const { result, text } = await find({ where: JSON.stringify(where) })
        expect(result.isError).toBeUndefined()
        expect(JSON.parse(text).total).toBe(1)
    })

    it('reads JSON strings nested in a condition', async () => {
        const { text } = await find({ where: { or: [JSON.stringify(where.or[0])] } })
        expect(JSON.parse(text).total).toBe(1)
    })

    it.each([
        ['text that is no JSON', 'Name = foo'],
        ['an empty string', ''],
        ['a JSON string holding no object', '5'],
        ['a number', 5],
        ['a boolean', false],
    ])('reports %s as an error instead of finding nothing', async (_label, value) => {
        const { result, text } = await find({ where: value })
        expect(result.isError).toBe(true)
        expect(JSON.parse(text)).toContain('where must be an object, e.g. {"eq":{"field":"Name","value":"foo"}}')
        // Logged as the caller's mistake, not as a server error
        expect(() => normalizeWhere(value)).toThrowError(expect.objectContaining({ code: 'ERR_VALIDATION' }))
    })

    it('still returns all rows without a where', async () => {
        for (const args of [{}, { where: null }]) {
            const { result, text } = await find(args)
            expect(result.isError).toBeUndefined()
            expect(JSON.parse(text).total).toBeGreaterThan(0)
        }
    })

    it('still finds nothing when no row matches', async () => {
        const { result, text } = await find({ where: { eq: { field: 'Name', value: 'no such name' } } })
        expect(result.isError).toBeUndefined()
        expect(JSON.parse(text).total).toBe(0)
    })

    it('normalizeWhere treats a JSON string like its object', () => {
        expect(normalizeWhere(JSON.stringify({ Name: 'foo' }))).toEqual(normalizeWhere({ Name: 'foo' }))
    })
})

// A malformed filter or an unknown column used to match no row without a word.
describe('find_rows with a filter it cannot apply', () => {
    const table = 'Table1'
    let server: SeaTableMCPServer

    const find = async (args: Record<string, unknown>) => {
        const result = await callTool(server, 'find_rows', { table, ...args })
        return { result, text: JSON.parse(result.content[0].text) }
    }

    beforeAll(async () => {
        server = buildServer()
        await callTool(server, 'add_row', { table, row: { Name: 'filter-check' } })
    })

    it.each([
        ['an unknown operator', { column: 'Name', op: 'matches', value: 'x' }, 'matches'],
        ['an unknown operator in MongoDB style', { Name: { $regex: 'x' } }, 'regex'],
        ['two operators at once', { eq: { field: 'Name', value: 'x' }, ne: { field: 'Name', value: 'y' } }, 'one operator'],
        ['a condition without a field', { eq: { value: 'x' } }, 'field'],
        ['a condition that is no object', { eq: 'x' }, 'field'],
        ['a comparison without a value', { eq: { field: 'Name' } }, 'value'],
        ['in without a list', { in: { field: 'Name', values: 'x' } }, 'values'],
        ['or without conditions', { or: [] }, 'or'],
        ['or that is no list', { or: { eq: { field: 'Name', value: 'x' } } }, 'or'],
        ['a malformed condition inside or', { or: [{ eq: { field: 'Name', value: 'x' } }, { gt: { value: 1 } }] }, 'field'],
        ['a malformed condition inside not', { not: { eq: { value: 'x' } } }, 'field'],
    ])('reports %s', async (_label, where, expected) => {
        const { result, text } = await find({ where })
        expect(result.isError).toBe(true)
        expect(text).toContain(expected)
        expect(() => normalizeWhere(where)).toThrowError(expect.objectContaining({ code: 'ERR_VALIDATION' }))
    })

    it.each([
        ['eq', { eq: { field: 'Nmae', value: 'x' } }],
        ['the shorthand', { Nmae: 'x' }],
        ['a nested condition', { and: [{ eq: { field: 'Name', value: 'filter-check' } }, { not: { is_null: { field: 'Nmae' } } }] }],
    ])('reports an unknown column in %s and names the existing ones', async (_label, where) => {
        const { result, text } = await find({ where })
        expect(result.isError).toBe(true)
        expect(text).toContain('Column "Nmae" not found in table "Table1"')
        expect(text).toContain('Name')
    })

    it('reports an unknown column in order_by', async () => {
        const { result, text } = await find({ order_by: 'Nmae' })
        expect(result.isError).toBe(true)
        expect(text).toContain('Column "Nmae" not found')
    })

    it.each([
        ['a system column', { is_null: { field: '_archived' } }],
        ['no conditions at all', {}],
        ['an empty list', []],
        ['the shorthand', { Name: 'filter-check' }],
        ['a value of null', { eq: { field: 'Name', value: null } }],
        ['operators in the column, op, value form', { column: 'Name', op: '!=', value: 'x' }],
    ])('accepts %s', async (_label, where) => {
        const { result } = await find({ where })
        expect(result.isError).toBeUndefined()
    })

    it('accepts a column only the rows know, as metadata is cached', async () => {
        const stale = new SeaTableMCPServer({
            getMetadata: async () => ({ tables: [{ name: table, columns: [{ name: 'Name' }] }] }),
            listRows: async () => ({ rows: [{ _id: 'row_1', Name: 'a', New: 'b' }] }),
        } as any)
        const result = await callTool(stale, 'find_rows', { table, where: { New: 'b' } })
        expect(result.isError).toBeUndefined()
        expect(JSON.parse(result.content[0].text).total).toBe(1)
    })

    it('leaves a table it does not know to the lookup of the rows', async () => {
        const result = await callTool(server, 'find_rows', { table: 'NoSuchTable', where: { Name: 'x' } })
        expect(result.isError).toBeUndefined()
    })
})

// Seen in production: a model passed the value of an auto-number column as row_id.
describe('tools that take a row ID', () => {
    const fakeServer = (error: Error) => {
        const fail = async () => { throw error }
        return new SeaTableMCPServer({ getRow: fail, downloadFile: fail, getRowActivities: fail } as any)
    }

    it.each([
        'get_row', 'update_rows', 'delete_rows', 'link_rows', 'unlink_rows',
        'get_row_activities', 'download_file', 'upload_file',
    ])('%s explains in its description what the ID is', (name) => {
        const tool = buildServer().getToolDefinitions().find((t) => t.name === name)!
        expect(tool.description).toContain('internal _id, not a column value')
        expect(tool.description).toContain('query_sql')
    })

    it.each([
        ['get_row', { table: 'T', row_id: 'D-0008' }],
        ['download_file', { table: 'T', column: 'File', row_id: 'D-0008' }],
    ])('%s explains how to find the _id when SeaTable does not know the row', async (name, args) => {
        const result = await callTool(fakeServer(makeError('ERR_BAD_REQUEST', 'row _id not exits')), name, args)
        expect(result.isError).toBe(true)
        const text = JSON.parse(result.content[0].text)
        expect(text).toContain('row _id not exits')
        expect(text).toContain('internal _id, not a column value')
        expect(text).toContain('query_sql')
    })

    it('leaves other errors as they are', async () => {
        const result = await callTool(fakeServer(makeError('ERR_RATE_LIMITED', 'Too many requests')), 'get_row', { table: 'T', row_id: 'abc' })
        expect(JSON.parse(result.content[0].text)).toBe('Error in tool get_row: Too many requests')
    })
})
