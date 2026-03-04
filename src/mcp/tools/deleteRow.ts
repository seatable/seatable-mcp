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
            annotations: { readOnlyHint: false, destructiveHint: true },
        },
        async (args: unknown) => {
            const { table, row_ids } = InputSchema.parse(args)
            const results = []
            for (const row_id of row_ids) {
                const res = await client.deleteRow(table, row_id)
                results.push({ row_id, success: res.success })
            }
            return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
        }
    )
}
