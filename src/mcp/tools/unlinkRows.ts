import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
  table: z.string(),
  link_column: z.string(),
  pairs: z.array(z.object({ from_row_id: z.string(), to_row_id: z.string() })).min(1),
})

export const registerUnlinkRows: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'unlink_rows',
    {
      title: 'Unlink Rows',
      description: 'Remove links between rows via the dedicated links endpoint. This is the ONLY way to remove links — link columns cannot be modified via update_rows.',
      inputSchema: getInputSchema(InputSchema),
    },
    async (args: unknown) => {
      const { table, link_column, pairs } = InputSchema.parse(args)

      const result = await client.deleteLinks({
        table,
        linkColumn: link_column,
        pairs: pairs.map((p) => ({ fromRowId: p.from_row_id, toRowId: p.to_row_id })),
      })

      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
