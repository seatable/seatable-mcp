import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

export const register = new Registry()

// Collect Node.js default metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register })

// --- Counters ---

export const toolCallsTotal = new Counter({
    name: 'mcp_tool_calls_total',
    help: 'Total number of MCP tool calls',
    labelNames: ['tool', 'status'] as const,
    registers: [register],
})

export const toolCallsByToolTotal = new Counter({
    name: 'mcp_tool_calls_by_tool_total',
    help: 'Total number of tool calls per tool (regardless of outcome)',
    labelNames: ['tool'] as const,
    registers: [register],
})

export const httpRequestsTotal = new Counter({
    name: 'mcp_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'status'] as const,
    registers: [register],
})

export const rateLimitExceededTotal = new Counter({
    name: 'mcp_rate_limit_exceeded_total',
    help: 'Total number of rate limit rejections',
    labelNames: ['type'] as const,
    registers: [register],
})

export const authValidationsTotal = new Counter({
    name: 'mcp_auth_validations_total',
    help: 'Total number of auth token validations',
    labelNames: ['result'] as const,
    registers: [register],
})

export const seatableApiRequestsTotal = new Counter({
    name: 'seatable_api_requests_total',
    help: 'Total number of SeaTable API requests',
    labelNames: ['operation', 'status'] as const,
    registers: [register],
})

// --- Histograms ---

export const toolDurationSeconds = new Histogram({
    name: 'mcp_tool_duration_seconds',
    help: 'Duration of MCP tool calls in seconds',
    labelNames: ['tool'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
})

export const seatableApiDurationSeconds = new Histogram({
    name: 'seatable_api_duration_seconds',
    help: 'Duration of SeaTable API requests in seconds',
    labelNames: ['operation'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
})

// --- Gauges ---

export const activeSessions = new Gauge({
    name: 'mcp_active_sessions',
    help: 'Number of active HTTP sessions',
    registers: [register],
})

export const activeConnections = new Gauge({
    name: 'mcp_active_connections',
    help: 'Number of active connections',
    registers: [register],
})
