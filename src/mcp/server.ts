/* eslint-disable simple-import-sort/imports */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getEnv } from '../config/env.js'
import { logger } from '../logger.js'
import { SeaTableClient } from '../seatable/client.js'
import { MockSeaTableClient } from '../seatable/mockClient.js'

import { registerAppendRows } from './tools/appendRows.js'
import { registerAttachFileToRow } from './tools/attachFileToRow.js'
import { registerBulkSetSelectOptions } from './tools/bulkSetSelectOptions.js'
import { registerDeleteRows } from './tools/deleteRow.js'
import { registerFindRows } from './tools/findRows.js'
import { registerGetRow } from './tools/getRow.js'
import { registerGetSchema } from './tools/getSchema.js'
import { registerLinkRows } from './tools/linkRows.js'
import { registerListRows } from './tools/listRows.js'
import { registerListTables } from './tools/listTables.js'
import { registerManageColumns } from './tools/manageColumns.js'
import { registerManageTables } from './tools/manageTables.js'
import { registerPingSeatable } from './tools/pingSeatable.js'
import { registerUnlinkRows } from './tools/unlinkRows.js'
import { registerUpdateRows } from './tools/updateRow.js'
import { registerUpsertRows } from './tools/upsertRows.js'

export function buildServer() {
    const env = getEnv()
    const server = new McpServer({ name: 'mcp-seatable', version: '0.1.0' })
    const client = (env.SEATABLE_MOCK ? new MockSeaTableClient() : new SeaTableClient()) as unknown as SeaTableClient

    // Register tools (strictly per plan)
    registerListTables(server, { client, env })
    registerListRows(server, { client, env })
    registerGetRow(server, { client, env })
    registerAppendRows(server, { client, env })
    registerUpdateRows(server, { client, env })
    registerDeleteRows(server, { client, env })
    registerUpsertRows(server, { client, env })
    registerManageColumns(server, { client, env })
    registerManageTables(server, { client, env })
    registerLinkRows(server, { client, env })
    registerUnlinkRows(server, { client, env })
    registerAttachFileToRow(server, { client, env })
    registerPingSeatable(server, { client, env })
    registerGetSchema(server, { client, env })
    registerFindRows(server, { client, env })
    registerBulkSetSelectOptions(server, { client, env })

    logger.info('MCP server built')
    return server
}
