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

import { getEnv, parseBases } from '../config/env.js'
import { logger } from '../logger.js'
import { SeaTableClient, createClientFromEnv, createClientFromToken } from '../seatable/client.js'
import { ClientRegistry } from '../seatable/clientRegistry.js'
import { ContextualClient } from '../seatable/contextualClient.js'
import { MockSeaTableClient } from '../seatable/mockClient.js'
import type { McpServerLike, ClientLike } from './tools/types.js'

// Tool registrars
import { registerListBases } from './tools/listBases.js'
import { registerAddRow } from './tools/addRow.js'
import { registerAppendRows } from './tools/appendRows.js'
import { registerAttachFileToRow } from './tools/attachFileToRow.js'
import { registerBulkSetSelectOptions } from './tools/bulkSetSelectOptions.js'
import { registerDeleteRows } from './tools/deleteRow.js'
import { registerEchoArgs } from './tools/echoArgs.js'
import { registerFindRows } from './tools/findRows.js'
import { registerGetRow } from './tools/getRow.js'
import { registerGetSchema } from './tools/getSchema.js'
import { registerLinkRows } from './tools/linkRows.js'
import { registerListRows } from './tools/listRows.js'
import { registerListTables } from './tools/listTables.js'
import { registerManageColumns } from './tools/manageColumns.js'
import { registerManageTables } from './tools/manageTables.js'
import { registerPingSeatable } from './tools/pingSeatable.js'
import { registerQuerySql } from './tools/querySql.js'
import { registerSearchRows } from './tools/searchRows.js'
import { registerUnlinkRows } from './tools/unlinkRows.js'
import { registerUpdateRows } from './tools/updateRow.js'
import { registerUpsertRows } from './tools/upsertRows.js'

// Helper function to convert Zod schemas to JSON Schema for MCP tools
const getInputSchema = (schema: z.ZodType<object>): ListToolsResult['tools'][0]['inputSchema'] => {
    const jsonSchema = zodToJsonSchema(schema, {
        target: 'jsonSchema7',
        strictUnions: true
    })

    if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
        throw new Error(`Invalid input schema: expected an object but got ${
            'type' in jsonSchema ? String(jsonSchema.type) : 'no type'
        }`)
    }

    // Allow additional properties to prevent validation errors in MCP clients
    return {
        ...jsonSchema,
        type: 'object',
        additionalProperties: true
    }
}

interface RegisteredTool {
    name: string
    description: string
    inputSchema: any
    handler: (args: unknown) => Promise<CallToolResult>
}

export class SeaTableMCPServer {
    private readonly server: Server
    private readonly client: ClientLike
    private readonly contextualClient?: ContextualClient
    private readonly baseNames?: string[]
    private readonly tools = new Map<string, RegisteredTool>()

    constructor(client: ClientLike, multiBase?: { contextualClient: ContextualClient; baseNames: string[] }) {
        this.client = client
        if (multiBase) {
            this.contextualClient = multiBase.contextualClient
            this.baseNames = multiBase.baseNames
        }
        this.server = new Server(
            {
                name: '@aspereo/mcp-seatable',
                version: '0.1.1',
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        )
        this.registerAllTools()
        this.initializeHandlers()
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport)
    }

    async close(): Promise<void> {
        await this.server.close()
    }

    private registerAllTools(): void {
        const env = getEnv()
        const deps = { client: this.client, env, getInputSchema, baseNames: this.baseNames }

        // Adapter: collects registerTool calls into our internal Map
        const serverAdapter: McpServerLike = {
            registerTool: (name: string, config: any, handler: any) => {
                this.tools.set(name, {
                    name,
                    description: config.description || config.title || name,
                    inputSchema: config.inputSchema,
                    handler,
                })
            }
        }

        // Multi-base: register list_bases tool
        if (this.baseNames) {
            registerListBases(serverAdapter, deps)
        }

        // Register all tools via shared registrars
        registerListTables(serverAdapter, deps)
        registerListRows(serverAdapter, deps)
        registerGetRow(serverAdapter, deps)
        registerAddRow(serverAdapter, deps)
        registerAppendRows(serverAdapter, deps)
        registerUpdateRows(serverAdapter, deps)
        registerDeleteRows(serverAdapter, deps)
        registerFindRows(serverAdapter, deps)
        registerSearchRows(serverAdapter, deps)
        registerUpsertRows(serverAdapter, deps)
        registerLinkRows(serverAdapter, deps)
        registerUnlinkRows(serverAdapter, deps)
        registerGetSchema(serverAdapter, deps)
        registerManageTables(serverAdapter, deps)
        registerManageColumns(serverAdapter, deps)
        registerQuerySql(serverAdapter, deps)
        registerPingSeatable(serverAdapter, deps)
        registerAttachFileToRow(serverAdapter, deps)
        registerBulkSetSelectOptions(serverAdapter, deps)

        // Debug tools (gated by feature flag)
        if (env.SEATABLE_ENABLE_DEBUG_TOOLS) {
            registerEchoArgs(serverAdapter, deps)
        }

        logger.info({ toolCount: this.tools.size }, 'Tools registered')
    }

    private initializeHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, this.handleListTools.bind(this))
        this.server.setRequestHandler(CallToolRequestSchema, this.handleCallTool.bind(this))
    }

    private async handleListTools(): Promise<ListToolsResult> {
        const isMultiBase = this.baseNames && this.baseNames.length > 1
        return {
            tools: Array.from(this.tools.values()).map(tool => {
                const schema = { ...tool.inputSchema }
                // Dynamically inject "base" property for multi-base mode
                if (isMultiBase && tool.name !== 'list_bases') {
                    schema.properties = {
                        base: {
                            type: 'string',
                            description: `Target base name. Available: ${this.baseNames!.join(', ')}`,
                            enum: this.baseNames,
                        },
                        ...schema.properties,
                    }
                }
                return {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: schema,
                }
            }),
        }
    }

    private async handleCallTool(request: z.infer<typeof CallToolRequestSchema>): Promise<CallToolResult> {
        const toolName = request.params.name
        const tool = this.tools.get(toolName)

        if (!tool) {
            return {
                content: [{ type: 'text', text: JSON.stringify(`Unknown tool: ${toolName}`) }],
                isError: true,
            }
        }

        try {
            // Multi-base: extract base param and set on contextual client
            if (this.contextualClient) {
                const args = request.params.arguments as Record<string, unknown> | undefined
                const baseName = args?.base as string | undefined
                this.contextualClient.setBase(baseName)
            }
            return await tool.handler(request.params.arguments)
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        `Error in tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`
                    ),
                }],
                isError: true,
            }
        }
    }
}

export interface BuildServerOptions {
    apiToken?: string
}

export function buildServer(options?: BuildServerOptions) {
    const env = getEnv()

    if (env.SEATABLE_MOCK) {
        const client = new MockSeaTableClient() as unknown as ClientLike
        const server = new SeaTableMCPServer(client)
        logger.info('MCP server built (mock)')
        return server
    }

    if (options?.apiToken) {
        const client = createClientFromToken(options.apiToken) as unknown as ClientLike
        const server = new SeaTableMCPServer(client)
        logger.info('MCP server built (managed)')
        return server
    }

    // Multi-base mode: SEATABLE_BASES is set
    if (env.SEATABLE_BASES) {
        const bases = parseBases(env.SEATABLE_BASES)
        const registry = new ClientRegistry(bases, {
            serverUrl: env.SEATABLE_SERVER_URL,
            timeoutMs: env.HTTP_TIMEOUT_MS,
        })
        const contextualClient = new ContextualClient(registry)
        const server = new SeaTableMCPServer(contextualClient, {
            contextualClient,
            baseNames: registry.baseNames,
        })
        logger.info({ bases: registry.baseNames }, 'MCP server built (multi-base)')
        return server
    }

    // Single-base selfhosted mode
    const client = createClientFromEnv() as unknown as ClientLike
    const server = new SeaTableMCPServer(client)
    logger.info('MCP server built')
    return server
}
