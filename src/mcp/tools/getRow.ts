import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    row_id: z.string().describe('Row ID (the _id field)'),
})

export const registerGetRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'get_row',
        {
            title: 'Get Row',
            description: 'Get a row by ID from a table',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true },
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.getRow(parsed.table, parsed.row_id)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
