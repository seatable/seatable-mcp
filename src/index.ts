 
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { logger } from './logger.js'
import { buildServer } from './mcp/server.js'

export { buildServer } from './mcp/server.js'
export { SeaTableClient } from './seatable/client.js'

export interface McpServerConfig {
    serverUrl?: string
    apiToken?: string
    baseUuid?: string
    tableName?: string
    mock?: boolean
}

export async function createMcpServer(config?: McpServerConfig) {
    // Set environment variables if config is provided
    if (config) {
        if (config.serverUrl) process.env.SEATABLE_SERVER_URL = config.serverUrl
        if (config.apiToken) process.env.SEATABLE_API_TOKEN = config.apiToken
        if (config.baseUuid) process.env.SEATABLE_BASE_UUID = config.baseUuid
        if (config.tableName) process.env.SEATABLE_TABLE_NAME = config.tableName
        if (config.mock !== undefined) process.env.SEATABLE_MOCK = config.mock ? '1' : '0'
    }
    
    return buildServer()
}

async function main() {
    const server = buildServer()

    // Wrap transport to log outgoing JSON-RPC for debugging
    const transport = new StdioServerTransport()
    const origSend = transport.send.bind(transport)
    ;(transport as any).send = (msg: any) => {
        try { logger.debug({ direction: 'out', msg }) } catch {}
        return origSend(msg)
    }

    await server.connect(transport)
    logger.info('MCP SeaTable server running (stdio)')
}

// Only run main if this file is being executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        logger.error(err)
        // Mirror to stderr for visibility in non-MCP contexts
        console.error(err)
        process.exit(1)
    })
}
