import { z } from 'zod'

import { runSql, SQL_SYNTAX_RULES, truncationNotice } from './sqlCheck.js'
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
- Returns only 100 rows unless you add LIMIT, so LIMIT 100 is no better than none. To read all rows use LIMIT 10000. Prefer COUNT, SUM and GROUP BY over reading rows to count or sum them yourself.
- Aliases (AS) can be used in GROUP BY, HAVING, ORDER BY — but NOT in WHERE.
- Joins: FROM \`T1\`, \`T2\` WHERE \`T1\`.\`col\` = \`T2\`.\`col\` (inner joins only).
- Link columns can't be a join condition: comparing them with another column never matches. Instead GROUP BY the link column (one row per linked row, shown by its display value), filter with \`Link\` = 'display value', or use the link column on the other table (SeaTable creates one on both sides), e.g. WHERE \`Orders\` IS NULL for rows without linked rows.

If a query is rejected, find_rows offers client-side filtering as an alternative.`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { sql, parameters } = InputSchema.parse(args)
            const result = await runSql('query_sql', sql, () => client.querySql(sql, parameters))
            const notice = truncationNotice(sql, result.results.length)
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ...(notice && { notice }),
                        metadata: cleanSqlMetadata(result.metadata),
                        results: result.results,
                    }),
                }],
            }
        }
    )
}
