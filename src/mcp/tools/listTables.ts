import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({})

/** Strip UI-only metadata from tables, keep only what an AI client needs. */
function cleanTables(tables: any[]): any[] {
    return tables.map((t) => ({
        _id: t._id,
        name: t.name,
        columns: (t.columns ?? []).map((c: any) => {
            const col: Record<string, unknown> = {
                key: c.key,
                name: c.name,
                type: c.type,
            }
            // Column description (user-provided, helps AI understand the column)
            if (c.description) col.description = c.description
            // Only include data for columns where it carries semantic meaning
            if (c.data && typeof c.data === 'object') {
                const d = c.data
                // Select options
                if (d.options) col.options = d.options
                // Link column config
                if (d.link_id) col.data = { link_id: d.link_id, table_id: d.table_id, other_table_id: d.other_table_id, display_column_key: d.display_column_key }
                // Number format
                if (d.format === 'number' || d.format === 'percent' || d.format === 'dollar' || d.format === 'euro' || d.format === 'yuan') col.format = d.format
                // Duration format
                if (d.duration_format) col.duration_format = d.duration_format
                // Geolocation format
                if (d.geo_format) col.geo_format = d.geo_format
                // Rating max
                if (d.rate_max_number) col.rate_max_number = d.rate_max_number
            }
            return col
        }),
    }))
}

export const registerListTables: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'list_tables',
        {
            title: 'List Tables',
            description: 'List tables in the SeaTable base with their columns (name, type, key). Includes select options and link configuration where applicable.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (_args: unknown) => {
            InputSchema.parse({})
            client.clearMetadataCache?.()
            const metadata = await client.getMetadata()
            const tables = metadata.tables ?? []
            return { content: [{ type: 'text', text: JSON.stringify(cleanTables(tables)) }] }
        }
    )
}
