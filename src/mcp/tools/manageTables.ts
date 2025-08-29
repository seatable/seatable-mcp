import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const Column = z.object({ name: z.string(), type: z.string(), options: z.record(z.any()).optional() })
const OperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name: z.string(), columns: z.array(Column).optional() }),
  z.object({ action: z.literal('rename'), from: z.string(), to: z.string() }),
  z.object({ action: z.literal('delete'), name: z.string() })
])

const InputShape = {
  operations: z.array(OperationSchema)
} as const

function normalizeType(t: string): string {
  const m: Record<string, string> = {
    'single-select': 'single_select',
    'multiple-select': 'multiple_select',
    'multi-select': 'multiple_select',
    'multi_select': 'multiple_select',
  }
  return m[t] || t
}

export const registerManageTables: ToolRegistrar = (server, { client }) => {
  server.registerTool(
    'manage_tables',
    {
      title: 'Manage Tables',
      description: 'Create, rename, or delete tables in SeaTable',
      inputSchema: InputShape,
    },
    async (args: unknown) => {
      const { operations } = z.object(InputShape).parse(args)
      const results: any[] = []
      for (const op of operations) {
        if (op.action === 'create') {
          // Map columns to client expected shape and ensure at least one column
          const requested = (op.columns || [])
          let cols = requested.map((c: any) => {
            const out: any = { column_name: c.name, column_type: normalizeType(c.type) }
            if (c.options) out.data = c.options // older servers expect data.options
            return out
          })
          if (cols.length === 0) {
            cols = [{ column_name: 'Name', column_type: 'text' }]
          }
          const res = await client.createTable(op.name, cols)

          // Safety: if API returned a table with 0 columns, add a default text column to avoid UI breakage
          const hasCols = Array.isArray((res as any)?.columns) && (res as any).columns.length > 0
          if (!hasCols) {
            try {
              await client.createColumn(op.name, { column_name: 'Name', column_type: 'text' })
            } catch { /* ignore, best-effort safeguard */ }
          }

          results.push({ action: 'create', result: res })
        } else if (op.action === 'rename') {
          const res = await client.renameTable(op.from, op.to)
          results.push({ action: 'rename', result: res })
        } else if (op.action === 'delete') {
          const res = await client.deleteTable(op.name)
          results.push({ action: 'delete', result: res })
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
    }
  )
}
