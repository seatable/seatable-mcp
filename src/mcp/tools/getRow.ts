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
            description: 'Get a row by its _id. row_id is the internal _id, not a column value such as an auto-number. To find a row by a column value, use query_sql: SELECT * returns the _id too.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            try {
                const res = await client.getRow(parsed.table, parsed.row_id)
                return { content: [{ type: 'text', text: JSON.stringify(res) }] }
            } catch (err) {
                // SeaTable's wording, with its typo; "exi" also matches if it gets fixed
                if (err instanceof Error && /row _id not exi/i.test(err.message)) {
                    err.message += '. row_id must be the internal _id, not a column value. To find the row by a column value, use query_sql: SELECT * returns the _id too.'
                }
                throw err
            }
        }
    )
}
