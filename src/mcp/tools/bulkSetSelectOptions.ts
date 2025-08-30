import { z } from 'zod'

import { mapMetadataToGeneric } from '../../schema/map.js'
import { ToolRegistrar } from './types.js'

const SelectOption = z.object({ name: z.string(), color: z.string().optional() })
const ColumnUpdate = z.object({ column: z.string(), options: z.array(SelectOption).min(0) })
const InputSchema = z.object({ table: z.string(), updates: z.array(ColumnUpdate).min(1) })

export const registerBulkSetSelectOptions: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'bulk_set_select_options',
    {
      title: 'Bulk Set Select Options',
      description: 'Bulk update select options for one or more select columns on a table. Only single_select and multi_select columns are supported.',
      inputSchema: getInputSchema(InputSchema),
    },
    async (args: unknown) => {
      const { table, updates } = InputSchema.parse(args)

      const meta = await client.getMetadata()
      const generic = mapMetadataToGeneric(meta)
      const tbl = generic.tables.find((t) => t.name === table)
      if (!tbl) throw new Error(`Unknown table: ${table}`)

      const results: any[] = []
      for (const u of updates) {
        const col = tbl.columns.find((c) => c.name === u.column)
        if (!col) throw new Error(`Unknown column: ${u.column}`)
        const hasOptions = !!(col as any).options && Array.isArray((col as any).options.options)
        if (!hasOptions) throw new Error(`Column ${u.column} has no selectable options in schema`)
        const current = (col as any).options.options as Array<{ id: string, name: string, color?: string }>
        // Map provided names to existing ids where possible; if a provided name matches, include id, else skip (API requires id)
        const toUpdate: Array<{ id: string, name?: string, color?: string }> = []
        for (const opt of u.options) {
          const match = current.find((c) => c.name === opt.name)
          if (match) {
            // Allow color change
            toUpdate.push({ id: match.id, name: opt.name, color: opt.color })
          }
        }
        if (toUpdate.length === 0) {
          results.push({ column: u.column, skipped: true, reason: 'no matching option ids by name' })
          continue
        }
        const res = await (client as any).updateSelectOptions(table, u.column, toUpdate)
        results.push({ column: u.column, result: res })
      }

      const metaAfter = await client.getMetadata()
      const genericAfter = mapMetadataToGeneric(metaAfter)
      const updatedTable = genericAfter.tables.find((t) => t.name === table)

      return { content: [{ type: 'text', text: JSON.stringify({ results, schema: updatedTable }) }] }
    }
  )
}
