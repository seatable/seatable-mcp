import { z } from 'zod'

import { mapMetadataToGeneric } from '../../schema/map.js'
import { ToolRegistrar } from './types.js'

const Create = z.object({ name: z.string(), type: z.string(), options: z.record(z.any()).optional() })
const Update = z.object({ name: z.string(), new_name: z.string().optional(), type: z.string().optional(), options: z.record(z.any()).optional() })
const Delete = z.object({ name: z.string() })

const Op = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), create: Create }),
  z.object({ action: z.literal('update'), update: Update }),
  z.object({ action: z.literal('delete'), delete: Delete }),
])

const InputSchema = z.object({ table: z.string(), operations: z.array(Op).min(1) })

export const registerManageColumns: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'manage_columns',
    {
      title: 'Manage Columns',
      description: 'Create, update, and delete columns with normalized schema outputs.',
      inputSchema: getInputSchema(InputSchema),
    },
    async (args: unknown) => {
      const { table, operations } = InputSchema.parse(args)
      const results: any[] = []

      for (const op of operations) {
        if (op.action === 'create') {
          const { name, type, options } = (op as any).create
          const res = await client.createColumn(table, { column_name: name, column_type: type, ...options })
          results.push({ action: 'create', result: res })
        } else if (op.action === 'update') {
          const { name, new_name, type, options } = (op as any).update
          const res = await client.updateColumn(table, name, { new_column_name: new_name, column_type: type, ...options })
          results.push({ action: 'update', result: res })
        } else if (op.action === 'delete') {
          const { name } = (op as any).delete
          const res = await client.deleteColumn(table, name)
          results.push({ action: 'delete', result: res })
        }
      }

      // Return updated normalized schema for the table
      const meta = await client.getMetadata()
      const generic = mapMetadataToGeneric(meta)
      const updatedTable = generic.tables.find(t => t.name === table)

      return { content: [{ type: 'text', text: JSON.stringify({ results, schema: updatedTable }) }] }
    }
  )
}
