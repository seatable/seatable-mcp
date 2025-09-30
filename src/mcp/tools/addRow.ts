import { z } from 'zod'

import { ToolRegistrar } from './types.js'

// Completely permissive schema for debugging
// Runtime validation
const InputSchema = z.object({ table: z.string(), row: z.record(z.any()) }).passthrough() // Allow additional properties

// Explicit JSON Schema
const InputJsonSchema = {
    type: 'object',
    description: 'Add a single row to a table',
    properties: {
        table: { type: 'string', description: 'Target table name' },
        row: { type: 'object', description: 'Row object (column -> value)', additionalProperties: true },
    },
    required: ['table', 'row'],
    additionalProperties: false,
} as const

export const registerAddRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'add_row',
        {
            title: 'Add Row',
            description: 'Add a new row to a table',
            inputSchema: InputJsonSchema as any,
        },
        async (args: unknown) => {
            try {
                // Debug: log what we're receiving
                console.log('add_row received args:', JSON.stringify(args))
                const { table, row } = InputSchema.parse(args)
                const created = await client.addRow(table, row)
                return { content: [{ type: 'text', text: JSON.stringify(created) }] }
            } catch (error) {
                console.log('add_row validation error:', error)
                console.log('add_row args were:', JSON.stringify(args))
                throw error
            }
        }
    )
}
