import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string(),
    rows: z.array(z.record(z.string(), z.any())).min(1),
})

export const registerAppendRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'append_rows',
        {
            title: 'Append Rows',
            description: 'Batch insert rows.',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const { table, rows } = InputSchema.parse(args)
            const results = []
            for (const row of rows) {
                const res = await client.addRow(table, row)
                results.push(res)
            }
            return { content: [{ type: 'text', text: JSON.stringify({ rows: results }) }] }
        }
    )
}
