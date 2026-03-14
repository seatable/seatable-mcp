import { z } from 'zod'

import type { GenericSchema } from './generic'

// Table and column schemas reused across variants
const ColumnSchema = z.object({
    key: z.string(),
    name: z.string(),
    type: z.string(),
    data: z.record(z.unknown()).nullable().optional(),
    description: z.string().nullable().optional(),
})
const TableSchema = z
    .object({
        _id: z.string(),
        name: z.string(),
        columns: z.array(ColumnSchema).optional(),
    })
    .passthrough()

// v1: { base_id?, tables: [...] }
const MetaV1 = z
    .object({
        base_id: z.string().optional(),
        tables: z.array(TableSchema),
    })
    .passthrough()

// v2.1: { base_id?, metadata: { tables: [...] } }
const MetaV21 = z
    .object({
        base_id: z.string().optional(),
        metadata: z
            .object({
                tables: z.array(TableSchema),
            })
            .passthrough(),
    })
    .passthrough()

const SeaTableMetadataUnion = z.union([MetaV1, MetaV21])

/** Strip UI-only fields from column data, keep only semantically relevant config. */
function cleanColumnData(type: string, data: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
    if (!data || typeof data !== 'object') return undefined

    const d = data as Record<string, any>

    // Select options — only keep option names
    if (d.options && Array.isArray(d.options)) {
        const names = d.options.map((o: any) => o.name).filter(Boolean)
        return names.length ? { options: names } : undefined
    }

    // Link columns — keep config needed for link_rows/unlink_rows
    if (type === 'link' || type === 'link-formula') {
        const result: Record<string, unknown> = {}
        if (d.link_id) result.link_id = d.link_id
        if (d.table_id) result.table_id = d.table_id
        if (d.other_table_id) result.other_table_id = d.other_table_id
        if (d.display_column_key) result.display_column_key = d.display_column_key
        if (typeof d.is_multiple === 'boolean') result.is_multiple = d.is_multiple
        return Object.keys(result).length ? result : undefined
    }

    // Geolocation — keep format
    if (d.geo_format) return { geo_format: d.geo_format }

    // Duration — keep format
    if (d.duration_format) return { duration_format: d.duration_format }

    // Number — keep format
    if (d.format && (type === 'number' || d.format === 'percent' || d.format === 'dollar' || d.format === 'euro' || d.format === 'yuan')) {
        return { format: d.format }
    }

    // Rating — keep max number
    if (d.rate_max_number) return { rate_max_number: d.rate_max_number }

    return undefined
}

export function mapMetadataToGeneric(meta: unknown): GenericSchema {
    const parsed = SeaTableMetadataUnion.parse(meta)
    const tables = (parsed as any).tables ?? (parsed as any).metadata?.tables ?? []
    const baseId = (parsed as any).base_id ?? ''
    return {
        base_id: baseId,
        tables: tables.map((t: z.infer<typeof TableSchema>) => ({
            id: t._id,
            name: t.name,
            columns: (t.columns ?? []).map((c) => {
                const col: Record<string, unknown> = {
                    id: c.key,
                    name: c.name,
                    type: normalizeType(c.type),
                }
                if (c.description) col.description = c.description
                const cleaned = cleanColumnData(c.type, c.data)
                if (cleaned) col.options = cleaned
                return col
            }),
        })),
    }
}

function normalizeType(t: string): any {
    const m: Record<string, string> = {
        text: 'text',
        long_text: 'long_text',
        'long-text': 'long_text',
        number: 'number',
        checkbox: 'checkbox',
        date: 'date',
        datetime: 'datetime',
        single_select: 'single_select',
        'single-select': 'single_select',
        multiple_select: 'multi_select',
        'multiple-select': 'multi_select',
        link: 'link',
        file: 'attachment',
        image: 'attachment',
        url: 'url',
        email: 'email',
        phone: 'phone',
        formula: 'formula',
        rate: 'rate',
        duration: 'duration',
        geolocation: 'geolocation',
        collaborator: 'collaborator',
        auto_number: 'auto_number',
        'auto-number': 'auto_number',
        creator: 'creator',
        ctime: 'ctime',
        mtime: 'mtime',
        last_modifier: 'last_modifier',
        'last-modifier': 'last_modifier',
        button: 'button',
        digital_sign: 'digital_sign',
        'digital-sign': 'digital_sign',
        link_formula: 'link_formula',
        'link-formula': 'link_formula',
    }
    return (m[t] as any) ?? 'text'
}
