import { z } from 'zod'

import { mapMetadataToGeneric } from '../../schema/map.js'
import { validateRowsAgainstSchema } from '../../schema/validate.js'
import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    row: z.record(z.any()).describe('Row object (column -> value)'),
})

export const registerAddRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'add_row',
        {
            title: 'Add Row',
            description: 'Add a new row to a table. Link and file/image columns cannot be set here — use link_rows and upload_file instead. Note: the response may contain column keys instead of column names due to a SeaTable API limitation.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args: unknown) => {
            const { table, row } = InputSchema.parse(args)
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            validateRowsAgainstSchema(generic, table, [row])
            const created = await client.addRow(table, row)
            return { content: [{ type: 'text', text: JSON.stringify(created) }] }
        }
    )
}
