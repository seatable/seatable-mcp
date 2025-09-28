 
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { setEnvOverrides } from './config/env.js'
import { startSseServer } from './http/sseServer.js'
import { logger } from './logger.js'
import { buildServer } from './mcp/server.js'

export { startSseServer } from './http/sseServer.js'
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
        const overrides: Record<string, string> = {}
        if (config.serverUrl) overrides.SEATABLE_SERVER_URL = config.serverUrl
        if (config.apiToken) overrides.SEATABLE_API_TOKEN = config.apiToken
        if (config.baseUuid) overrides.SEATABLE_BASE_UUID = config.baseUuid
        if (config.tableName) overrides.SEATABLE_TABLE_NAME = config.tableName
        if (config.mock !== undefined) overrides.SEATABLE_MOCK = config.mock ? '1' : '0'

        if (Object.keys(overrides).length > 0) {
            setEnvOverrides(overrides)
            if (typeof process !== 'undefined' && process.env) {
                Object.assign(process.env, overrides)
            }
        }
    }

    return buildServer()
}

type TransportMode = 'stdio' | 'sse'

function resolveTransport(argv: string[]): TransportMode {
    const envTransport = (typeof process !== 'undefined' && process.env
        ? process.env.MCP_SEATABLE_TRANSPORT ?? process.env.MCP_TRANSPORT
        : undefined)
        ?.toLowerCase()

    if (envTransport === 'sse') return 'sse'

    if (argv.includes('--sse')) return 'sse'

    const transportArg = argv.find((arg) => arg.startsWith('--transport='))
    if (transportArg) {
        const value = transportArg.split('=')[1]?.toLowerCase()
        if (value === 'sse') return 'sse'
    }

    return 'stdio'
}

async function main() {
    if (resolveTransport(process.argv.slice(2)) === 'sse') {
        await runSseServerCli()
        return
    }

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

// Exported CLI entry for bin launcher (used by npx)
export async function runCli() {
    return main()
}

async function runSseServerCli() {
    const server = await startSseServer()
    logger.info('MCP SeaTable server running (SSE)')
    await new Promise<void>((resolve, reject) => {
        server.on('close', resolve)
        server.on('error', reject)
    })
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
