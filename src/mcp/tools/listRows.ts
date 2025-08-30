import { z } from 'zod'

import { ToolRegistrar } from './types.js'

export const ListRowsInput = z.object({
    table: z.string(),
    page: z.number().int().min(1).default(1),
    page_size: z.number().int().min(1).max(1000).default(100),
    view: z.string().optional(),
    order_by: z.string().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    filter: z.record(z.any()).optional(),
    search: z.string().optional(),
})

const InputShape = {
    table: z.string(),
    page: z.number().int().min(1).default(1),
    page_size: z.number().int().min(1).max(1000).default(100),
    view: z.string().optional(),
    order_by: z.string().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    filter: z.record(z.any()).optional(),
    search: z.string().optional(),
} as const

const InputSchema = z.object({
    table: z.string(),
    start: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    view_name: z.string().optional(),
    sort: z.array(z.object({
        column_name: z.string(),
        order: z.enum(['asc', 'desc']).optional(),
    })).optional(),
    filters: z.array(z.object({
        column_name: z.string(),
        filter_predicate: z.enum(['equal', 'not_equal', 'less', 'less_or_equal', 'greater', 'greater_or_equal', 'is_empty', 'is_not_empty', 'contain', 'not_contain', 'is_within']),
        filter_term: z.string().optional(),
        filter_term_modifier: z.string().optional(),
    })).optional(),
    search: z.array(z.object({
        column_name: z.string(),
        query: z.string(),
    })).optional(),
})

export const registerListRows: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'list_rows',
        {
            title: 'List Rows',
            description: 'List rows from a table with pagination and filters',
            inputSchema: InputSchema,
        },
        async (args: unknown) => {
            const parsed = ListRowsInput.parse(args)
            const res = await client.listRows(parsed)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
