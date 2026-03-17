import { ToolRegistrar } from './types.js'

export const registerListCollaborators: ToolRegistrar = (server, { client }) => {
    server.registerTool(
        'list_collaborators',
        {
            title: 'List Collaborators',
            description: 'List users who have access to this base. Returns email (internal user ID) and display name. Use the email values when writing to collaborator columns. Call this once to resolve @auth.local addresses in collaborator columns before displaying them to the user.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async () => {
            const users = await client.listCollaborators()
            return { content: [{ type: 'text', text: JSON.stringify(users) }] }
        }
    )
}
