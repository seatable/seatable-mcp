import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { logger } from '../logger.js'
import { buildServer } from '../mcp/server.js'

export interface StartHttpServerOptions {
    host?: string
    port?: number
}

type ActiveSession = {
    transport: StreamableHTTPServerTransport
    close: () => Promise<void>
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        })
        req.on('end', () => {
            if (!chunks.length) {
                resolve(undefined)
                return
            }
            try {
                const data = Buffer.concat(chunks).toString('utf-8')
                resolve(JSON.parse(data))
            } catch (error) {
                reject(error)
            }
        })
        req.on('error', reject)
    })
}

export async function startHttpServer(options: StartHttpServerOptions = {}) {
    const host = options.host ?? process.env.HOST ?? '0.0.0.0'
    const port = options.port ?? Number(process.env.PORT ?? 3000)

    const sessions = new Map<string, ActiveSession>()

    async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // Parse body for POST requests
        const body = req.method === 'POST' ? await parseJsonBody(req) : undefined

        // Extract session ID from header
        const sessionId = req.headers['mcp-session-id'] as string | undefined

        // For POST without session ID: this is an initialization request → new session
        if (req.method === 'POST' && !sessionId) {
            const mcpServer = buildServer()
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    logger.info({ sessionId: id }, 'Streamable HTTP session initialized')
                    sessions.set(id, { transport, close: cleanup })
                },
            })

            let cleaned = false
            const cleanup = async () => {
                if (cleaned) return
                cleaned = true
                if (transport.sessionId) {
                    sessions.delete(transport.sessionId)
                }
                try {
                    await transport.close()
                } catch (error) {
                    logger.debug({ err: error }, 'Error closing transport')
                }
                try {
                    await mcpServer.close()
                } catch (error) {
                    logger.debug({ err: error }, 'Error closing MCP server')
                }
            }

            transport.onclose = () => {
                void cleanup()
            }

            await mcpServer.connect(transport)
            await transport.handleRequest(req, res, body)
            return
        }

        // For requests with an existing session ID: look up the session
        if (sessionId) {
            const session = sessions.get(sessionId)
            if (!session) {
                res.writeHead(404, { 'content-type': 'text/plain' }).end('Session not found')
                return
            }
            await session.transport.handleRequest(req, res, body)
            return
        }

        // GET/DELETE without session ID
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing mcp-session-id header')
    }

    const server = createServer(async (req, res) => {
        if (!req.url) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing request URL')
            return
        }

        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

        if (url.pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
            try {
                await handleMcpRequest(req, res)
            } catch (error) {
                logger.error({ err: error }, 'Error handling MCP request')
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal server error')
                }
            }
            return
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
            return
        }

        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    })

    await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve())
        server.once('error', (error) => reject(error))
        server.listen(port, host)
    })

    logger.info({ host, port, endpoint: '/mcp' }, 'Streamable HTTP server listening')

    const shutdown = async () => {
        for (const [sessionId, session] of sessions.entries()) {
            logger.debug({ sessionId }, 'Closing session during shutdown')
            await session.close()
        }
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    for (const signal of signals) {
        process.once(signal, () => {
            logger.info({ signal }, 'Received shutdown signal')
            shutdown().catch((error) => {
                logger.error({ err: error }, 'Error during shutdown')
            })
        })
    }

    return server
}
