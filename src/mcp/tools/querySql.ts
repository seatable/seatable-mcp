import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    sql: z.string().refine(sql => sql.trim().length > 0, 'SQL query cannot be empty'),
    parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
})

export const registerQuerySql: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'query_sql',
        {
            title: 'Query SQL',
            description: 'Execute raw SQL queries against SeaTable. Supports SELECT, INSERT, UPDATE, DELETE. Use ? placeholders for parameters to prevent SQL injection.',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const { sql, parameters } = InputSchema.parse(args)
            const result = await client.querySql(sql, parameters)
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        metadata: result.metadata,
                        results: result.results,
                        query: sql,
                        parameters: parameters || [],
                    }),
                }],
            }
        }
    )
}
