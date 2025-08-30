import { z } from 'zod'

import { makeError } from '../../errors.js'
import { ToolRegistrar } from './types.js'

const FileInput = z.union([
  z.object({ url: z.string().url(), filename: z.string(), content_type: z.string().optional() }),
  z.object({ bytes_base64: z.string(), filename: z.string(), content_type: z.string().optional() }),
])

const InputSchema = z.object({
  table: z.string(),
  row_id: z.string(),
  column: z.string(),
  file: FileInput,
})

const MAX_BYTES = 5 * 1024 * 1024

export const registerAttachFileToRow: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'attach_file_to_row',
    {
      title: 'Attach File to Row',
      description: 'Attach a file to a row via URL or base64 bytes (<= 5 MB).',
      inputSchema: getInputSchema(InputSchema),
    },
    async (args: unknown) => {
      const { table, row_id, column, file } = InputSchema.parse(args)

      if ('bytes_base64' in file) {
        const bytes = Buffer.from(file.bytes_base64, 'base64')
        if (bytes.length > MAX_BYTES) {
          throw makeError('ERR_FILE_TOO_LARGE', 'Attachment too large (> 5 MB)', {
            table,
            row_id,
            column,
            filename: file.filename,
            size: bytes.length,
          })
        }
        // For now, return the file descriptor to be uploaded via a separate flow (to be implemented later)
        return { content: [{ type: 'text', text: JSON.stringify({ note: 'upload flow not yet implemented', table, row_id, column, filename: file.filename, size: bytes.length }) }] }
      } else if ('url' in file) {
        // We are not downloading server-side. Provide descriptor for later ingestion by SeaTable server (requires upload link flow).
        return { content: [{ type: 'text', text: JSON.stringify({ note: 'server fetch by URL not implemented; provide URL for SeaTable if supported', table, row_id, column, url: file.url }) }] }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false }) }] }
    }
  )
}
