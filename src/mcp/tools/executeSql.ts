import { z } from 'zod'

import { makeError } from '../../errors.js'
import { assertSupportedSql, SQL_SYNTAX_RULES, statementKind, withSqlHints } from './sqlCheck.js'
import { ToolRegistrar } from './types.js'
import { cleanSqlMetadata } from './utils.js'

const InputSchema = z.object({
    sql: z.string().describe('UPDATE, DELETE or INSERT statement').refine(sql => sql.trim().length > 0, 'SQL statement cannot be empty'),
    parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Values for ? placeholders in the SQL statement'),
})

export const registerExecuteSql: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'execute_sql',
        {
            title: 'Execute SQL',
            description: `Run an UPDATE, DELETE or INSERT statement against SeaTable. Changes many rows in one call, e.g. UPDATE \`T\` SET \`Status\` = ? WHERE \`Done\` = true. Use ? placeholders for parameters. For reading data, use query_sql.

${SQL_SYNTAX_RULES}

UPDATE limitations:
- SET only accepts literal values (strings, numbers, booleans). No functions (date(), now(), upper()…) and no expressions (Amount + 10) allowed.
- Columns not updatable via SQL: image, file, formula, link, link-formula, geolocation, auto-number, digital-sign, button. Use update_rows or link_rows for those.

INSERT only works with Big Data storage enabled (Enterprise). For non-archived tables, use append_rows instead.`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async (args: unknown) => {
            const { sql, parameters } = InputSchema.parse(args)
            assertSupportedSql(sql)
            const kind = statementKind(sql)
            if (kind === 'select') {
                throw makeError('ERR_VALIDATION', 'execute_sql does not run SELECT statements. Use query_sql to read data.')
            }
            if (kind === 'other') {
                throw makeError('ERR_VALIDATION', 'execute_sql only runs UPDATE, DELETE or INSERT statements.')
            }
            const result = await withSqlHints(sql, () => client.querySql(sql, parameters))
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        metadata: cleanSqlMetadata(result.metadata),
                        results: result.results,
                    }),
                }],
            }
        }
    )
}
