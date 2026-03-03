import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Table name'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
    page_size: z.number().int().min(1).max(1000).default(100).describe('Rows per page (max 1000)'),
    view: z.string().optional().describe('Optional SeaTable view name'),
    order_by: z.string().optional().describe('Column name to order by'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
    filter: z.record(z.any()).optional().describe('Filter object'),
    search: z.string().optional().describe('Full-text search substring'),
})

export const registerListRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'list_rows',
        {
            title: 'List Rows',
            description: 'List rows from a table with pagination and filters (defaults: page=1, page_size=100)',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.listRows(parsed)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
