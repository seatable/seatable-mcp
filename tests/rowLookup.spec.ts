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
        ['an unknown operator as the key', { matches: { field: 'Name', value: 'x' } }, 'unknown operator "matches"'],
        ['an unknown operator with column', { matches: { column: 'Name', value: 'x' } }, 'unknown operator "matches"'],
        ['a condition without a field', { eq: { value: 'x' } }, 'field'],
        ['a condition that is no object', { eq: 'x' }, 'field'],
        ['a comparison without a value', { eq: { field: 'Name' } }, 'value'],
        ['an object as the value', { Name: { foo: 'bar' } }, '"Name" needs a single value'],
        ['a list as the value of gt', { gt: { field: 'Name', value: [1, 2] } }, 'single value'],
        ['or without conditions', { or: [] }, 'or'],
        ['or that is no list', { or: 'x' }, 'or'],
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

// What a model clearly means gets repaired: a filter of the wrong shape otherwise
// costs a round, or matches nothing without a word.
describe('find_rows repairing a filter', () => {
    const rows = [
        { _id: 'a', Name: 'x', Betrag: 5 },
        { _id: 'b', Name: 'y', Betrag: 10 },
        { _id: 'c', Name: 'z', Betrag: null },
    ]
    const ids = (where: unknown) => rows.filter((r) => evalWhere(r, normalizeWhere(where))).map((r) => r._id)

    it.each<[string, unknown, string[]]>([
        ['an operator object under the column', { Name: { eq: 'x' } }, ['a']],
        ['the same in MongoDB style', { Name: { $eq: 'x' } }, ['a']],
        ['several operators under a column', { Betrag: { gt: 1, lt: 8 } }, ['a']],
        ['several in MongoDB style', { Betrag: { $gt: 1, $lt: 8 } }, ['a']],
        ['a symbol under the column', { Betrag: { '>': 7 } }, ['b']],
        ['column instead of field', { eq: { column: 'Name', value: 'x' } }, ['a']],
        ['name instead of field', { eq: { name: 'Name', value: 'x' } }, ['a']],
        ['the column as the key', { eq: { Name: 'x' } }, ['a']],
        ['several columns as keys', { eq: { Name: 'x', Betrag: 5 } }, ['a']],
        ['a field and value pair', { eq: ['Name', 'x'] }, ['a']],
        ['a symbol as the operator', { '=': { field: 'Name', value: 'x' } }, ['a']],
        ['upper case', { EQ: { field: 'Name', value: 'x' } }, ['a']],
        ['a dollar', { $eq: { field: 'Name', value: 'x' } }, ['a']],
        ['a word as the operator', { equals: { field: 'Name', value: 'x' } }, ['a']],
        ['startswith', { startswith: { field: 'Name', value: 'x' } }, ['a']],
        ['two operators at once', { gt: { field: 'Betrag', value: 1 }, lt: { field: 'Betrag', value: 8 } }, ['a']],
        ['an operator next to a column', { gt: { field: 'Betrag', value: 1 }, Name: 'x' }, ['a']],
        ['or with an object', { or: { Name: 'x', Betrag: 10 } }, ['a', 'b']],
        ['or with one condition', { or: { eq: { field: 'Name', value: 'x' } } }, ['a']],
        ['and with an object', { and: { Name: 'x', Betrag: 5 } }, ['a']],
        ['not with a list', { not: [{ Name: 'x' }, { Betrag: 5 }] }, ['b', 'c']],
        ['a list under the column', { Name: ['x', 'y'] }, ['a', 'b']],
        ['in with one value', { in: { field: 'Name', values: 'x' } }, ['a']],
        ['in with value', { in: { field: 'Name', value: ['x', 'y'] } }, ['a', 'b']],
        ['in with the column as the key', { in: { Name: ['x', 'y'] } }, ['a', 'b']],
        ['eq with a list', { eq: { field: 'Name', value: ['x', 'y'] } }, ['a', 'b']],
        ['ne with a list', { ne: { field: 'Name', value: ['x', 'y'] } }, ['c']],
        ['not_in', { not_in: { field: 'Name', values: ['x', 'y'] } }, ['c']],
        ['$nin under the column', { Name: { $nin: ['x', 'y'] } }, ['c']],
        ['is_null with a column name', { is_null: 'Betrag' }, ['c']],
        ['is_null with column', { is_null: { column: 'Betrag' } }, ['c']],
        ['is_not_null', { is_not_null: { field: 'Betrag' } }, ['a', 'b']],
        ['the column, op, value form with not_in', { column: 'Name', op: 'not_in', value: ['x'] }, ['b', 'c']],
        ['the column, op, value form with null', { column: 'Betrag', op: '=', value: null }, ['c']],
        ['a repair nested in or', { or: [{ Name: { eq: 'x' } }, { eq: { column: 'Name', value: 'y' } }] }, ['a', 'b']],
        ['field and value without an operator', { field: 'Name', value: 'x' }, ['a']],
    ])('reads %s', (_label, where, expected) => {
        expect(ids(where)).toEqual(expected)
    })

    it('takes a word that only looks like an operator as a column if its value is no filter', () => {
        const row = { _id: 'r', Like: 'yes', Null: 'no' }
        expect(evalWhere(row, normalizeWhere({ Like: 'yes' }))).toBe(true)
        expect(evalWhere(row, normalizeWhere({ Null: 'no' }))).toBe(true)
    })

    describe('column names', () => {
        const server = () => new SeaTableMCPServer({
            getMetadata: async () => ({ tables: [{ name: 'T', columns: [{ name: 'Betrag' }, { name: 'Name' }, { name: 'name2' }, { name: 'Doppelt' }, { name: 'doppelt' }] }] }),
            listRows: async () => ({ rows: [{ _id: 'a', Betrag: 5, Name: 'x' }, { _id: 'b', Betrag: 7, Name: 'y' }] }),
        } as any)
        const find = async (args: Record<string, unknown>) => {
            const result = await callTool(server(), 'find_rows', { table: 'T', ...args })
            return { result, data: JSON.parse(result.content[0].text) }
        }

        it('corrects the case of a column and says so', async () => {
            const { result, data } = await find({ where: { betrag: 5 } })
            expect(result.isError).toBeUndefined()
            expect(data.total).toBe(1)
            expect(data.notice).toContain('"betrag"')
            expect(data.notice).toContain('"Betrag"')
        })

        it('removes SQL quotes around a column', async () => {
            const { data } = await find({ where: { '`Betrag`': 5 } })
            expect(data.total).toBe(1)
        })

        it('corrects a nested column and the sort column', async () => {
            const { data } = await find({ where: { or: [{ betrag: 5 }, { not: { NAME: 'x' } }] }, order_by: 'BETRAG', direction: 'desc' })
            expect(data.rows.map((r: any) => r._id)).toEqual(['b', 'a'])
        })

        it('adds no notice when nothing was corrected', async () => {
            const { data } = await find({ where: { Betrag: 5 } })
            expect(data).not.toHaveProperty('notice')
        })

        it('does not guess between two columns or at a typo', async () => {
            for (const where of [{ DOPPELT: 'x' }, { Nmae: 'x' }]) {
                const { result, data } = await find({ where })
                expect(result.isError).toBe(true)
                expect(data).toContain('not found in table "T"')
            }
        })
    })
})

// On a real base, Datum >= "01.08.2026" returned every row with a date: as text,
// "2026-07-13" is greater than "01.08.2026".
describe('find_rows with a date in another format', () => {
    const server = () => new SeaTableMCPServer({
        getMetadata: async () => ({
            tables: [{
                name: 'T',
                columns: [{ name: 'Datum', type: 'date' }, { name: 'Geändert', type: 'mtime' }, { name: 'Code', type: 'text' }],
            }],
        }),
        listRows: async () => ({
            rows: [
                { _id: 'a', Datum: '2026-07-13', 'Geändert': '2026-07-13T10:00:00+02:00', Code: '01.08.2026' },
                { _id: 'b', Datum: '2026-08-13', 'Geändert': '2026-08-13T10:00:00+02:00', Code: 'x' },
            ],
        }),
    } as any)
    const find = async (where: unknown) => {
        const result = await callTool(server(), 'find_rows', { table: 'T', where })
        return { result, data: JSON.parse(result.content[0].text) }
    }

    it.each<[string, unknown, string]>([
        ['gte with a German date', { gte: { field: 'Datum', value: '01.08.2026' } }, '01.08.2026'],
        ['eq with a German date', { eq: { field: 'Datum', value: '13.07.2026' } }, '13.07.2026'],
        ['ne with a German date', { ne: { field: 'Datum', value: '13.07.2026' } }, '13.07.2026'],
        ['a short year', { lt: { field: 'Datum', value: '1.8.26' } }, '1.8.26'],
        ['slashes', { gt: { field: 'Datum', value: '08/01/2026' } }, '08/01/2026'],
        ['dashes, day first', { gt: { field: 'Datum', value: '01-08-2026' } }, '01-08-2026'],
        ['a list for in', { in: { field: 'Datum', values: ['2026-07-13', '13.07.2026'] } }, '13.07.2026'],
        ['a nested condition', { or: [{ Code: 'x' }, { not: { lt: { field: 'Datum', value: '01.08.2026' } } }] }, '01.08.2026'],
        ['a column with a corrected name', { gte: { field: 'datum', value: '01.08.2026' } }, '01.08.2026'],
        ['a modification time column', { gte: { field: 'Geändert', value: '01.08.2026' } }, '01.08.2026'],
    ])('reports %s and names the format', async (_label, where, value) => {
        const { result, data } = await find(where)
        expect(result.isError).toBe(true)
        expect(data).toContain('YYYY-MM-DD')
        expect(data).toContain(value)
    })

    it.each<[string, unknown, number]>([
        ['an ISO date', { gte: { field: 'Datum', value: '2026-08-01' } }, 1],
        ['an ISO date with a time', { gte: { field: 'Geändert', value: '2026-08-01T00:00:00' } }, 1],
        ['such a text in a text column', { eq: { field: 'Code', value: '01.08.2026' } }, 1],
        ['is_null on a date column', { is_null: { field: 'Datum' } }, 0],
    ])('accepts %s', async (_label, where, total) => {
        const { result, data } = await find(where)
        expect(result.isError).toBeUndefined()
        expect(data.total).toBe(total)
    })
})

// The API returns dates as 2026-08-05T00:00:00+02:00. As text, that never equals
// 2026-08-05 and is greater than it, which moved every boundary by a day.
describe('find_rows comparing a date with a date cell', () => {
    const row = { _id: 'r', Datum: '2026-08-05T00:00:00+02:00', Zeit: '2026-08-05T23:30:00.5+02:00', Text: 'abc' }
    const matches = (op: string, field: string, value: unknown) => evalWhere(row, { [op]: { field, value } })

    it.each<[string, string, boolean]>([
        ['eq', '2026-08-05', true],
        ['eq', '2026-08-04', false],
        ['ne', '2026-08-05', false],
        ['ne', '2026-08-04', true],
        ['gt', '2026-08-05', false],
        ['gt', '2026-08-04', true],
        ['gte', '2026-08-05', true],
        ['gte', '2026-08-06', false],
        ['lt', '2026-08-05', false],
        ['lt', '2026-08-06', true],
        ['lte', '2026-08-05', true],
        ['lte', '2026-08-04', false],
    ])('%s %s is %s', (op, value, expected) => {
        expect(matches(op, 'Datum', value)).toBe(expected)
        expect(matches(op, 'Zeit', value)).toBe(expected)
    })

    it('in compares the same way', () => {
        expect(evalWhere(row, { in: { field: 'Datum', values: ['2026-01-01', '2026-08-05'] } })).toBe(true)
    })

    it('leaves a time in the filter and other text as they are', () => {
        expect(matches('gt', 'Zeit', '2026-08-05T23:00')).toBe(true)
        expect(matches('lt', 'Zeit', '2026-08-05T23:00')).toBe(false)
        expect(matches('eq', 'Text', '2026-08-05')).toBe(false)
    })
})

// SeaTable returns the number of rows it deleted, also 0 for IDs it doesn't know.
describe('delete_rows reporting what happened', () => {
    const del = async (answer: unknown, rowIds: string[]) => {
        const server = new SeaTableMCPServer({ deleteRows: async () => answer } as any)
        return JSON.parse((await callTool(server, 'delete_rows', { table: 'T', row_ids: rowIds })).content[0].text)
    }

    it('reports success if all rows were deleted', async () => {
        expect(await del({ deleted_rows: 2 }, ['a', 'b'])).toEqual({ success: true, deleted_count: 2 })
    })

    it('does not report success for IDs that match no row', async () => {
        const data = await del({ deleted_rows: 0 }, ['D-0008', 'D-0009'])
        expect(data.success).toBe(false)
        expect(data.deleted_count).toBe(0)
        expect(data.notice).toContain('2 of 2')
        expect(data.notice).toContain('internal _id, not a column value')
    })

    it('reports a partial deletion', async () => {
        const data = await del({ deleted_rows: 1 }, ['a', 'D-0008'])
        expect(data.success).toBe(false)
        expect(data.deleted_count).toBe(1)
        expect(data.notice).toContain('1 of 2')
    })

    it('trusts the call if SeaTable reports no count', async () => {
        expect(await del({ success: true }, ['a'])).toEqual({ success: true, deleted_count: 1 })
    })
})

// SeaTable answers success with a count of 0 for IDs it doesn't know.
describe('unlink_rows reporting what happened', () => {
    const unlink = async (answer: unknown) => {
        const server = new SeaTableMCPServer({ deleteLinks: async () => answer } as any)
        const result = await callTool(server, 'unlink_rows', { table: 'T', link_column: 'L', pairs: [{ from_row_id: 'a', to_row_id: 'b' }] })
        return JSON.parse(result.content[0].text)
    }

    it('does not report success if no link was removed', async () => {
        const data = await unlink({ deleted_links_count: 0, success: true })
        expect(data.success).toBe(false)
        expect(data.deleted_links_count).toBe(0)
        expect(data.notice).toContain('internal _id, not a column value')
    })

    it('leaves a removal as it is', async () => {
        expect(await unlink({ deleted_links_count: 1, success: true })).toEqual({ deleted_links_count: 1, success: true })
    })
})

// On a real base, Betrag < 10 also returned the rows without a Betrag.
describe('find_rows ordering empty cells', () => {
    const cond = (op: string, value: unknown, cell: unknown = null) => evalWhere({ _id: 'r', A: cell }, { [op]: { field: 'A', value } })

    it.each(['gt', 'gte', 'lt', 'lte'])('%s never matches an empty cell', (op) => {
        for (const value of [10, '10', 'abc', '2026-01-01']) {
            expect(cond(op, value, null)).toBe(false)
            expect(cond(op, value, undefined)).toBe(false)
            expect(cond(op, value, '')).toBe(false)
        }
    })

    it.each(['gt', 'gte', 'lt', 'lte'])('%s against null matches nothing', (op) => {
        expect(cond(op, null, 5)).toBe(false)
        expect(cond(op, null, null)).toBe(false)
    })

    it('still orders filled cells and finds empty ones with is_null and eq', () => {
        expect(cond('lt', 10, 5)).toBe(true)
        expect(cond('gte', 0, 0)).toBe(true)
        expect(evalWhere({ _id: 'r', A: null }, { is_null: { field: 'A' } })).toBe(true)
        expect(cond('eq', null, null)).toBe(true)
        expect(cond('ne', 10, null)).toBe(true)
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

    // SeaTable's wording differs per endpoint, all seen on a real base
    it.each(['ERR_BAD_REQUEST: row _id not exits', 'ERR_BAD_REQUEST: row not found', 'ERR_BAD_REQUEST: Row does not exist.', 'ERR_BAD_REQUEST: param row_ids invalid'])(
        'adds the note to "%s"', async (message) => {
            const result = await callTool(fakeServer(makeError('ERR_BAD_REQUEST', message)), 'get_row', { table: 'T', row_id: 'x' })
            const text = JSON.parse(result.content[0].text)
            expect(text).toContain(message.replace(/\.$/, ''))
            expect(text).toContain('internal _id, not a column value')
        }
    )

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
