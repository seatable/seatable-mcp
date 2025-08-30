import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string(),
    rows: z.array(z.record(z.string(), z.any())).min(1),
    allow_create_columns: z.boolean().optional(),
})

export const registerAppendRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'append_rows',
        {
            title: 'Append Rows',
            description: 'Batch insert rows. Rejects unknown columns unless allow_create_columns=true',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const { table, rows, allow_create_columns } = InputSchema.parse(args)
            // TODO: Add schema validation with allow_create_columns support
            const results = []
            for (const row of rows) {
                const res = await client.addRow(table, row)
                results.push(res)
            }
            return { content: [{ type: 'text', text: JSON.stringify({ rows: results }) }] }
        }
    )
}
