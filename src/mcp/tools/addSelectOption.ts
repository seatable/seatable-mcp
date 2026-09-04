import { z } from 'zod'

import { makeError } from '../../errors.js'
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

/** Names of the options a select column already has. Empty if the column has none yet. */
function existingOptionNames(metadata: any, table: string, column: string): Set<string> {
  const tableObj = (metadata?.tables ?? []).find((t: any) => t.name === table)
  if (!tableObj) {
    throw makeError('ERR_SCHEMA_UNKNOWN_TABLE', `Table "${table}" not found`, { table })
  }
  const columnObj = (tableObj.columns ?? []).find((c: any) => c.name === column)
  if (!columnObj) {
    throw makeError('ERR_SCHEMA_UNKNOWN_COLUMN', `Column "${column}" not found in table "${table}"`, {
      table,
      column,
    })
  }
  const opts = columnObj.data?.options
  if (!Array.isArray(opts)) return new Set()
  return new Set(
    opts.map((o: any) => o?.name).filter((n: unknown): n is string => typeof n === 'string')
  )
}

export const registerAddSelectOptions: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'add_select_options',
    {
      title: 'Add Select Options',
      description: 'Add new options to a single-select or multi-select column. Use this before writing rows with option values that do not exist yet. Options that already exist are skipped, so this will not create duplicates.',
      inputSchema: getInputSchema(InputSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: unknown) => {
      const parsed = InputSchema.parse(args)

      // Skip options the column already has — the SeaTable API happily creates
      // a second option with the same name, which is never what the caller wants.
      const existing = existingOptionNames(await client.getMetadata(), parsed.table, parsed.column)
      const skipped: string[] = []
      const seen = new Set<string>()
      const toAdd: typeof parsed.options = []
      for (const opt of parsed.options) {
        if (existing.has(opt.name)) {
          skipped.push(opt.name)
        } else if (!seen.has(opt.name)) {
          seen.add(opt.name)
          toAdd.push(opt)
        }
      }

      const added = toAdd.map((o) => o.name)
      if (toAdd.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ added, skipped, success: true }) }],
        }
      }

      const result = await client.addColumnOptions({
        table: parsed.table,
        column: parsed.column,
        options: toAdd,
      })

      return { content: [{ type: 'text', text: JSON.stringify({ added, skipped, ...result }) }] }
    }
  )
}
