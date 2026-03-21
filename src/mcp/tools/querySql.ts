import { z } from 'zod'

import { ToolRegistrar } from './types.js'
import { cleanSqlMetadata } from './utils.js'

const InputSchema = z.object({
    sql: z.string().describe('SQL query (SELECT, INSERT, UPDATE, DELETE)').refine(sql => sql.trim().length > 0, 'SQL query cannot be empty'),
    parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Values for ? placeholders in the SQL query'),
})

export const registerQuerySql: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'query_sql',
        {
            title: 'Query SQL',
            description: `Execute SQL queries against SeaTable (SELECT, UPDATE, DELETE, INSERT). Use ? placeholders for parameters.

Syntax rules:
- Quote table/column names with backticks: \`Table Name\`, \`Column Name\` (not double quotes). Required for names with spaces, hyphens, or names matching function names.
- SELECT returns max 100 rows by default. Use LIMIT to get more (up to 10,000).
- Aliases (AS) can be used in GROUP BY, HAVING, ORDER BY — but NOT in WHERE.
- ORDER BY columns must appear in the SELECT field list.
- No JOIN keyword. Use implicit joins: FROM \`T1\`, \`T2\` WHERE \`T1\`.\`col\` = \`T2\`.\`col\`. Only inner joins are supported.
- No subqueries, no UNION/UNION ALL.
- Empty strings are treated as NULL. Use IS NULL / IS NOT NULL instead of = "".
- Use ILIKE for case-insensitive matching (LIKE is case-sensitive).
- For multi-select/collaborator columns use: HAS ANY OF, HAS ALL OF, HAS NONE OF, IS EXACTLY (values in parentheses like IN).

UPDATE limitations:
- SET only accepts literal values (strings, numbers, booleans). No functions (date(), now(), upper()…) and no expressions (Amount + 10) allowed.
- Columns not updatable via SQL: image, file, formula, link, link-formula, geolocation, auto-number, digital-sign, button.

INSERT only works with Big Data storage enabled (Enterprise). For non-archived tables, use append_rows instead.

If a query fails, do not retry with similar syntax. Switch to an alternative tool (e.g. update_rows, find_rows) instead.`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async (args: unknown) => {
            const { sql, parameters } = InputSchema.parse(args)
            const result = await client.querySql(sql, parameters)
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
