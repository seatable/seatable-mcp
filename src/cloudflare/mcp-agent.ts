import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { clearEnvOverrides, setEnvOverrides, getEnv } from '../config/env.js'
import { logger } from '../logger.js'
import { SeaTableClient } from '../seatable/client.js'
import { MockSeaTableClient } from '../seatable/mockClient.js'

// Import all tool registrars
import { registerPingSeatable } from '../mcp/tools/pingSeatable.js'
import { registerGetSchema } from '../mcp/tools/getSchema.js'
import { registerListTables } from '../mcp/tools/listTables.js'
import { registerListRows } from '../mcp/tools/listRows.js'
import { registerGetRow } from '../mcp/tools/getRow.js'
import { registerAddRow } from '../mcp/tools/addRow.js'
import { registerAppendRows } from '../mcp/tools/appendRows.js'
import { registerUpdateRows } from '../mcp/tools/updateRow.js'
import { registerDeleteRows } from '../mcp/tools/deleteRow.js'
import { registerUpsertRows } from '../mcp/tools/upsertRows.js'
import { registerFindRows } from '../mcp/tools/findRows.js'
import { registerSearchRows } from '../mcp/tools/searchRows.js'
import { registerLinkRows } from '../mcp/tools/linkRows.js'
import { registerUnlinkRows } from '../mcp/tools/unlinkRows.js'
import { registerManageColumns } from '../mcp/tools/manageColumns.js'
import { registerManageTables } from '../mcp/tools/manageTables.js'
import { registerAttachFileToRow } from '../mcp/tools/attachFileToRow.js'
import { registerBulkSetSelectOptions } from '../mcp/tools/bulkSetSelectOptions.js'

// Helper function to convert Zod schemas to JSON Schema for MCP tools
const getInputSchema = (schema: z.ZodType<object>) => {
    const jsonSchema = zodToJsonSchema(schema)
    
    if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
        throw new Error(`Invalid input schema: expected an object but got ${
            'type' in jsonSchema ? String(jsonSchema.type) : 'no type'
        }`)
    }
    
    return { ...jsonSchema, type: 'object' }
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
        version: '1.0.2' 
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
                // Convert the config to the new MCP Agent pattern
                const description = config.description || config.title || name
                
                // Use empty object schema - the handler will do its own validation
                this.server.tool(name, description, {}, async (args: any, extra: any) => {
                    try {
                        const result = await handler(args)
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
                })
            }
        }

        // Register all tools
        registerPingSeatable(serverAdapter, deps)
        registerGetSchema(serverAdapter, deps)
        registerListTables(serverAdapter, deps)
        registerListRows(serverAdapter, deps)
        registerGetRow(serverAdapter, deps)
        registerAddRow(serverAdapter, deps)
        registerAppendRows(serverAdapter, deps)
        registerUpdateRows(serverAdapter, deps)
        registerDeleteRows(serverAdapter, deps)
        registerUpsertRows(serverAdapter, deps)
        registerFindRows(serverAdapter, deps)
        registerSearchRows(serverAdapter, deps)
        registerLinkRows(serverAdapter, deps)
        registerUnlinkRows(serverAdapter, deps)
        registerManageColumns(serverAdapter, deps)
        registerManageTables(serverAdapter, deps)
        registerAttachFileToRow(serverAdapter, deps)
        registerBulkSetSelectOptions(serverAdapter, deps)
        
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