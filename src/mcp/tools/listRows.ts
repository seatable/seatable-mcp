import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Table name'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
    page_size: z.number().int().min(1).max(1000).default(100).describe('Rows per page (max 1000)'),
    view: z.string().optional().describe('Optional SeaTable view name'),
})

export const registerListRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'list_rows',
        {
            title: 'List Rows',
            description: 'List rows from a table with pagination (defaults: page=1, page_size=100). Use find_rows for filtering/sorting or query_sql for SQL queries.',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.listRows(parsed)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
