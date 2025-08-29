import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputShape = {
    table: z.string(),
    operations: z.array(
        z.object({
            action: z.enum(['create', 'rename', 'delete']),
            name: z.string(),
            new_name: z.string().optional(),
            columns: z.array(z.record(z.string(), z.any())).optional(),
        })
    ),
} as const

const Input = z.object(InputShape)

export const registerManageTables: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'manage_tables',
        {
            title: 'Manage Tables',
            description: 'Create, rename, and delete tables.',
            inputSchema: {
                type: 'object',
                properties: {
                    table: { type: 'string' },
                    operations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', enum: ['create', 'rename', 'delete'] },
                                name: { type: 'string' },
                                new_name: { type: 'string' },
                                columns: { type: 'array', items: { type: 'object' } },
                            },
                            required: ['action', 'name'],
                        },
                        minItems: 1,
                    },
                },
                required: ['table', 'operations'],
            },
        },
        async (args: unknown) => {
            const { operations } = Input.parse(args)
            const results = []
            for (const op of operations) {
                if (op.action === 'create') {
                    const res = await client.createTable(op.name, op.columns)
                    results.push({ action: 'create', name: op.name, result: res })
                } else if (op.action === 'rename') {
                    const res = await client.renameTable(op.name, op.new_name!)
                    results.push({ action: 'rename', from: op.name, to: op.new_name, result: res })
                } else if (op.action === 'delete') {
                    const res = await client.deleteTable(op.name)
                    results.push({ action: 'delete', name: op.name, result: res })
                }
            }
            return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
        }
    )
}
