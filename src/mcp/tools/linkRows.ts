import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const Input = z.object({
  table: z.string(),
  link_column: z.string(),
  pairs: z.array(z.object({ from_row_id: z.string(), to_row_id: z.string() })).min(1),
})

export const registerLinkRows: ToolRegistrar = (server, { client }) => {
  server.registerTool(
    'link_rows',
    {
      title: 'Link Rows',
      description: 'Create links between rows by updating the link column with row IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          link_column: { type: 'string' },
          pairs: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from_row_id: { type: 'string' }, to_row_id: { type: 'string' } },
              required: ['from_row_id', 'to_row_id'],
            },
            minItems: 1,
          },
        },
        required: ['table', 'link_column', 'pairs'],
      },
    },
    async (args: unknown) => {
      const { table, link_column, pairs } = Input.parse(args)
      const results: any[] = []

      for (const { from_row_id, to_row_id } of pairs) {
        const existing = await client.getRow(table, from_row_id)
        const current = Array.isArray(existing[link_column]) ? (existing[link_column] as any[]) : []
        const next = Array.from(new Set([...current, to_row_id]))
        const updated = await client.updateRow(table, from_row_id, { [link_column]: next })
        results.push({ from_row_id, to_row_id, row: updated })
      }

      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
    }
  )
}
