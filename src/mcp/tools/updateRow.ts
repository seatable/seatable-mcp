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
    allow_create_columns: z.boolean().optional(),
})

function inferTypeFromValues(values: any[]): string {
    // Prefer checkbox for booleans, number for numbers, else text
    if (values.some((v) => typeof v === 'boolean')) return 'checkbox'
    if (values.some((v) => typeof v === 'number')) return 'number'
    return 'text'
}

export const registerUpdateRows: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'update_rows',
        {
            title: 'Update Rows',
            description: 'Batch update rows. Rejects unknown columns unless allow_create_columns=true',
            inputSchema: InputSchema,
        },
        async (args: unknown) => {
            const { table, updates, allow_create_columns } = InputSchema.parse(args)
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            // Validate against schema and capture unknowns
            const { unknownColumns } = validateRowsAgainstSchema(
                generic,
                table,
                updates.map((u: z.infer<typeof UpdateItem>) => u.values),
                { allowCreateColumns: allow_create_columns ?? false }
            )

            if (allow_create_columns && unknownColumns.length) {
                // Infer simple types per unknown column from provided values across updates
                for (const col of unknownColumns) {
                    const sampleVals = updates.map((u: z.infer<typeof UpdateItem>) => u.values[col]).filter((v: any) => v !== undefined)
                    const inferred = inferTypeFromValues(sampleVals)
                    await client.createColumn(table, { column_name: col, column_type: inferred })
                }
            }

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
