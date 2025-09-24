import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { SSEServerTransport, type SSEServerTransportOptions } from '@modelcontextprotocol/sdk/server/sse.js'

import { logger } from '../logger.js'
import { buildServer } from '../mcp/server.js'

export interface StartSseServerOptions {
    host?: string
    port?: number
    ssePath?: string
    messagePath?: string
    transportOptions?: SSEServerTransportOptions
}

type ActiveSession = {
    transport: SSEServerTransport
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

async function handleSseConnection(
    req: IncomingMessage,
    res: ServerResponse,
    sessions: Map<string, ActiveSession>,
    messagePath: string,
    transportOptions?: SSEServerTransportOptions,
): Promise<void> {
    const server = buildServer()
    const transport = new SSEServerTransport(messagePath, res, transportOptions)
    const sessionId = transport.sessionId

    let cleaned = false
    const cleanup = async () => {
        if (cleaned) return
        cleaned = true
        sessions.delete(sessionId)
        try {
            await transport.close()
        } catch (error) {
            logger.debug({ err: error, sessionId }, 'Error closing SSE transport')
        }
        try {
            await server.close()
        } catch (error) {
            logger.debug({ err: error, sessionId }, 'Error closing MCP server for SSE session')
        }
    }

    transport.onclose = cleanup
    transport.onerror = (error) => {
        logger.error({ err: error, sessionId }, 'SSE transport error')
    }

    res.on('close', () => {
        void cleanup()
    })

    sessions.set(sessionId, {
        transport,
        close: cleanup,
    })

    logger.info({ sessionId }, 'Accepted SSE connection')

    try {
        await server.connect(transport)
        await cleanup()
        logger.info({ sessionId }, 'SSE session closed')
    } catch (error) {
        logger.error({ err: error, sessionId }, 'Failed to establish SSE connection')
        await cleanup()
        if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' }).end('Failed to establish SSE connection')
        }
    }
}

async function handlePostMessage(
    req: IncomingMessage,
    res: ServerResponse,
    session: ActiveSession | undefined,
): Promise<void> {
    if (!session) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Session not found')
        return
    }

    let body: unknown
    try {
        body = await parseJsonBody(req)
    } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Invalid JSON payload')
        logger.warn({ err: error }, 'Failed to parse SSE message payload')
        return
    }

    try {
        await session.transport.handlePostMessage(req as IncomingMessage & { auth?: AuthInfo }, res, body)
    } catch (error) {
        logger.error({ err: error }, 'Error handling SSE message')
        if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' }).end('Failed to handle message')
        }
    }
}

export async function startSseServer(options: StartSseServerOptions = {}) {
    const host = options.host ?? process.env.HOST ?? '0.0.0.0'
    const port = options.port ?? Number(process.env.PORT ?? 3000)
    const ssePath = options.ssePath ?? '/mcp'
    const messagePath = options.messagePath ?? '/messages'

    const sessions = new Map<string, ActiveSession>()

    const server = createServer(async (req, res) => {
        if (!req.url) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing request URL')
            return
        }

        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

        if (req.method === 'GET' && url.pathname === ssePath) {
            await handleSseConnection(req, res, sessions, messagePath, options.transportOptions)
            return
        }

        if (req.method === 'POST' && url.pathname === messagePath) {
            const sessionId = url.searchParams.get('sessionId') ?? undefined
            const session = sessionId ? sessions.get(sessionId) : undefined
            await handlePostMessage(req, res, session)
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

    logger.info({ host, port, ssePath, messagePath }, 'SSE server listening')

    const shutdown = async () => {
        for (const [sessionId, session] of sessions.entries()) {
            logger.debug({ sessionId }, 'Closing SSE session during shutdown')
            await session.close()
        }
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    if (typeof process !== 'undefined' && process.once) {
        const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
        for (const signal of signals) {
            process.once(signal, () => {
                logger.info({ signal }, 'Received shutdown signal for SSE server')
                shutdown().catch((error) => {
                    logger.error({ err: error }, 'Error during SSE server shutdown')
                })
            })
        }
    }

    return server
}
