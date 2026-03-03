import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
  table: z.string(),
  column: z.string(),
  options: z.array(z.object({
    name: z.string(),
    color: z.string().optional(),
    textColor: z.string().optional(),
  })).min(1),
})

export const registerAddSelectOptions: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'add_select_options',
    {
      title: 'Add Select Options',
      description: 'Add new options to a single-select or multi-select column. Use this before writing rows with option values that do not exist yet.',
      inputSchema: getInputSchema(InputSchema),
    },
    async (args: unknown) => {
      const parsed = InputSchema.parse(args)

      const result = await client.addColumnOptions({
        table: parsed.table,
        column: parsed.column,
        options: parsed.options,
      })

      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
