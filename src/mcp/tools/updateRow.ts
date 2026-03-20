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
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { table, updates } = InputSchema.parse(args)
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            const { strippedReadOnly } = validateRowsAgainstSchema(
                generic,
                table,
                updates.map((u: z.infer<typeof UpdateItem>) => u.values)
            )

            await client.updateRows(
                table,
                updates.map((u: z.infer<typeof UpdateItem>) => ({ row_id: u.row_id, row: u.values }))
            )
            const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: JSON.stringify({ success: true, updated_count: updates.length }) }]
            if (strippedReadOnly.length) {
                content.push({ type: 'text', text: `Note: Read-only columns were ignored: ${strippedReadOnly.join(', ')}` })
            }
            return { content }
        }
    )
}
