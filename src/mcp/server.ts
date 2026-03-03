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
import type { McpServerLike, ClientLike } from './tools/types.js'

// Tool registrars
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
    private readonly client: SeaTableClient
    private readonly tools = new Map<string, RegisteredTool>()

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
        const deps = { client: this.client as unknown as ClientLike, env, getInputSchema }

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
        return {
            tools: Array.from(this.tools.values()).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            })),
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

export function buildServer() {
    const env = getEnv()
    const client = (env.SEATABLE_MOCK ? new MockSeaTableClient() : new SeaTableClient()) as unknown as SeaTableClient

    const server = new SeaTableMCPServer(client)

    logger.info('MCP server built')
    return server
}
