import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { logger } from './logger.js'
import { buildServer } from './mcp/server.js'

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

main().catch((err) => {
    logger.error(err)
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
})
