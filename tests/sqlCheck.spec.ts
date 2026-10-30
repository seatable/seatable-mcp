import { beforeAll, describe, expect, it } from 'vitest'

import { makeError } from '../src/errors'
import { buildServer, SeaTableMCPServer } from '../src/mcp/server'
import { registerQuerySql } from '../src/mcp/tools/querySql'
import { assertSupportedSql, functionHints, statementKind, stripLiterals } from '../src/mcp/tools/sqlCheck'

describe('stripLiterals', () => {
    it('neutralises strings, quoted identifiers and comments', () => {
        expect(stripLiterals("SELECT `Join Date` FROM `T` WHERE a = 'union' -- join\n")).toBe("SELECT `x` FROM `x` WHERE a = ''  \n")
        expect(stripLiterals('SELECT "a ""b"" (select" /* union */ FROM t')).toBe("SELECT ''   FROM t")
    })

    it('handles escaped quotes', () => {
        expect(stripLiterals("WHERE a = 'it\\'s (select' AND b = 'x''y'")).toBe("WHERE a = '' AND b = ''")
        expect(stripLiterals('SELECT `a``b` FROM t')).toBe('SELECT `x` FROM t')
    })
})

describe('statementKind', () => {
    it('detects the leading keyword', () => {
        expect(statementKind('  select * from t')).toBe('select')
        expect(statementKind('(SELECT 1)')).toBe('select')
        expect(statementKind('UPDATE `T` SET a = 1')).toBe('update')
        expect(statementKind('-- note\nDELETE FROM t')).toBe('delete')
        expect(statementKind('insert into t values (1)')).toBe('insert')
        expect(statementKind('DROP TABLE t')).toBe('other')
        expect(statementKind('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('other')
    })
})

describe('assertSupportedSql', () => {
    const rejects = (sql: string, fragment: string) => {
        expect(() => assertSupportedSql(sql)).toThrow(fragment)
    }

    it('rejects constructs outside SeaTable SQL', () => {
        rejects('SELECT * FROM `T` WHERE `Id` IN (SELECT `Id` FROM `U`)', 'Subqueries')
        rejects('SELECT a FROM t UNION SELECT a FROM u', 'UNION')
        rejects('SELECT * FROM t LEFT JOIN u ON t.a = u.a', 'JOIN')
        rejects('WITH x AS (SELECT 1) SELECT * FROM x', 'WITH')
        rejects('SELECT a, ROW_NUMBER() OVER (ORDER BY a) FROM t', 'Window functions')
        rejects('UPDATE t SET a = 1; DELETE FROM t', 'one statement')
    })

    it('uses the ERR_VALIDATION code', () => {
        try {
            assertSupportedSql('SELECT * FROM t JOIN u')
            expect.unreachable()
        } catch (err: any) {
            expect(err.code).toBe('ERR_VALIDATION')
        }
    })

    it('accepts supported queries, including keywords inside literals', () => {
        expect(() => assertSupportedSql('SELECT `Join Date`, `Union` FROM `T1`, `T2` WHERE `T1`.`a` = `T2`.`a`')).not.toThrow()
        expect(() => assertSupportedSql("SELECT * FROM t WHERE `Note` = '(select x); union join'")).not.toThrow()
        expect(() => assertSupportedSql('SELECT * FROM t WHERE a IN (?, ?) LIMIT 10;')).not.toThrow()
        expect(() => assertSupportedSql('SELECT Status, COUNT(*) FROM Tasks GROUP BY Status')).not.toThrow()
    })
})

describe('functionHints', () => {
    it('names the SeaTable replacement for MySQL functions', () => {
        expect(functionHints('SELECT SUBSTRING(a, 1, 2), CONCAT(a, b) FROM t')).toEqual([
            expect.stringContaining('mid('),
            expect.stringContaining('concatenate('),
        ])
        expect(functionHints('SELECT CASE WHEN a > 1 THEN 1 ELSE 0 END FROM t')[0]).toContain('ifs(')
        expect(functionHints('SELECT COALESCE(a, 0) FROM t')[0]).toContain('do not exist')
    })

    it('ignores SeaTable functions and names inside literals', () => {
        expect(functionHints("SELECT mid(a, 1, 2), len(b) FROM t WHERE c = 'concat(x)'")).toEqual([])
    })
})

describe('SQL tools', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_API_TOKEN = 'test-token'
        process.env.SEATABLE_MOCK = 'true'
        server = buildServer()
    })

    const callTool = (name: string, args: Record<string, unknown>) =>
        (server as any).handleCallTool({ params: { name, arguments: args } })
    const errorText = (result: any) => JSON.parse(result.content[0].text) as string

    it('annotates query_sql as read-only and execute_sql as destructive', () => {
        const tools = server.getToolDefinitions()
        expect(tools.find(t => t.name === 'query_sql')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
        expect(tools.find(t => t.name === 'execute_sql')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    })

    it('query_sql runs SELECT', async () => {
        const result = await callTool('query_sql', { sql: 'SELECT * FROM `Table1`' })
        expect(result.isError).toBeUndefined()
    })

    it('query_sql points writes at execute_sql', async () => {
        const result = await callTool('query_sql', { sql: 'UPDATE `Table1` SET `Name` = ?', parameters: ['x'] })
        expect(result.isError).toBe(true)
        expect(errorText(result)).toContain('Use execute_sql')
    })

    it('execute_sql runs UPDATE and DELETE', async () => {
        for (const sql of ['UPDATE `Table1` SET `Name` = ? WHERE `Name` = ?', 'DELETE FROM `Table1` WHERE `Name` = ?']) {
            const result = await callTool('execute_sql', { sql, parameters: ['a', 'b'].slice(0, sql.split('?').length - 1) })
            expect(result.isError).toBeUndefined()
        }
    })

    it('execute_sql points reads at query_sql', async () => {
        const result = await callTool('execute_sql', { sql: 'SELECT * FROM `Table1`' })
        expect(result.isError).toBe(true)
        expect(errorText(result)).toContain('Use query_sql')
    })

    it('execute_sql refuses other statements', async () => {
        const result = await callTool('execute_sql', { sql: 'DROP TABLE `Table1`' })
        expect(result.isError).toBe(true)
        expect(errorText(result)).toContain('only runs UPDATE, DELETE or INSERT')
    })

    it('rejects unsupported constructs before calling SeaTable', async () => {
        const result = await callTool('query_sql', { sql: 'SELECT * FROM `Table1` WHERE `Name` IN (SELECT `Name` FROM `Table2`)' })
        expect(result.isError).toBe(true)
        expect(errorText(result)).toContain('Subqueries are not supported')
    })

    it('appends function hints when SeaTable rejects a query', async () => {
        let handler: (args: unknown) => Promise<unknown> = async () => undefined
        const client = {
            querySql: async () => { throw makeError('ERR_BAD_REQUEST', 'ERR_BAD_REQUEST: invalid function') },
        }
        registerQuerySql(
            { registerTool: (_name: string, _config: unknown, h: typeof handler) => { handler = h } },
            { client: client as any, env: {} as any, getInputSchema: (s: unknown) => s },
        )
        await expect(handler({ sql: 'SELECT SUBSTRING(`Name`, 1, 3) FROM `T`' })).rejects.toMatchObject({
            code: 'ERR_BAD_REQUEST',
            message: expect.stringContaining('Hint: use mid(str, pos, len)'),
        })
    })
})
