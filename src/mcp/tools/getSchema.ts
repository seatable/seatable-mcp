import { z } from 'zod'
import { mapMetadataToGeneric } from '../../schema/map.js'
import { ToolRegistrar } from './types.js'

const InputSchema = z.object({})

export const registerGetSchema: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'get_schema',
        {
            title: 'Get Schema',
            description: 'Returns the normalized schema for the base',
            inputSchema: getInputSchema(InputSchema),
        },
        async () => {
            const metadata = await client.getMetadata()
            const generic = mapMetadataToGeneric(metadata)
            return { content: [{ type: 'text', text: JSON.stringify(generic) }] }
        }
    )
}
