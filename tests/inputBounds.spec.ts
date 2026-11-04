import { beforeAll, describe, expect, it } from 'vitest'

import { buildServer, SeaTableMCPServer } from '../src/mcp/server'

/*
 * Zod collects one issue per failing element, so an unbounded array turns a
 * request body into many times its size in issue objects. A single 10 MB call
 * killed the process this way. Zod 4 checks .max() before it parses elements,
 * but only where a bound is declared, so every array a caller controls needs one.
 */

const callTool = (server: SeaTableMCPServer, name: string, args: Record<string, unknown>) =>
    (server as any).handleCallTool({ params: { name, arguments: args } })

const select = { table: 'Table1', column: 'Status' }

const OVERSIZED: Array<[string, string, (n: number) => Record<string, unknown>]> = [
    ['query_sql', 'parameters', (n) => ({ sql: 'SELECT 1', parameters: new Array(n).fill({}) })],
    ['execute_sql', 'parameters', (n) => ({ sql: 'DELETE FROM `T`', parameters: new Array(n).fill({}) })],
    ['upsert_rows', 'key_columns', (n) => ({ table: 'T', key_columns: new Array(n).fill(0), rows: [{ a: 1 }] })],
    ['add_select_options', 'options', (n) => ({ ...select, options: new Array(n).fill(0) })],
    ['append_rows', 'rows', (n) => ({ table: 'T', rows: new Array(n).fill(0) })],
]

describe('tool input arrays are bounded', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_API_TOKEN = 'test-token'
        process.env.SEATABLE_MOCK = 'true'
        server = buildServer()
    })

    it.each(OVERSIZED)('%s rejects an oversized %s with one short error', async (tool, field, args) => {
        const result = await callTool(server, tool, args(200_000))

        expect(result.isError).toBe(true)
        const text = result.content[0].text as string
        expect(text).toContain(field)
        // One issue about the size, not one per element.
        expect(text.length).toBeLessThan(2_000)
    })

    it.each(OVERSIZED.slice(0, 2))('%s still accepts a normal number of %s', async (tool, _field, _args) => {
        const sql = tool === 'query_sql' ? 'SELECT * FROM `Table1` WHERE `Name` = ?' : 'DELETE FROM `Table1` WHERE `Name` = ?'
        const result = await callTool(server, tool, { sql, parameters: ['a'] })

        expect(result.isError).toBeFalsy()
    })
})
