import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string(),
    query: z.record(z.any()),
})

export const registerSearchRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'searchRows',
        {
            title: 'Search Rows',
            description: 'Search rows with a filter object',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.searchRows(parsed.table, parsed.query)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
