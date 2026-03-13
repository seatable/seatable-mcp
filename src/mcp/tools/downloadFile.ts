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
            description: 'Read the content of a file from a file or image column. Returns text content for text files (.txt, .csv, .md, .json, .xml, etc.) and extracted text for PDFs. For binary files or files larger than 1 MB, returns a temporary download link instead.',
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
