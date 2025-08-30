import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputShape = {} as const
const Input = z.object(InputShape)

const InputSchema = z.object({})

export const registerListTables: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'list_tables',
        {
            title: 'List Tables',
            description: 'List tables in the SeaTable base',
            inputSchema: InputSchema,
        },
        async (_args: unknown) => {
            const _ = Input.parse({})
            const tables = await client.listTables()
            return { content: [{ type: 'text', text: JSON.stringify(tables) }] }
        }
    )
}
