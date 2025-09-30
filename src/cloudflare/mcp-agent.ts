import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { clearEnvOverrides, getEnv, setEnvOverrides } from '../config/env.js'
import { makeError } from '../errors.js'
// Tool registrars (legacy adapter imports kept for reference / potential rollback)
import { registerAddRow } from '../mcp/tools/addRow.js'
import { registerAppendRows } from '../mcp/tools/appendRows.js'
import { registerAttachFileToRow } from '../mcp/tools/attachFileToRow.js'
import { registerBulkSetSelectOptions } from '../mcp/tools/bulkSetSelectOptions.js'
import { registerDeleteRows } from '../mcp/tools/deleteRow.js'
import { registerEchoArgs } from '../mcp/tools/echoArgs.js'
import { registerFindRows } from '../mcp/tools/findRows.js'
import { registerGetRow } from '../mcp/tools/getRow.js'
import { registerGetSchema } from '../mcp/tools/getSchema.js'
import { registerLinkRows } from '../mcp/tools/linkRows.js'
import { registerListRows } from '../mcp/tools/listRows.js'
import { registerListTables } from '../mcp/tools/listTables.js'
import { registerManageColumns } from '../mcp/tools/manageColumns.js'
import { registerManageTables } from '../mcp/tools/manageTables.js'
import { registerPingSeatable } from '../mcp/tools/pingSeatable.js'
import { registerSearchRows } from '../mcp/tools/searchRows.js'
import { registerUnlinkRows } from '../mcp/tools/unlinkRows.js'
import { registerUpdateRows } from '../mcp/tools/updateRow.js'
import { registerUpsertRows } from '../mcp/tools/upsertRows.js'
import { mapMetadataToGeneric } from '../schema/map.js'
import { validateRowsAgainstSchema } from '../schema/validate.js'
import { SeaTableClient } from '../seatable/client.js'
import { MockSeaTableClient } from '../seatable/mockClient.js'

// Helper function to convert Zod schemas to JSON Schema for MCP tools
const getInputSchema = (schema: z.ZodType<object>) => {
    const jsonSchema = zodToJsonSchema(schema, {
        target: 'jsonSchema7',
        strictUnions: true
    })
    
    if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
        throw new Error(`Invalid input schema: expected an object but got ${
            'type' in jsonSchema ? String(jsonSchema.type) : 'no type'
        }`)
    }
    
    // Make schema maximally permissive for MCP clients
    const permissiveSchema: any = { 
        ...jsonSchema, 
        type: 'object',
        additionalProperties: true
    }
    
    // Remove any strict validation that might cause issues
    if (permissiveSchema.properties) {
        Object.values(permissiveSchema.properties).forEach((prop: any) => {
            if (prop && typeof prop === 'object') {
                prop.additionalProperties = true
            }
        })
    }
    
    return permissiveSchema
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
    
    // Worker-specific bindings (using any for now since types aren't available)
    LOGS?: any
    
    // OAuth (for future implementation)
    OAUTH_CLIENT_ID?: string
    OAUTH_CLIENT_SECRET?: string
}

function extractStringEnv(env: CloudflareEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') {
            result[key] = value
        }
    }
    return result
}

export class SeaTableMCPAgent extends McpAgent<CloudflareEnv> {
    server = new McpServer({ 
        name: '@aspereo/mcp-seatable', 
        version: '1.0.3' // bump to force host schema refresh
    })
    
    private client?: SeaTableClient | MockSeaTableClient

    async init() {
        console.info('Initializing SeaTable MCP Agent')
        
        try {
            // Set up environment from Worker bindings  
            const envOverrides = extractStringEnv((this as any).env || {})
            setEnvOverrides(envOverrides)
            
            // Get validated environment
            const env = getEnv()
            console.info('Environment validated successfully')
            
            // Initialize SeaTable client
            this.client = env.SEATABLE_MOCK 
                ? new MockSeaTableClient() 
                : new SeaTableClient()
            
            console.info('SeaTable client initialized', { 
                mock: Boolean(env.SEATABLE_MOCK),
                serverUrl: env.SEATABLE_SERVER_URL 
            })
            
            // Register all tools using the existing registrar pattern
            this.registerAllTools()
            
            // Register resources
            this.registerResources()
            
            console.info('SeaTable MCP Agent initialization complete')
            
        } catch (error) {
            console.error('Failed to initialize SeaTable MCP Agent:', error)
            throw error
        }
    }

    private registerAllTools(): void {
        if (!this.client) {
            throw new Error('Client not initialized')
        }

        const env = getEnv()
        const deps = { 
            client: this.client, 
            env, 
            getInputSchema 
        }

        // Create a mock server object that adapts to the McpServer interface
        const serverAdapter = {
            registerTool: (name: string, config: any, handler: any) => {
                const description = config.description || config.title || name
                let rawShape: z.ZodRawShape = {}
                try {
                    const js = config.inputSchema
                    if (js && typeof js === 'object' && js.properties) {
                        const required: string[] = Array.isArray(js.required) ? js.required : []
                        rawShape = Object.fromEntries(
                            Object.keys(js.properties).map(k => [k, required.includes(k) ? z.any() : z.any().optional()])
                        ) as z.ZodRawShape
                    }
                } catch (e) {
                    console.warn('shape-derive-failed', name, (e as Error).message)
                }

                this.server.tool(
                    name,
                    description,
                    rawShape,
                    async (args: any) => {
                    // Heuristic unwrapping in case args are nested by host/transport
                    let effective = args
                    if (effective && typeof effective === 'object') {
                        if ('arguments' in effective && typeof (effective as any).arguments === 'object') {
                            effective = (effective as any).arguments
                        } else if ('args' in effective && typeof (effective as any).args === 'object') {
                            effective = (effective as any).args
                        } else if ('params' in effective && typeof (effective as any).params === 'object') {
                            effective = (effective as any).params
                        }
                    }
                    try {
                        console.log('[tool-invoke]', JSON.stringify({ name, rawArgs: args, effective }))
                    } catch {}
                    try {
                        const result = await handler(effective)
                        return {
                            content: result.content || [{
                                type: 'text',
                                text: typeof result === 'string' ? result : JSON.stringify(result)
                            }],
                            isError: result.isError || false
                        }
                    } catch (error) {
                        console.error('Tool execution failed:', { error, toolName: name })
                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    error: error instanceof Error ? error.message : String(error)
                                })
                            }],
                            isError: true
                        }
                    }
                    }
                )
            }
        }

        // Register all tools
        registerPingSeatable(serverAdapter, deps)
        registerGetSchema(serverAdapter, deps)
        registerListTables(serverAdapter, deps)
        registerListRows(serverAdapter, deps)
        registerGetRow(serverAdapter, deps)
        // Phase 1/2: skip adapter for tools we now register explicitly with tight schemas
        // registerAddRow(serverAdapter, deps)
        // registerAppendRows(serverAdapter, deps)
        // registerUpdateRows(serverAdapter, deps)
        // registerDeleteRows(serverAdapter, deps)
        // registerUpsertRows(serverAdapter, deps)
        registerFindRows(serverAdapter, deps)
        registerSearchRows(serverAdapter, deps)
        // registerLinkRows(serverAdapter, deps)
        // registerUnlinkRows(serverAdapter, deps)
        registerManageColumns(serverAdapter, deps)
        registerManageTables(serverAdapter, deps)
        // registerAttachFileToRow(serverAdapter, deps)
        // registerBulkSetSelectOptions(serverAdapter, deps)

        // Conditionally register debug-only tools
        if (env.SEATABLE_ENABLE_DEBUG_TOOLS) {
            registerEchoArgs(serverAdapter, deps)
            // Raw zod-shape diagnostic tools (bypass our adapter layer complexities)
            try {
                this.server.tool('echo_args_diag', 'Diagnostic echo of received arguments', { any: z.any().optional() }, async (toolArgs: any) => {
                    return { content: [{ type: 'text', text: JSON.stringify({ received: toolArgs }) }] }
                })
                this.server.tool('add_row_diag', 'Add row (diagnostic zod path)', { table: z.string(), row: z.any() }, async (toolArgs: any) => {
                    const { table, row } = toolArgs || {}
                    if (!table || !row) {
                        return { content: [{ type: 'text', text: JSON.stringify({ error: 'missing table or row', received: toolArgs }) }], isError: true }
                    }
                    const created = await this.client!.addRow(table, row)
                    return { content: [{ type: 'text', text: JSON.stringify({ created }) }] }
                })
                console.info('Diagnostic Zod-based tools registered (echo_args_diag, add_row_diag)')
            } catch (err) {
                console.error('Failed to register diagnostic tools', err)
            }
        }

        // Explicit schema probe tools (always registered to bypass adapter uncertainties)
        try {
            // Explicit core CRUD (tight schemas)
            this.server.tool(
                'add_row',
                'Add a single row to a table',
                { table: z.string(), row: z.record(z.any()) },
                async ({ table, row }: any) => {
                    const created = await this.client!.addRow(table, row)
                    return { content: [{ type: 'text', text: JSON.stringify(created) }] }
                }
            )
            this.server.tool(
                'update_rows',
                'Batch update rows (optionally create columns)',
                { table: z.string(), updates: z.array(z.object({ row_id: z.string(), values: z.record(z.any()) })), allow_create_columns: z.boolean().optional() },
                async ({ table, updates, allow_create_columns }: any) => {
                    // Reuse existing adapter implementation via client directly
                    // Simplified: sequential updates
                    const results: any[] = []
                    for (const u of updates) {
                        await this.client!.updateRow(table, u.row_id, u.values)
                        const fresh = await this.client!.getRow(table, u.row_id)
                        results.push(fresh)
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ rows: results }) }] }
                }
            )
            this.server.tool(
                'add_row_explicit',
                'Explicit schema version of add_row for diagnostics',
                { table: z.string(), row: z.any() },
                async ({ table, row }: any) => {
                    console.log('[add_row_explicit-handler]', JSON.stringify({ table, row }))
                    if (!table || !row) {
                        return { content: [{ type: 'text', text: JSON.stringify({ error: 'missing table or row', received: { table, row } }) }], isError: true }
                    }
                    const created = await this.client!.addRow(table, row)
                    return { content: [{ type: 'text', text: JSON.stringify({ created }) }] }
                }
            )
            this.server.tool(
                'args_probe',
                'Returns raw received arguments for transport debugging',
                { foo: z.any().optional(), table: z.any().optional(), row: z.any().optional(), marker: z.string().optional() },
                async (args: any) => {
                    console.log('[args_probe-handler]', JSON.stringify({ received: args }))
                    return { content: [{ type: 'text', text: JSON.stringify({ received: args }) }] }
                }
            )

            // append_rows (explicit)
            this.server.tool(
                'append_rows',
                'Batch insert rows. Rejects unknown columns unless allow_create_columns=true',
                { table: z.string(), rows: z.array(z.record(z.any())).min(1), allow_create_columns: z.boolean().optional() },
                async ({ table, rows, allow_create_columns }: any) => {
                    // TODO: enforce schema validation & allow_create_columns behavior (future hardening)
                    const results: any[] = []
                    for (const row of rows) {
                        const res = await this.client!.addRow(table, row)
                        results.push(res)
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ rows: results }) }] }
                }
            )

            // upsert_rows (explicit)
            this.server.tool(
                'upsert_rows',
                'Batch upsert rows by matching on one or more key columns. If match exists update it; else insert.',
                { table: z.string(), key_columns: z.array(z.string()).min(1), rows: z.array(z.record(z.any())).min(1), allow_create_columns: z.boolean().optional() },
                async ({ table, key_columns, rows, allow_create_columns }: any) => {
                    const metadata = await this.client!.getMetadata()
                    const generic = mapMetadataToGeneric(metadata)
                    validateRowsAgainstSchema(generic, table, rows, { allowCreateColumns: allow_create_columns ?? false })
                    const results: Array<{ action: string; row: any }> = []
                    for (const row of rows) {
                        for (const k of key_columns) {
                            if (!(k in row)) {
                                throw makeError('ERR_UPSERT_MISSING_KEY', `Missing key column in row: ${k}`, { key: k })
                            }
                        }
                        const filter: Record<string, unknown> = {}
                        for (const k of key_columns) filter[k] = row[k]
                        const found = await this.client!.searchRows(table, filter)
                        const matches = (found.rows || []).slice(0, 2)
                        if (matches.length > 1) {
                            throw makeError('ERR_UPSERT_AMBIGUOUS', 'Multiple matches for upsert key', { key_columns, filter })
                        }
                        if (matches.length === 1) {
                            const updated = await this.client!.updateRow(table, matches[0]._id, row)
                            results.push({ action: 'updated', row: updated })
                        } else {
                            const inserted = await this.client!.addRow(table, row)
                            results.push({ action: 'inserted', row: inserted })
                        }
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
                }
            )

            // delete_rows (explicit)
            this.server.tool(
                'delete_rows',
                'Delete one or more rows from a table by their IDs',
                { table: z.string(), row_ids: z.array(z.string()).min(1) },
                async ({ table, row_ids }: any) => {
                    const results: any[] = []
                    for (const row_id of row_ids) {
                        const res = await this.client!.deleteRow(table, row_id)
                        results.push({ row_id, success: res.success })
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
                }
            )

            // link_rows (explicit)
            this.server.tool(
                'link_rows',
                'Create links between rows by updating the link column with row IDs',
                { table: z.string(), link_column: z.string(), pairs: z.array(z.object({ from_row_id: z.string(), to_row_id: z.string() })).min(1) },
                async ({ table, link_column, pairs }: any) => {
                    const results: any[] = []
                    for (const { from_row_id, to_row_id } of pairs) {
                        const existing = await this.client!.getRow(table, from_row_id)
                        const current = Array.isArray((existing as any)[link_column]) ? (existing as any)[link_column] as any[] : []
                        const next = Array.from(new Set([...current, to_row_id]))
                        const updated = await this.client!.updateRow(table, from_row_id, { [link_column]: next })
                        results.push({ from_row_id, to_row_id, row: updated })
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
                }
            )

            // unlink_rows (explicit)
            this.server.tool(
                'unlink_rows',
                'Remove links between rows by updating the link column with row IDs',
                { table: z.string(), link_column: z.string(), pairs: z.array(z.object({ from_row_id: z.string(), to_row_id: z.string() })).min(1) },
                async ({ table, link_column, pairs }: any) => {
                    const results: any[] = []
                    for (const { from_row_id, to_row_id } of pairs) {
                        const existing = await this.client!.getRow(table, from_row_id)
                        const current = Array.isArray((existing as any)[link_column]) ? (existing as any)[link_column] as any[] : []
                        const next = current.filter((id: string) => id !== to_row_id)
                        const updated = await this.client!.updateRow(table, from_row_id, { [link_column]: next })
                        results.push({ from_row_id, to_row_id, row: updated })
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] }
                }
            )

            // attach_file_to_row (explicit)
            const FileInput = z.union([
                z.object({ url: z.string().url(), filename: z.string(), content_type: z.string().optional() }),
                z.object({ bytes_base64: z.string(), filename: z.string(), content_type: z.string().optional() }),
            ])
            const MAX_BYTES = 5 * 1024 * 1024
            this.server.tool(
                'attach_file_to_row',
                'Attach a file to a row via URL or base64 bytes (<= 5 MB)',
                { table: z.string(), row_id: z.string(), column: z.string(), file: FileInput },
                async ({ table, row_id, column, file }: any) => {
                    if ('bytes_base64' in file) {
                        const bytes = Buffer.from(file.bytes_base64, 'base64')
                        if (bytes.length > MAX_BYTES) {
                            throw makeError('ERR_FILE_TOO_LARGE', 'Attachment too large (> 5 MB)', { table, row_id, column, filename: file.filename, size: bytes.length })
                        }
                        return { content: [{ type: 'text', text: JSON.stringify({ note: 'upload flow not yet implemented', table, row_id, column, filename: file.filename, size: bytes.length }) }] }
                    } else if ('url' in file) {
                        return { content: [{ type: 'text', text: JSON.stringify({ note: 'server fetch by URL not implemented; provide URL for SeaTable if supported', table, row_id, column, url: file.url }) }] }
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ ok: false }) }] }
                }
            )

            // bulk_set_select_options (explicit)
            this.server.tool(
                'bulk_set_select_options',
                'Bulk update select options for one or more select columns on a table (single_select & multi_select only)',
                { table: z.string(), updates: z.array(z.object({ column: z.string(), options: z.array(z.object({ name: z.string(), color: z.string().optional() })).min(0) })).min(1) },
                async ({ table, updates }: any) => {
                    const meta = await this.client!.getMetadata()
                    const generic = mapMetadataToGeneric(meta)
                    const tbl = generic.tables.find(t => t.name === table)
                    if (!tbl) throw new Error(`Unknown table: ${table}`)
                    const results: any[] = []
                    for (const u of updates) {
                        const col = tbl.columns.find(c => (c as any).name === u.column)
                        if (!col) { results.push({ column: u.column, skipped: true, reason: 'unknown column' }); continue }
                        const hasOptions = !!(col as any).options && Array.isArray((col as any).options.options)
                        if (!hasOptions) { results.push({ column: u.column, skipped: true, reason: 'no selectable options' }); continue }
                        const current = (col as any).options.options as Array<{ id: string, name: string, color?: string }>
                        const toUpdate: Array<{ id: string; name?: string; color?: string }> = []
                        for (const opt of u.options) {
                            const match = current.find(c => c.name === opt.name)
                            if (match) toUpdate.push({ id: match.id, name: opt.name, color: opt.color })
                        }
                        if (toUpdate.length === 0) { results.push({ column: u.column, skipped: true, reason: 'no matching option ids by name' }); continue }
                        const res = await (this.client as any).updateSelectOptions(table, u.column, toUpdate)
                        results.push({ column: u.column, result: res })
                    }
                    const metaAfter = await this.client!.getMetadata()
                    const genericAfter = mapMetadataToGeneric(metaAfter)
                    const updatedTable = genericAfter.tables.find(t => t.name === table)
                    return { content: [{ type: 'text', text: JSON.stringify({ results, schema: updatedTable }) }] }
                }
            )
            console.log('Explicit diagnostic tools registered (add_row_explicit, args_probe)')
        } catch (e) {
            console.error('Failed registering explicit probe tools', e)
        }
        
        console.info('All tools registered successfully')
    }

    private registerResources(): void {
        // Register table schema resource
        this.server.resource(
            'table-schema',
            'mcp://resource/table-schema/{table}',
            async (uri) => {
                try {
                    const url = new URL(uri.href)
                    const table = url.pathname.split('/').pop()
                    
                    if (!table || !this.client) {
                        throw new Error('Table name required or client not initialized')
                    }
                    
                    // Get table schema using existing client methods
                    const metadata = await this.client.getMetadata()
                    
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                table,
                                metadata,
                                timestamp: new Date().toISOString()
                            })
                        }]
                    }
                } catch (error) {
                    console.error('Failed to get table schema resource:', { error, uri: uri.href })
                    throw error
                }
            }
        )

        // Register base info resource
        this.server.resource(
            'base-info',
            'mcp://resource/base-info',
            async (uri) => {
                try {
                    if (!this.client) {
                        throw new Error('Client not initialized')
                    }
                    
                    const [tables, metadata] = await Promise.all([
                        this.client.listTables(),
                        this.client.getMetadata()
                    ])
                    
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                tables: tables.map(t => ({ name: t.name, _id: t._id })),
                                metadata,
                                timestamp: new Date().toISOString()
                            })
                        }]
                    }
                } catch (error) {
                    console.error('Failed to get base info resource:', { error, uri: uri.href })
                    throw error
                }
            }
        )
        
        console.info('Resources registered successfully')
    }

    async cleanup(): Promise<void> {
        try {
            clearEnvOverrides()
            console.info('SeaTable MCP Agent cleanup complete')
        } catch (error) {
            console.error('Error during cleanup:', error)
        }
    }
}