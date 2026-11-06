import { z } from 'zod'

import { ToolRegistrar } from './types.js'
import { ROW_ID_NOTE } from './utils.js'

const InputSchema = z.object({
    table: z.string().describe('Table name of the row'),
    row_id: z.string().describe('Row ID to get the activity history for'),
    page: z.number().int().min(1).default(1).optional().describe('Page number (default 1, 25 activities per page)'),
})

/** Simplify file/image values to just file names. */
function simplifyValue(value: unknown, columnType: string): unknown {
    if (columnType === 'file' && Array.isArray(value)) {
        return value.map((f: any) => f.name ?? f).filter(Boolean)
    }
    if (columnType === 'image' && Array.isArray(value)) {
        return value.map((url: string) => {
            if (typeof url === 'string') return url.split('/').pop()?.split('?')[0] ?? url
            return url
        })
    }
    return value
}

/** Clean a single activity entry, stripping internal fields and simplifying file values. */
function cleanActivity(activity: any): Record<string, unknown> {
    const detail = activity.detail ?? {}
    const changes = (detail.row_data ?? []).map((rd: any) => {
        const change: Record<string, unknown> = {
            column: rd.column_name,
            type: rd.column_type,
        }
        if (rd.value !== undefined && rd.value !== null && rd.value !== '') {
            change.value = simplifyValue(rd.value, rd.column_type)
        }
        if (rd.old_value !== undefined && rd.old_value !== null && rd.old_value !== '') {
            change.old_value = simplifyValue(rd.old_value, rd.column_type)
        }
        return change
    })

    return {
        op_type: activity.op_type,
        op_time: activity.op_time,
        op_user: activity.op_user || undefined,
        table: detail.table_name,
        row_name: detail.row_name || undefined,
        changes,
    }
}

// The retention period varies, so this names none
const NO_ACTIVITIES_NOTICE =
    'The row exists, but no activities are available. SeaTable keeps row activities only for a limited time, so this does not mean the row was never changed.'

export const registerGetRowActivities: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'get_row_activities',
        {
            title: 'Get Row Activities',
            description: `Get the change history of a specific row. Returns a list of activities showing who changed what and when, including old and new values. 25 activities per page. ${ROW_ID_NOTE}`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { table, row_id, page } = InputSchema.parse(args)
            const result = await client.getRowActivities(row_id, page)
            const cleaned = result.activities.map(cleanActivity)
            // SeaTable answers the same for a wrong ID and for a row whose activities
            // are past its retention period. The lookup throws if the row doesn't exist.
            const noActivities = result.total_count === 0
            if (noActivities) await client.getRow(table, row_id)
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ...(noActivities && { notice: NO_ACTIVITIES_NOTICE }),
                        activities: cleaned,
                        total_count: result.total_count,
                    }),
                }],
            }
        }
    )
}
