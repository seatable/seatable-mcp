import { z } from 'zod'

import { makeError } from '../../errors.js'
import { mapMetadataToGeneric } from '../../schema/map.js'
import { validateRowsAgainstSchema } from '../../schema/validate.js'
import { ToolRegistrar } from './types.js'

const InputShape = {
    table: z.string(),
    key_columns: z.array(z.string()).min(1),
    rows: z.array(z.record(z.any())),
    allow_create_columns: z.boolean().optional(),
} as const

const Input = z.object(InputShape)

export const registerUpsertRows: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'upsert_rows',
        {
            title: 'Upsert Rows',
            description:
                'Batch upsert rows by matching on one or more key columns. If a match exists, update it; otherwise insert a new row. Rejects unknown columns unless allow_create_columns=true.',
            inputSchema: {
                type: 'object',
                properties: {
                    table: { type: 'string' },
                    key_columns: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    rows: { type: 'array', items: { type: 'object' } },
                    allow_create_columns: { type: 'boolean' },
                },
                required: ['table', 'key_columns', 'rows'],
            },
        },
        async (args: unknown) => {
            const { table, key_columns, rows, allow_create_columns } = Input.parse(args)

            // Validate payload against schema and unknown column policy
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            validateRowsAgainstSchema(generic, table, rows, {
                allowCreateColumns: allow_create_columns ?? false,
            })

            const results: Array<{ action: 'inserted' | 'updated'; row: any }> = []

            for (const row of rows) {
                // Ensure all key columns present
                for (const k of key_columns) {
                    if (!(k in row)) {
                        throw makeError('ERR_UPSERT_MISSING_KEY', `Missing key column in row: ${k}`, { key: k })
                    }
                }

                // Build simple equality filter
                const filter: Record<string, unknown> = {}
                for (const k of key_columns) filter[k] = row[k]

                // Use dedicated filter endpoint to avoid GET /rows ignoring filter params
                const found = await client.searchRows(table, filter)
                const matches = (found.rows || []).slice(0, 2)

                if (matches.length > 1) {
                    throw makeError('ERR_UPSERT_AMBIGUOUS', 'Multiple matches for upsert key', { key_columns, filter })
                }

                if (matches.length === 1) {
                    const updated = await client.updateRow(table, matches[0]._id, row)
                    results.push({ action: 'updated', row: updated })
                } else {
                    const inserted = await client.addRow(table, row)
                    results.push({ action: 'inserted', row: inserted })
                }
            }

            return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
        }
    )
}
