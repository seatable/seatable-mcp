import { beforeAll, describe, expect, it, vi } from 'vitest'

import { makeError } from '../src/errors'
import { buildServer, SeaTableMCPServer } from '../src/mcp/server'
import { evalWhere, normalizeWhere } from '../src/mcp/tools/findRows'

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

// Weaker models send values as text. Comparing them as text gave wrong results,
// not just missing ones: "9.49" is greater than "10".
describe('find_rows comparing values of different types', () => {
    const row = { _id: 'r', Betrag: 9.49, Nummer: '123', Null: null, Done: true }
    const matches = (where: any) => evalWhere(row, where)
    const cond = (op: string, field: string, value: unknown) => ({ [op]: { field, value } })

    it.each([
        ['eq', 'Betrag', '9.49', true],
        ['eq', 'Betrag', '9.5', false],
        ['ne', 'Betrag', '9.49', false],
        ['ne', 'Betrag', '9.5', true],
        ['gt', 'Betrag', '10', false],
        ['gt', 'Betrag', '9', true],
        ['gte', 'Betrag', '9.49', true],
        ['lt', 'Betrag', '10', true],
        ['lt', 'Betrag', '9', false],
        ['lte', 'Betrag', '9.49', true],
    ])('a number cell: %s %s %s is %s', (op, field, value, expected) => {
        expect(matches(cond(op, field, value))).toBe(expected)
    })

    it('in compares the same way', () => {
        expect(matches({ in: { field: 'Betrag', values: ['1', '9.49'] } })).toBe(true)
        expect(matches({ in: { field: 'Nummer', values: [1, 123] } })).toBe(true)
        expect(matches({ in: { field: 'Betrag', values: ['1', '2'] } })).toBe(false)
    })

    it.each(['9,49', 'abc', '', ' ', '0x10', '1e3', 'Infinity', '9.49 '])('does not read %j as a number', (value) => {
        expect(evalWhere({ _id: 'r', A: 16, B: 1000, C: 9.49 }, { or: ['A', 'B', 'C'].map((f) => cond('eq', f, value)) })).toBe(false)
        expect(matches(cond('gt', 'Betrag', value))).toBe(false)
        expect(matches(cond('lt', 'Betrag', value))).toBe(false)
    })

    it('a text cell matches a number only if the text is the same', () => {
        expect(matches(cond('eq', 'Nummer', 123))).toBe(true)
        expect(matches(cond('ne', 'Nummer', 123))).toBe(false)
        expect(evalWhere({ _id: 'r', Nummer: '0123' }, cond('eq', 'Nummer', 123))).toBe(false)
        expect(evalWhere({ _id: 'r', Nummer: 'abc' }, cond('eq', 'Nummer', 123))).toBe(false)
    })

    it('a text cell with a number is ordered as a number', () => {
        expect(matches(cond('gt', 'Nummer', 99))).toBe(true)
        expect(matches(cond('lt', 'Nummer', 99))).toBe(false)
        expect(evalWhere({ _id: 'r', Nummer: 'abc' }, cond('gt', 'Nummer', 99))).toBe(false)
    })

    it('a checkbox cell matches the words true and false', () => {
        expect(matches(cond('eq', 'Done', 'true'))).toBe(true)
        expect(matches(cond('eq', 'Done', 'false'))).toBe(false)
        expect(matches(cond('ne', 'Done', 'false'))).toBe(true)
        expect(matches(cond('eq', 'Done', 'yes'))).toBe(false)
    })

    it('values of the same type behave as before', () => {
        expect(matches(cond('eq', 'Betrag', 9.49))).toBe(true)
        expect(matches(cond('gt', 'Betrag', 10))).toBe(false)
        expect(matches(cond('eq', 'Nummer', '123'))).toBe(true)
        expect(matches(cond('gt', 'Nummer', '1'))).toBe(true)
        expect(matches(cond('eq', 'Null', null))).toBe(true)
        expect(matches(cond('eq', 'Null', 'null'))).toBe(false)
        expect(evalWhere({ _id: 'r', D: '2026-08-05' }, cond('gt', 'D', '2026-07-01'))).toBe(true)
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

    // An empty history looks the same for a wrong ID and for a row whose
    // activities are past SeaTable's retention period, which varies.
    describe('get_row_activities without activities', () => {
        const history = (overrides: Record<string, unknown>) => {
            const getRow = vi.fn(async () => ({ _id: 'row_1' }))
            const server = new SeaTableMCPServer({
                getRow,
                getRowActivities: async () => ({ activities: [], total_count: 0 }),
                ...overrides,
            } as any)
            return { getRow, call: () => callTool(server, 'get_row_activities', { table: 'T', row_id: 'row_1' }) }
        }

        it('reports a row that does not exist', async () => {
            const { call } = history({ getRow: async () => { throw makeError('ERR_BAD_REQUEST', 'row _id not exits') } })
            const result = await call()
            expect(result.isError).toBe(true)
            const text = JSON.parse(result.content[0].text)
            expect(text).toContain('row _id not exits')
            expect(text).toContain('internal _id, not a column value')
        })

        it('says that a row without activities may still have been changed, without naming a period', async () => {
            const { call } = history({})
            const result = await call()
            expect(result.isError).toBeUndefined()
            const data = JSON.parse(result.content[0].text)
            expect(data.activities).toEqual([])
            expect(data.total_count).toBe(0)
            expect(data.notice).toContain('limited time')
            expect(data.notice).toContain('does not mean')
            expect(data.notice).not.toMatch(/\d/)
        })

        it('does not look up the row or add a notice if there are activities', async () => {
            const { call, getRow } = history({
                getRowActivities: async () => ({ activities: [{ op_type: 'insert_row', detail: {} }], total_count: 1 }),
            })
            const data = JSON.parse((await call()).content[0].text)
            expect(getRow).not.toHaveBeenCalled()
            expect(data.total_count).toBe(1)
            expect(data).not.toHaveProperty('notice')
        })

        it('does not look up the row on an empty later page', async () => {
            const { call, getRow } = history({ getRowActivities: async () => ({ activities: [], total_count: 30 }) })
            const data = JSON.parse((await call()).content[0].text)
            expect(getRow).not.toHaveBeenCalled()
            expect(data).not.toHaveProperty('notice')
        })
    })

    it('leaves other errors as they are', async () => {
        const result = await callTool(fakeServer(makeError('ERR_RATE_LIMITED', 'Too many requests')), 'get_row', { table: 'T', row_id: 'abc' })
        expect(JSON.parse(result.content[0].text)).toBe('Error in tool get_row: Too many requests')
    })
})
