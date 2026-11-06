import { z } from 'zod'

import { ToolRegistrar } from './types.js'
import { ROW_ID_NOTE } from './utils.js'

const InputSchema = z.object({
  table: z.string().describe('Source table name'),
  link_column: z.string().describe('Name of the link column'),
  pairs: z.array(z.object({ from_row_id: z.string().describe('Row ID in source table'), to_row_id: z.string().describe('Row ID in linked table') })).min(1).max(100).describe('Array of row ID pairs to unlink'),
})

export const registerUnlinkRows: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'unlink_rows',
    {
      title: 'Unlink Rows',
      description: `Remove links between rows via the dedicated links endpoint. This is the ONLY way to remove links — link columns cannot be modified via update_rows. ${ROW_ID_NOTE}`,
      inputSchema: getInputSchema(InputSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: unknown) => {
      const { table, link_column, pairs } = InputSchema.parse(args)

      const result = await client.deleteLinks({
        table,
        linkColumn: link_column,
        pairs: pairs.map((p) => ({ fromRowId: p.from_row_id, toRowId: p.to_row_id })),
      })

      // SeaTable answers success with a count of 0 for rows it doesn't know
      const nothingRemoved = result?.deleted_links_count === 0
      const answer = nothingRemoved
        ? { ...result, success: false, notice: `No link was removed: these rows don't exist or aren't linked. ${ROW_ID_NOTE}` }
        : result
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
    }
  )
}
