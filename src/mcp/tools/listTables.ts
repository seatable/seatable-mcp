import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputShape = {} as const
const Input = z.object(InputShape)

export const registerListTables: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'list_tables',
        {
            title: 'List Tables',
            description: 'List tables in the SeaTable base',
            inputSchema: InputShape,
        },
        async (_args: unknown) => {
            const _ = Input.parse({})
            const tables = await client.listTables()
            return { content: [{ type: 'text', text: JSON.stringify(tables) }] }
        }
    )
}
