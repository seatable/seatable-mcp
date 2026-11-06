import { z } from 'zod'

import { ToolRegistrar } from './types.js'
import { ROW_ID_NOTE } from './utils.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    row_id: z.string().describe('Row ID (the _id field)'),
})

export const registerGetRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'get_row',
        {
            title: 'Get Row',
            description: `Get a row by its ID. ${ROW_ID_NOTE}`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.getRow(parsed.table, parsed.row_id)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
