import { z } from 'zod'

import { mapMetadataToGeneric } from '../../schema/map.js'
import { validateRowsAgainstSchema } from '../../schema/validate.js'
import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    rows: z.array(z.record(z.string(), z.any())).min(1).describe('Array of row objects (column name -> value)'),
})

export const registerAppendRows: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'append_rows',
        {
            title: 'Append Rows',
            description: 'Batch insert rows. Rejects unknown columns. Link and file/image columns cannot be set here — use link_rows and upload_file instead.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args: unknown) => {
            const { table, rows } = InputSchema.parse(args)
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            validateRowsAgainstSchema(generic, table, rows)

            const results = []
            for (const row of rows) {
                const res = await client.addRow(table, row)
                results.push(res)
            }
            return { content: [{ type: 'text', text: JSON.stringify({ rows: results }) }] }
        }
    )
}
