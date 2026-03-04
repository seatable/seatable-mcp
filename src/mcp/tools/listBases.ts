import { ToolRegistrar } from './types.js'

export const registerListBases: ToolRegistrar = (server, { baseNames }) => {
    server.registerTool(
        'list_bases',
        {
            title: 'List Bases',
            description: 'List available SeaTable bases. Use the returned names as the "base" parameter in other tools.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
            annotations: { readOnlyHint: true },
        },
        async () => {
            const names = baseNames ?? []
            return { content: [{ type: 'text', text: JSON.stringify(names) }] }
        }
    )
}
