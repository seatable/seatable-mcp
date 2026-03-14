/** Strip redundant and UI-only fields from query_sql metadata. */
export function cleanSqlMetadata(metadata: any): any {
    if (!Array.isArray(metadata)) return metadata
    return metadata.map((col: any) => {
        const clean: Record<string, unknown> = {
            name: col.name,
            type: col.type,
        }

        // Only include data when it carries semantic meaning
        if (col.data && typeof col.data === 'object') {
            const d = col.data as Record<string, any>

            // Select options — only names
            if (d.options && Array.isArray(d.options)) {
                const names = d.options.map((o: any) => o.name).filter(Boolean)
                if (names.length) clean.options = names
            }
            // Link config
            else if (d.link_id) {
                clean.data = {
                    link_id: d.link_id,
                    table_id: d.table_id,
                    other_table_id: d.other_table_id,
                    is_multiple: d.is_multiple,
                }
            }
            // Geo format
            else if (d.geo_format) { clean.geo_format = d.geo_format }
            // Duration format
            else if (d.duration_format) { clean.duration_format = d.duration_format }
            // Number format
            else if (d.format === 'number' || d.format === 'percent' || d.format === 'dollar' || d.format === 'euro' || d.format === 'yuan') {
                clean.format = d.format
            }
            // Rating max
            else if (d.rate_max_number) { clean.rate_max_number = d.rate_max_number }
        }

        return clean
    })
}
