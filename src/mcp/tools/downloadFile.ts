import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({
    table: z.string().describe('Target table name'),
    column: z.string().describe('Name of the file or image column'),
    row_id: z.string().describe('Row ID containing the file'),
    file_name: z.string().optional().describe('Specific file name to download (if column contains multiple files). If omitted, the first file is used.'),
})

export const registerDownloadFile: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'download_file',
        {
            title: 'Download File',
            description: `Read the content of a file attached to a row in a file or image column. Use get_row first to see available files in the column, then pass the exact file_name to select a specific file.

Returns JSON with: file_name, file_size (bytes), content, content_type, and download_link (only when content_type is "binary_url").

content_type values:
- "text": file content returned as text (.txt, .csv, .md, .json, .xml, .html, .yaml, .sql, and common programming languages)
- "pdf_text": extracted text from PDF files
- "binary_url": non-text files, files >1 MB, or external URLs — content contains a message, download_link contains the URL`,
            inputSchema: getInputSchema(InputSchema),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: unknown) => {
            const { table, column, row_id, file_name } = InputSchema.parse(args)
            const result = await client.downloadFile({
                table,
                column,
                rowId: row_id,
                fileName: file_name,
            })
            return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        }
    )
}
