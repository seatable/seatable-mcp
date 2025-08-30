import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string(),
    rowId: z.string(),
})

export const registerGetRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'get_row',
        {
            title: 'Get Row',
            description: 'Get a row by ID from a table',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.getRow(parsed.table, parsed.rowId)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
