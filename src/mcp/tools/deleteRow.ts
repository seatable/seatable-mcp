import { z } from 'zod'

import { ToolRegistrar } from './types.js'
import { ROW_ID_NOTE } from './utils.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    row_ids: z.array(z.string()).min(1).max(100).describe('List of row IDs (_id field) to delete'),
})

export const registerDeleteRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'delete_rows',
        {
            title: 'Delete Rows',
            description: `Delete one or more rows from a table by their IDs. ${ROW_ID_NOTE}`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { table, row_ids } = InputSchema.parse(args)
            const res = await client.deleteRows(table, row_ids)
            // SeaTable counts what it deleted, and answers 0 for IDs it doesn't know
            const deleted = res.deleted_rows ?? row_ids.length
            const notFound = row_ids.length - deleted
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: notFound === 0,
                        deleted_count: deleted,
                        ...(notFound > 0 && { notice: `${notFound} of ${row_ids.length} row IDs matched no row and nothing was deleted for them. ${ROW_ID_NOTE}` }),
                    }),
                }],
            }
        }
    )
}
