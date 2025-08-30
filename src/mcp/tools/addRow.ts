import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({ table: z.string(), row: z.record(z.any()) })

export const registerAddRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'addRow',
        {
            title: 'Add Row',
            description: 'Add a new row',
            inputSchema: getInputSchema(InputSchema)
        },
        async (args: unknown) => {
            const { table, row } = InputSchema.parse(args)
            const created = await client.addRow(table, row)
            return { content: [{ type: 'text', text: JSON.stringify(created) }] }
        }
    )
}
