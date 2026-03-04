import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
  table: z.string().describe('Target table name'),
  column: z.string().describe('Name of the single-select or multi-select column'),
  options: z.array(z.object({
    name: z.string().describe('Option label'),
    color: z.string().optional().describe('Background color (hex, e.g. "#FF8000")'),
    textColor: z.string().optional().describe('Text color (hex, e.g. "#FFFFFF")'),
  })).min(1).describe('Array of options to add'),
})

export const registerAddSelectOptions: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'add_select_options',
    {
      title: 'Add Select Options',
      description: 'Add new options to a single-select or multi-select column. Use this before writing rows with option values that do not exist yet.',
      inputSchema: getInputSchema(InputSchema),
      annotations: { readOnlyHint: false, destructiveHint: false },
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
