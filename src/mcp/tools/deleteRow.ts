import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    row_ids: z.array(z.string()).min(1).max(100).describe('List of row IDs (_id field) to delete'),
})

export const registerDeleteRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'delete_rows',
        {
            title: 'Delete Rows',
            description: 'Delete one or more rows from a table by their IDs.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { table, row_ids } = InputSchema.parse(args)
            await client.deleteRows(table, row_ids)
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted_count: row_ids.length }) }] }
        }
    )
}
