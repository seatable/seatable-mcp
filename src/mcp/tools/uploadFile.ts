import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    column: z.string().describe('Name of the file or image column'),
    row_id: z.string().describe('Row ID to attach the file to'),
    file_name: z.string().describe('File name with extension (e.g. "report.pdf")'),
    file_data: z.string().describe('Base64-encoded file content'),
    replace: z.boolean().optional().default(false).describe('Replace existing files (default: append)'),
})

export const registerUploadFile: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'upload_file',
        {
            title: 'Upload File',
            description: 'Upload a file or image to a row. Accepts base64-encoded file data and attaches it to the specified file or image column. By default appends to existing files; set replace=true to overwrite.',
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args: unknown) => {
            const { table, column, row_id, file_name, file_data, replace } = InputSchema.parse(args)
            const result = await client.uploadFile({
                table,
                column,
                rowId: row_id,
                fileName: file_name,
                fileData: file_data,
                replace,
            })
            return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        }
    )
}
