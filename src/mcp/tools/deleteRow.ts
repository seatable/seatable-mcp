import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputShape = {
    table: z.string(),
    row_ids: z.array(z.string()),
} as const

const Input = z.object(InputShape)

export const registerDeleteRows: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'delete_rows',
        {
            title: 'Delete Rows',
            description: 'Delete one or more rows from a table by their IDs.',
            inputSchema: {
                type: 'object',
                properties: {
                    table: { type: 'string' },
                    row_ids: { type: 'array', items: { type: 'string' } },
                },
                required: ['table', 'row_ids'],
            },
        },
        async (args: unknown) => {
            const { table, row_ids } = Input.parse(args)
            const results = []
            for (const row_id of row_ids) {
                const res = await client.deleteRow(table, row_id)
                results.push({ row_id, success: res.success })
            }
            return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
        }
    )
}
