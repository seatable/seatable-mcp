import { z } from 'zod'

import { mapMetadataToGeneric } from '../../schema/map.js'
import { validateRowsAgainstSchema } from '../../schema/validate.js'
import { ToolRegistrar } from './types.js'

const UpdateItem = z.object({
    row_id: z.string(),
    values: z.record(z.any()),
})

const InputSchema = z.object({
    table: z.string(),
    updates: z.array(UpdateItem).min(1),
})

export const registerUpdateRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'update_rows',
        {
            title: 'Update Rows',
            description: 'Batch update rows. Rejects unknown columns. Link and file/image columns cannot be modified here — use link_rows/unlink_rows and upload_file instead.',
            inputSchema: getInputSchema(InputSchema),
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
