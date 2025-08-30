import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputShape = {
    table: z.string(),
    rowId: z.string(),
} as const

const InputSchema = z.object({
    table: z.string(),
    rowId: z.string(),
})

export const registerGetRow: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'get_row',
        {
            title: 'Get Row',
            description: 'Get a row by ID from a table',
            inputSchema: InputSchema,
        },
        async (args: unknown) => {
            const parsed = z.object(InputShape).parse(args)
            const res = await client.getRow(parsed.table, parsed.rowId)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
