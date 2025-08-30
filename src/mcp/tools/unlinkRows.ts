import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
  table: z.string(),
  link_column: z.string(),
  pairs: z.array(z.object({ from_row_id: z.string(), to_row_id: z.string() })).min(1),
})

export const registerUnlinkRows: ToolRegistrar = (server, { client }) => {
  server.registerTool(
    'unlink_rows',
    {
      title: 'Unlink Rows',
      description: 'Remove links between rows by updating the link column with row IDs.',
      inputSchema: InputSchema,
    },
    async (args: unknown) => {
      const { table, link_column, pairs } = InputSchema.parse(args)
      const results: any[] = []

      for (const { from_row_id, to_row_id } of pairs) {
        const existing = await client.getRow(table, from_row_id)
        const current = Array.isArray(existing[link_column]) ? (existing[link_column] as any[]) : []
        const next = current.filter((id) => id !== to_row_id)
        const updated = await client.updateRow(table, from_row_id, { [link_column]: next })
        results.push({ from_row_id, to_row_id, row: updated })
      }

      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
    }
  )
}
