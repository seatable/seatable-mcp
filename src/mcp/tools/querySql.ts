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
- Quote table/column names with backticks: \`Table Name\`, \`Column Name\` (not double quotes).
- SELECT returns max 100 rows by default. Use LIMIT to get more (up to 10,000).
- ORDER BY columns must appear in the SELECT field list.
- No JOIN keyword. Use implicit joins: FROM \`T1\`, \`T2\` WHERE \`T1\`.\`col\` = \`T2\`.\`col\`. Only inner joins are supported.
- No subqueries.
- Empty strings are treated as NULL. Use IS NULL / IS NOT NULL instead of = "".
- Date functions available in SELECT only: date(year, month, day), year(), month(), day(), dateAdd(), now(), today().

UPDATE limitations:
- SET only accepts literal values (strings, numbers, booleans). No functions (date(), now(), upper()…) and no expressions (Amount + 10) allowed.
- Columns not updatable via SQL: image, file, formula, link, link-formula, geolocation, auto-number, button. Use the dedicated tools (upload_file, link_rows) instead.

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
