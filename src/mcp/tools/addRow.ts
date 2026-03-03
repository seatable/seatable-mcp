import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    row: z.record(z.any()).describe('Row object (column -> value)'),
})

export const registerAddRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'add_row',
        {
            title: 'Add Row',
            description: 'Add a new row to a table',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const { table, row } = InputSchema.parse(args)
            const created = await client.addRow(table, row)
            return { content: [{ type: 'text', text: JSON.stringify(created) }] }
        }
    )
}
