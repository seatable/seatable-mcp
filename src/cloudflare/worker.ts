import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type JSONRPCMessage, JSONRPCMessageSchema, type MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js'

import { clearEnvOverrides, setEnvOverrides } from '../config/env.js'
import { logger } from '../logger.js'
import { buildServer } from '../mcp/server.js'

const SSE_PATH = '/mcp'
const MESSAGE_PATH = '/messages'

type CfEnv = Record<string, unknown>
type CfExecutionContext = { waitUntil(promise: Promise<unknown>): void }

type WorkerSession = {
    transport: WorkerSseTransport
    close: () => Promise<void>
}

class WorkerSseTransport implements Transport {
    readonly sessionId: string
    onclose?: () => void
    onerror?: (error: Error) => void
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void

    private readonly controllerReady: Promise<void>
    private resolveControllerReady?: () => void
    private controller?: ReadableStreamDefaultController<string>
    private closed = false
    private started = false

    constructor(private readonly endpoint: string) {
        this.sessionId = crypto.randomUUID()
        this.controllerReady = new Promise((resolve) => {
            this.resolveControllerReady = resolve
        })
    }

    async start(): Promise<void> {
        if (this.started) {
            throw new Error('Transport already started')
        }
        await this.controllerReady
        this.started = true
    }

    createResponse(): Response {
        const stream = new ReadableStream<string>({
            start: (controller) => {
                this.controller = controller
                this.sendEndpointEvent()
                this.resolveControllerReady?.()
            },
            cancel: () => {
                void this.close()
            },
        })

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
            },
        })
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.enqueue(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        this.controller?.close()
        this.onclose?.()
    }

    async handleClientMessage(body: unknown, request: Request): Promise<void> {
        try {
            const parsed = JSONRPCMessageSchema.parse(body)
            const headers: Record<string, string> = {}
            request.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value
            })
            this.onmessage?.(parsed, { requestInfo: { headers } })
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            this.onerror?.(err)
            throw err
        }
    }

    private enqueue(data: string): void {
        if (this.closed || !this.controller) return
        this.controller.enqueue(data)
    }

    private sendEndpointEvent(): void {
        const endpointUrl = new URL(this.endpoint, 'https://worker.local')
        endpointUrl.searchParams.set('sessionId', this.sessionId)
        const relative = `${endpointUrl.pathname}${endpointUrl.search}${endpointUrl.hash}`
        this.enqueue(`event: endpoint\ndata: ${relative}\n\n`)
    }
}

const sessions = new Map<string, WorkerSession>()

function extractStringEnv(env: CfEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') {
            result[key] = value
        }
    }
    return result
}

async function createSession(env: CfEnv, ctx: CfExecutionContext): Promise<Response> {
    clearEnvOverrides()
    setEnvOverrides(extractStringEnv(env))

    const server = buildServer()
    const transport = new WorkerSseTransport(MESSAGE_PATH)
    const sessionId = transport.sessionId
    const response = transport.createResponse()

    const cleanup = async () => {
        if (!sessions.has(sessionId)) return
        sessions.delete(sessionId)
        try {
            await transport.close()
        } catch (error) {
            logger.debug({ err: error, sessionId }, 'Failed to close worker SSE transport')
        }
        try {
            await server.close()
        } catch (error) {
            logger.debug({ err: error, sessionId }, 'Failed to close MCP server for worker session')
        }
    }

    transport.onclose = () => {
        void cleanup()
    }
    transport.onerror = (error) => {
        logger.error({ err: error, sessionId }, 'Worker SSE transport error')
    }

    sessions.set(sessionId, {
        transport,
        close: cleanup,
    })

    logger.info({ sessionId }, 'Accepted Cloudflare Worker SSE connection')

    ctx.waitUntil(
        (async () => {
            try {
                await transport.start()
                await server.connect(transport)
            } catch (error) {
                logger.error({ err: error, sessionId }, 'Error during Cloudflare Worker SSE session')
                await transport.close().catch(() => {})
            } finally {
                await cleanup()
                logger.info({ sessionId }, 'Cloudflare Worker SSE session closed')
            }
        })(),
    )

    return response
}

async function routeMessage(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') ?? undefined

    if (!sessionId) {
        return new Response('Missing sessionId parameter', { status: 400 })
    }

    const session = sessions.get(sessionId)
    if (!session) {
        return new Response('Session not found', { status: 404 })
    }

    let body: unknown
    try {
        body = await request.json()
    } catch (error) {
        logger.warn({ err: error, sessionId }, 'Invalid JSON payload received in worker transport')
        return new Response('Invalid JSON payload', { status: 400 })
    }

    try {
        await session.transport.handleClientMessage(body, request)
        return new Response(null, { status: 202 })
    } catch (error) {
        logger.error({ err: error, sessionId }, 'Failed to handle worker transport message')
        return new Response('Invalid message', { status: 400 })
    }
}

const worker = {
    async fetch(request: Request, env: CfEnv, ctx: CfExecutionContext): Promise<Response> {
        const url = new URL(request.url)

        if (request.method === 'GET' && url.pathname === SSE_PATH) {
            return await createSession(env, ctx)
        }

        if (request.method === 'POST' && url.pathname === MESSAGE_PATH) {
            return await routeMessage(request)
        }

        if (request.method === 'GET' && url.pathname === '/health') {
            return new Response('ok', { status: 200 })
        }

        return new Response('Not found', { status: 404 })
    },
}

export default worker
