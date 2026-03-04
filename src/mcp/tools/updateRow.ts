import { z } from 'zod'

import { mapMetadataToGeneric } from '../../schema/map.js'
import { validateRowsAgainstSchema } from '../../schema/validate.js'
import { ToolRegistrar } from './types.js'

const UpdateItem = z.object({
    row_id: z.string().describe('Row ID (_id field) to update'),
    values: z.record(z.any()).describe('Column name -> new value pairs'),
})

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    updates: z.array(UpdateItem).min(1).max(100).describe('Array of updates, each with row_id and values'),
})

export const registerUpdateRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'update_rows',
        {
            title: 'Update Rows',
            description: 'Batch update rows. Rejects unknown columns. Link and file/image columns cannot be modified here — use link_rows/unlink_rows and upload_file instead.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async (args: unknown) => {
            const { table, updates } = InputSchema.parse(args)
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            validateRowsAgainstSchema(
                generic,
                table,
                updates.map((u: z.infer<typeof UpdateItem>) => u.values)
            )

            const results = [] as any[]
            for (const u of updates) {
                await client.updateRow(table, u.row_id, u.values)
                const fresh = await client.getRow(table, u.row_id)
                results.push(fresh)
            }
            return { content: [{ type: 'text', text: JSON.stringify({ rows: results }) }] }
        }
    )
}
