import { z } from 'zod'

import { runSql, SQL_SYNTAX_RULES } from './sqlCheck.js'
import { ToolRegistrar } from './types.js'
import { cleanSqlMetadata } from './utils.js'

const InputSchema = z.object({
    sql: z.string().describe('SELECT statement').refine(sql => sql.trim().length > 0, 'SQL query cannot be empty'),
    parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Values for ? placeholders in the SQL query'),
})

export const registerQuerySql: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'query_sql',
        {
            title: 'Query SQL',
            description: `Run a read-only SELECT query against SeaTable. Use ? placeholders for parameters. To change data with SQL, use execute_sql.

${SQL_SYNTAX_RULES}

SELECT rules:
- Returns max 100 rows by default. Use LIMIT to get more (up to 10,000).
- Aliases (AS) can be used in GROUP BY, HAVING, ORDER BY — but NOT in WHERE.
- Joins: FROM \`T1\`, \`T2\` WHERE \`T1\`.\`col\` = \`T2\`.\`col\` (inner joins only).

If a query is rejected, find_rows offers client-side filtering as an alternative.`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { sql, parameters } = InputSchema.parse(args)
            const result = await runSql('query_sql', sql, () => client.querySql(sql, parameters))
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
