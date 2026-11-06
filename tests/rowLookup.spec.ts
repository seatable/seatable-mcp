import { beforeAll, describe, expect, it } from 'vitest'

import { makeError } from '../src/errors'
import { buildServer, SeaTableMCPServer } from '../src/mcp/server'
import { normalizeWhere } from '../src/mcp/tools/findRows'
import { registerGetRow } from '../src/mcp/tools/getRow'

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
    const where = { or: [{ eq: { field: 'Name', value: NAME } }, { eq: { field: 'Nummer', value: NAME } }] }
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

// Seen in production: a model passed the value of an auto-number column as row_id.
describe('get_row with something other than an _id', () => {
    const registered = (getRow: () => Promise<unknown>) => {
        let tool: { description: string; handler: (args: unknown) => Promise<unknown> } | undefined
        registerGetRow(
            { registerTool: (_name: string, config: any, handler: any) => { tool = { description: config.description, handler } } } as any,
            { client: { getRow }, env: {}, getInputSchema: (schema: unknown) => schema } as any,
        )
        return tool!
    }

    it('explains in its description what row_id is', () => {
        const { description } = registered(async () => ({}))
        expect(description).toContain('_id')
        expect(description).toContain('query_sql')
    })

    it('explains how to find the _id when SeaTable does not know the row', async () => {
        const { handler } = registered(async () => {
            throw makeError('ERR_BAD_REQUEST', 'row _id not exits')
        })
        const error: any = await handler({ table: 'T', row_id: 'D-0008' }).catch((e: unknown) => e)
        expect(error.code).toBe('ERR_BAD_REQUEST')
        expect(error.message).toContain('row _id not exits')
        expect(error.message).toContain('query_sql')
    })

    it('leaves other errors as they are', async () => {
        const { handler } = registered(async () => {
            throw makeError('ERR_RATE_LIMITED', 'Too many requests')
        })
        const error: any = await handler({ table: 'T', row_id: 'abc' }).catch((e: unknown) => e)
        expect(error.message).toBe('Too many requests')
    })
})
