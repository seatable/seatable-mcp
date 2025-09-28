import { SeaTableMCPAgent } from './mcp-agent.js'

// Export the MCP Agent as a Durable Object
export { SeaTableMCPAgent }

function buildCorsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get('origin') ?? '*'
    const requestedHeaders = request.headers.get('access-control-request-headers')
    const varyValues = ['Origin']
    if (requestedHeaders) {
        varyValues.push('Access-Control-Request-Headers')
    }

    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': requestedHeaders
            ? requestedHeaders
            : 'Content-Type,Authorization,mcp-protocol-version',
        'Vary': varyValues.join(', '),
    }
}

interface CloudflareEnv {
    // SeaTable configuration
    SEATABLE_SERVER_URL?: string
    SEATABLE_API_TOKEN?: string
    SEATABLE_BASE_UUID?: string
    SEATABLE_TABLE_NAME?: string
    LOG_LEVEL?: string
    HTTP_TIMEOUT_MS?: string
    SEATABLE_MOCK?: string
    SEATABLE_TOKEN_ENDPOINT_PATH?: string
    SEATABLE_ACCESS_TOKEN_EXP?: string
    SEATABLE_ENABLE_FIND_ROWS?: string
    
    // Worker-specific bindings
    LOGS?: any
    
    // OAuth (for future implementation)
    OAUTH_CLIENT_ID?: string
    OAUTH_CLIENT_SECRET?: string
}

type CfExecutionContext = { 
    waitUntil(promise: Promise<unknown>): void
    passThroughOnException(): void
}

const worker = {
    async fetch(request: Request, env: CloudflareEnv, ctx: CfExecutionContext): Promise<Response> {
        const url = new URL(request.url)

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: buildCorsHeaders(request) })
        }

        // SSE transport endpoint
        if (url.pathname.startsWith('/sse')) {
            console.info('SSE transport request', { path: url.pathname, method: request.method })
            return SeaTableMCPAgent.serveSSE('/sse', { binding: 'SEATABLE_MCP' }).fetch(request, env, ctx)
        }

        // Streamable HTTP transport endpoint
        if (url.pathname.startsWith('/mcp')) {
            console.info('Streamable HTTP transport request', { path: url.pathname, method: request.method })
            return SeaTableMCPAgent.serve('/mcp', { binding: 'SEATABLE_MCP' }).fetch(request, env, ctx)
        }

        // Health check endpoint
        if (request.method === 'GET' && url.pathname === '/health') {
            console.info('Health check request')
            return new Response('ok', { status: 200, headers: buildCorsHeaders(request) })
        }

        // Diagnostic endpoint
        if (request.method === 'GET' && url.pathname === '/') {
            console.info('Diagnostic page request')
            const html = await import('./diagnostic.html')
            return new Response(html.default, {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    ...buildCorsHeaders(request),
                },
            })
        }

        return new Response('Not found', { status: 404 })
    },
}

export default worker
