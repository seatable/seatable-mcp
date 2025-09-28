/* eslint-disable simple-import-sort/imports */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type CallToolResult,
    type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { z } from 'zod'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { getEnv } from '../config/env.js'
import { logger } from '../logger.js'
import { SeaTableClient } from '../seatable/client.js'
import { MockSeaTableClient } from '../seatable/mockClient.js'

// Helper function to convert Zod schemas to JSON Schema for MCP tools
const getInputSchema = (schema: z.ZodType<object>): ListToolsResult['tools'][0]['inputSchema'] => {
    const jsonSchema = zodToJsonSchema(schema)
    
    if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
        throw new Error(`Invalid input schema: expected an object but got ${
            'type' in jsonSchema ? String(jsonSchema.type) : 'no type'
        }`)
    }
    
    return { ...jsonSchema, type: 'object' }
}

const formatToolResponse = (data: unknown, isError = false): CallToolResult => {
    return {
        content: [{
            type: 'text',
            mimeType: 'application/json',
            text: JSON.stringify(data),
        }],
        isError,
    }
}

export class SeaTableMCPServer {
    private readonly server: Server
    private readonly client: SeaTableClient

    constructor(client: SeaTableClient) {
        this.client = client
        this.server = new Server(
            {
                name: '@aspereo/mcp-seatable',
                version: '0.1.1',
            },
            {
                capabilities: {
                    tools: {},
                    experimental: {
                        'gpt-5-codex-preview': {
                            enabled: true,
                            default: true,
                            description: 'Enable GPT-5 Codex (Preview) tooling support for all connected clients.',
                        },
                    },
                },
                instructions: [
                    'GPT-5 Codex (Preview) is enabled for all clients connecting to this server.',
                    'Use the SeaTable tools to query and manage data; GPT-5 Codex can orchestrate these tools automatically.',
                ].join('\n'),
            },
        )
        this.initializeHandlers()
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport)
    }

    async close(): Promise<void> {
        await this.server.close()
    }

    private initializeHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, this.handleListTools.bind(this))
        this.server.setRequestHandler(CallToolRequestSchema, this.handleCallTool.bind(this))
    }

    private async handleListTools(): Promise<ListToolsResult> {
        const ListTablesSchema = z.object({})
        const ListRowsSchema = z.object({
            table: z.string(),
            page: z.number().int().min(1).default(1),
            page_size: z.number().int().min(1).max(1000).default(100),
            view: z.string().optional(),
            order_by: z.string().optional(),
            direction: z.enum(['asc', 'desc']).optional(),
        })
        const GetRowSchema = z.object({
            table: z.string(),
            rowId: z.string(),
        })
        const AppendRowsSchema = z.object({
            table: z.string(),
            rows: z.array(z.record(z.string(), z.any())).min(1),
            allow_create_columns: z.boolean().optional(),
        })
        const PingSchema = z.object({})
        
        return {
            tools: [
                {
                    name: 'list_tables',
                    description: 'List tables in the SeaTable base',
                    inputSchema: getInputSchema(ListTablesSchema),
                },
                {
                    name: 'list_rows',
                    description: 'List rows from a table with pagination and filters',
                    inputSchema: getInputSchema(ListRowsSchema),
                },
                {
                    name: 'get_row',
                    description: 'Get a row by ID from a table',
                    inputSchema: getInputSchema(GetRowSchema),
                },
                {
                    name: 'append_rows',
                    description: 'Batch insert rows. Rejects unknown columns unless allow_create_columns=true',
                    inputSchema: getInputSchema(AppendRowsSchema),
                },
                {
                name: 'ping_seatable',
                description: 'Health check that verifies connectivity and auth to SeaTable',
                inputSchema: getInputSchema(PingSchema),
            },
            {
                name: 'update_rows',
                description: 'Batch update rows. Rejects unknown columns unless allow_create_columns=true',
                inputSchema: getInputSchema(z.object({
                    table: z.string().describe('The name of the table'),
                    rows: z.array(z.object({
                        row_id: z.string().describe('The ID of the row to update'),
                        row: z.record(z.string(), z.any()).describe('The row data to update'),
                    })).min(1).describe('Array of rows to update with their IDs'),
                    allow_create_columns: z.boolean().optional().describe('Whether to allow creating new columns if they do not exist'),
                })),
            },
            {
                name: 'delete_rows',
                description: 'Delete one or more rows from a table by their IDs.',
                inputSchema: getInputSchema(z.object({
                    table: z.string().describe('The name of the table'),
                    row_ids: z.array(z.string()).min(1).describe('Array of row IDs to delete'),
                })),
            },
            {
                name: 'find_rows',
                description: 'Find rows using a predicate DSL. Filtering is performed client-side for broad compatibility. Supports and/or/not, eq, ne, in, gt/gte/lt/lte, contains, starts_with, ends_with, is_null.',
                inputSchema: getInputSchema(z.object({
                    table: z.string().describe('The name of the table'),
                    filter: z.record(z.any()).optional().describe('Filter predicate using DSL syntax'),
                    limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of rows to return'),
                    offset: z.number().int().min(0).optional().describe('Number of rows to skip'),
                    select: z.array(z.string()).optional().describe('Column names to include in results'),
                })),
            },
            {
                name: 'get_schema',
                description: 'Returns the normalized schema for the base',
                inputSchema: getInputSchema(z.object({})),
            },
            {
                name: 'manage_tables',
                description: 'Create, rename, and delete tables.',
                inputSchema: getInputSchema(z.object({
                    operation: z.enum(['create', 'rename', 'delete']).describe('The operation to perform'),
                    table_name: z.string().describe('The name of the table'),
                    new_name: z.string().optional().describe('New name for rename operation'),
                    lang: z.string().optional().describe('Language for new table (e.g., "en")'),
                })),
            },
            {
                name: 'query_sql',
                description: 'Execute raw SQL queries against SeaTable. Supports SELECT, INSERT, UPDATE, DELETE. Use ? placeholders for parameters to prevent SQL injection.',
                inputSchema: getInputSchema(z.object({
                    sql: z.string().describe('The SQL query to execute (e.g., "SELECT * FROM Table1 WHERE Name=?")')
                        .refine(sql => sql.trim().length > 0, 'SQL query cannot be empty'),
                    parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Parameters to replace ? placeholders in the SQL query'),
                })),
            },
            ],
        }
    }

    private async handleCallTool(request: z.infer<typeof CallToolRequestSchema>): Promise<CallToolResult> {
        try {
            switch (request.params.name) {
                case 'list_tables': {
                    const tables = await this.client.listTables()
                    return formatToolResponse(tables)
                }

                case 'list_rows': {
                    const ListRowsSchema = z.object({
                        table: z.string(),
                        page: z.number().int().min(1).default(1),
                        page_size: z.number().int().min(1).max(1000).default(100),
                        view: z.string().optional(),
                        order_by: z.string().optional(),
                        direction: z.enum(['asc', 'desc']).optional(),
                    })
                    const args = ListRowsSchema.parse(request.params.arguments)
                    const res = await this.client.listRows(args)
                    return formatToolResponse(res)
                }

                case 'get_row': {
                    const GetRowSchema = z.object({
                        table: z.string(),
                        rowId: z.string(),
                    })
                    const args = GetRowSchema.parse(request.params.arguments)
                    const res = await this.client.getRow(args.table, args.rowId)
                    return formatToolResponse(res)
                }

                case 'append_rows': {
                    const AppendRowsSchema = z.object({
                        table: z.string(),
                        rows: z.array(z.record(z.string(), z.any())).min(1),
                        allow_create_columns: z.boolean().optional(),
                    })
                    const args = AppendRowsSchema.parse(request.params.arguments)
                    const results = []
                    for (const row of args.rows) {
                        const res = await this.client.addRow(args.table, row)
                        results.push(res)
                    }
                    return formatToolResponse(results)
                }

                case 'ping_seatable': {
                    const started = Date.now()
                    try {
                        await this.client.getMetadata()
                        const latencyMs = Date.now() - started
                        return formatToolResponse({
                            status: 'healthy',
                            latency_ms: latencyMs,
                            timestamp: new Date().toISOString(),
                        })
                    } catch (error) {
                        const latencyMs = Date.now() - started
                        return formatToolResponse({
                            status: 'unhealthy',
                            latency_ms: latencyMs,
                            timestamp: new Date().toISOString(),
                            error: error instanceof Error ? error.message : String(error),
                        }, true)
                    }
                }

                case 'update_rows': {
                    const UpdateRowsSchema = z.object({
                        table: z.string(),
                        rows: z.array(z.object({
                            row_id: z.string(),
                            row: z.record(z.string(), z.any()),
                        })).min(1),
                        allow_create_columns: z.boolean().optional(),
                    })
                    const args = UpdateRowsSchema.parse(request.params.arguments)
                    const results = []
                    for (const { row_id, row } of args.rows) {
                        const res = await this.client.updateRow(args.table, row_id, row)
                        results.push(res)
                    }
                    return formatToolResponse(results)
                }

                case 'delete_rows': {
                    const DeleteRowsSchema = z.object({
                        table: z.string(),
                        row_ids: z.array(z.string()).min(1),
                    })
                    const args = DeleteRowsSchema.parse(request.params.arguments)
                    const results = []
                    for (const rowId of args.row_ids) {
                        const res = await this.client.deleteRow(args.table, rowId)
                        results.push({ row_id: rowId, deleted: true })
                    }
                    return formatToolResponse(results)
                }

                case 'find_rows': {
                    const FindRowsSchema = z.object({
                        table: z.string(),
                        filter: z.record(z.any()).optional(),
                        limit: z.number().int().min(1).max(1000).optional(),
                        offset: z.number().int().min(0).optional(),
                        select: z.array(z.string()).optional(),
                    })
                    const args = FindRowsSchema.parse(request.params.arguments)
                    
                    // First get all rows from the table
                    const allRows = await this.client.listRows({ 
                        table: args.table, 
                        page: 1, 
                        page_size: 1000 
                    })
                    let filteredRows = allRows.rows || []

                    // Apply client-side filtering if provided
                    if (args.filter) {
                        filteredRows = filteredRows.filter(row => this.evaluateFilter(row, args.filter!))
                    }

                    // Apply offset
                    if (args.offset) {
                        filteredRows = filteredRows.slice(args.offset)
                    }

                    // Apply limit
                    if (args.limit) {
                        filteredRows = filteredRows.slice(0, args.limit)
                    }

                    // Apply column selection
                    if (args.select) {
                        const selectedRows = filteredRows.map(row => {
                            const selectedRow: Record<string, any> = {}
                            for (const col of args.select!) {
                                if (col in row) {
                                    selectedRow[col] = row[col]
                                }
                            }
                            return selectedRow
                        })
                        return formatToolResponse({ rows: selectedRows, total: selectedRows.length })
                    }

                    return formatToolResponse({ rows: filteredRows, total: filteredRows.length })
                }

                case 'get_schema': {
                    const tables = await this.client.listTables()
                    const schema = {
                        tables: tables.map(table => ({
                            name: table.name,
                            _id: table._id,
                        }))
                    }
                    return formatToolResponse(schema)
                }

                case 'manage_tables': {
                    const ManageTablesSchema = z.object({
                        operation: z.enum(['create', 'rename', 'delete']),
                        table_name: z.string(),
                        new_name: z.string().optional(),
                        lang: z.string().optional(),
                    })
                    const args = ManageTablesSchema.parse(request.params.arguments)
                    
                    switch (args.operation) {
                        case 'create': {
                            // Create a table with basic columns
                            const result = await this.client.createTable(args.table_name, [
                                { column_name: 'Name', column_type: 'text' }
                            ])
                            return formatToolResponse(result)
                        }
                        case 'rename': {
                            if (!args.new_name) {
                                throw new Error('new_name is required for rename operation')
                            }
                            const result = await this.client.renameTable(args.table_name, args.new_name)
                            return formatToolResponse(result)
                        }
                        case 'delete': {
                            const result = await this.client.deleteTable(args.table_name)
                            return formatToolResponse(result)
                        }
                        default: {
                            throw new Error(`Unknown table operation: ${args.operation}`)
                        }
                    }
                }

                case 'query_sql': {
                    const QuerySqlSchema = z.object({
                        sql: z.string().refine(sql => sql.trim().length > 0, 'SQL query cannot be empty'),
                        parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
                    })
                    const args = QuerySqlSchema.parse(request.params.arguments)
                    
                    try {
                        const result = await this.client.querySql(args.sql, args.parameters)
                        return formatToolResponse({
                            metadata: result.metadata,
                            results: result.results,
                            query: args.sql,
                            parameters: args.parameters || [],
                        })
                    } catch (error) {
                        return formatToolResponse({
                            error: 'SQL query failed',
                            message: error instanceof Error ? error.message : String(error),
                            query: args.sql,
                            parameters: args.parameters || [],
                        }, true)
                    }
                }

                default: {
                    throw new Error(`Unknown tool: ${request.params.name}`)
                }
            }
        } catch (error) {
            return formatToolResponse(
                `Error in tool ${request.params.name}: ${error instanceof Error ? error.message : String(error)}`,
                true,
            )
        }
    }

    private evaluateFilter(row: Record<string, any>, filter: Record<string, any>): boolean {
        // Simple filter evaluation for basic operations
        for (const [key, value] of Object.entries(filter)) {
            if (key === 'and') {
                return Array.isArray(value) && value.every(f => this.evaluateFilter(row, f))
            }
            if (key === 'or') {
                return Array.isArray(value) && value.some(f => this.evaluateFilter(row, f))
            }
            if (key === 'not') {
                return !this.evaluateFilter(row, value)
            }
            
            // Field-specific filters
            if (typeof value === 'object' && value !== null) {
                const rowValue = row[key]
                for (const [op, opValue] of Object.entries(value)) {
                    switch (op) {
                        case 'eq':
                            if (rowValue !== opValue) return false
                            break
                        case 'ne':
                            if (rowValue === opValue) return false
                            break
                        case 'in':
                            if (!Array.isArray(opValue) || !opValue.includes(rowValue)) return false
                            break
                        case 'gt':
                            if (typeof rowValue === 'number' && typeof opValue === 'number' && rowValue <= opValue) return false
                            break
                        case 'gte':
                            if (typeof rowValue === 'number' && typeof opValue === 'number' && rowValue < opValue) return false
                            break
                        case 'lt':
                            if (typeof rowValue === 'number' && typeof opValue === 'number' && rowValue >= opValue) return false
                            break
                        case 'lte':
                            if (typeof rowValue === 'number' && typeof opValue === 'number' && rowValue > opValue) return false
                            break
                        case 'contains':
                            if (typeof rowValue !== 'string' || typeof opValue !== 'string' || !rowValue.includes(opValue)) return false
                            break
                        case 'starts_with':
                            if (typeof rowValue !== 'string' || typeof opValue !== 'string' || !rowValue.startsWith(opValue)) return false
                            break
                        case 'ends_with':
                            if (typeof rowValue !== 'string' || typeof opValue !== 'string' || !rowValue.endsWith(opValue)) return false
                            break
                        case 'is_null':
                            if ((rowValue == null) !== Boolean(opValue)) return false
                            break
                        default:
                            // Unknown operator, skip
                            break
                    }
                }
            } else {
                // Direct equality check
                if (row[key] !== value) return false
            }
        }
        return true
    }
}

export function buildServer() {
    const env = getEnv()
    const client = (env.SEATABLE_MOCK ? new MockSeaTableClient() : new SeaTableClient()) as unknown as SeaTableClient

    const server = new SeaTableMCPServer(client)
    
    logger.info('MCP server built')
    return server
}
