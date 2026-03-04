import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    query: z.record(z.any()).describe('Filter object with column name -> value pairs'),
})

export const registerSearchRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'search_rows',
        {
            title: 'Search Rows',
            description: 'Search rows with a filter object',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true },
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.searchRows(parsed.table, parsed.query)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
