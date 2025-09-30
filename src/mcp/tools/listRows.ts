import { z } from 'zod'

import { ToolRegistrar } from './types.js'

// Runtime validation schema
const InputSchema = z.object({
    table: z.string(),
    page: z.number().int().min(1).default(1),
    page_size: z.number().int().min(1).max(1000).default(100),
    view: z.string().optional(),
    order_by: z.string().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    filter: z.record(z.any()).optional(),
    search: z.string().optional(),
}).passthrough() // Allow additional properties

// Explicit JSON Schema (avoid zod-to-json-schema defaults & $ref that some MCP hosts strip)
const InputJsonSchema = {
    type: 'object',
    description: 'List rows from a table with pagination and optional filters/search',
    properties: {
        table: { type: 'string', description: 'Table name (required)' },
        page: { type: 'integer', minimum: 1, default: 1, description: 'Page number (1-based)' },
        page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Rows per page (max 1000)' },
        view: { type: 'string', description: 'Optional SeaTable view name' },
        order_by: { type: 'string', description: 'Column name to order by' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' },
        filter: { type: 'object', additionalProperties: true, description: 'Filter object (implementation specific)' },
        search: { type: 'string', description: 'Full-text search substring' },
    },
    required: ['table'],
    // Temporarily allow unknown properties to diagnose upstream host injections
    additionalProperties: true,
} as const

export const registerListRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
            'list_rows',
            {
                title: 'List Rows',
                description: 'List rows from a table with pagination and filters (defaults: page=1, page_size=100)',
                // Provide explicit schema to MCP host
                inputSchema: InputJsonSchema as any,
            },
        async (args: unknown) => {
            const parsed = InputSchema.parse(args)
            const res = await client.listRows(parsed)
            return { content: [{ type: 'text', text: JSON.stringify(res) }] }
        }
    )
}
