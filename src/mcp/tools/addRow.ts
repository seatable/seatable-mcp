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
            description: 'Add a single row. For multiple rows, always use append_rows instead of calling add_row in a loop. Link and file/image columns cannot be set here — use link_rows and upload_file instead.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (args: unknown) => {
            const { table, row } = InputSchema.parse(args)
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            const { strippedReadOnly } = validateRowsAgainstSchema(generic, table, [row])
            const created = await client.addRow(table, row)
            const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: JSON.stringify(created) }]
            if (strippedReadOnly.length) {
                content.push({ type: 'text', text: `Note: Read-only columns were ignored: ${strippedReadOnly.join(', ')}` })
            }
            return { content }
        }
    )
}
