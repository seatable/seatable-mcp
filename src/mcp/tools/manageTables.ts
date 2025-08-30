import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const OperationSchema = z.object({
    action: z.enum(['create', 'rename', 'delete']),
    name: z.string(),
    new_name: z.string().optional(),
    columns: z.array(z.record(z.string(), z.any())).optional(),
})

const InputSchema = z.object({
    operations: z.array(OperationSchema).min(1),
})

export const registerManageTables: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'manage_tables',
        {
            title: 'Manage Tables',
            description: 'Create, rename, and delete tables.',
            inputSchema: getInputSchema(InputSchema),
        },
        async (args: unknown) => {
            const { operations } = InputSchema.parse(args)
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
