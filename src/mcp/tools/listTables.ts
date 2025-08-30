import { z } from 'zod'

import { ToolRegistrar } from './types.js'

const InputSchema = z.object({})

export const registerListTables: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'list_tables',
        {
            title: 'List Tables',
            description: 'List tables in the SeaTable base',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
        },
        async (_args: unknown) => {
            InputSchema.parse({})
            const tables = await client.listTables()
            return { content: [{ type: 'text', text: JSON.stringify(tables) }] }
        }
    )
}
