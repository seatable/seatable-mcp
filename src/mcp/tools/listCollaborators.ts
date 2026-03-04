import { ToolRegistrar } from './types.js'

export const registerListCollaborators: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'list_collaborators',
        {
            title: 'List Collaborators',
            description: 'List users who have access to this base. Returns email (internal user ID) and display name. Use the email values when writing to collaborator columns.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
            annotations: { readOnlyHint: true },
        },
        async () => {
            const users = await client.listCollaborators()
            return { content: [{ type: 'text', text: JSON.stringify(users) }] }
        }
    )
}
