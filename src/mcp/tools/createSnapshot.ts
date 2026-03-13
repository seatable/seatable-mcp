import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({})

export const registerCreateSnapshot: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'create_snapshot',
        {
            title: 'Create Snapshot',
            description: 'Create a snapshot of the current base. Requires at least one change since the last snapshot and at least 10 minutes since the last snapshot.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (args: unknown) => {
            InputSchema.parse(args)
            const result = await client.createSnapshot()

            let message: string
            switch (result.status) {
                case 'created':
                    message = `Snapshot created successfully (commit: ${result.snapshot?.commit_id}).`
                    break
                case 'time_is_short':
                    message = 'Snapshot not created: less than 10 minutes since the last snapshot. Please try again later.'
                    break
                case 'dtable_not_changed':
                    message = 'Snapshot not created: no changes since the last snapshot.'
                    break
                default:
                    message = `Snapshot status: ${result.status}`
            }

            return { content: [{ type: 'text', text: message }] }
        }
    )
}
