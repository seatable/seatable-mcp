import { AsyncLocalStorage } from 'node:async_hooks'

import type { ClientLike } from '../mcp/tools/types.js'
import type { ClientRegistry } from './clientRegistry.js'

const baseContext = new AsyncLocalStorage<string | undefined>()

/**
 * A ClientLike proxy that delegates to a specific base client
 * based on the async context set via runWithBase(). This ensures
 * thread-safe routing even with concurrent tool calls — each call
 * gets its own isolated base context via AsyncLocalStorage.
 */
export class ContextualClient implements ClientLike {
    private readonly registry: ClientRegistry

    constructor(registry: ClientRegistry) {
        this.registry = registry
    }

    /**
     * Run a function with the given base name bound to the async context.
     * All client method calls within `fn` (including across await boundaries)
     * will route to the specified base.
     */
    runWithBase<T>(name: string | undefined, fn: () => T): T {
        return baseContext.run(name, fn)
    }

    private get client(): ClientLike {
        return this.registry.resolve(baseContext.getStore())
    }

    // Base info
    getBaseInfo() { return this.client.getBaseInfo?.() ?? {} }

    // Tables
    listTables() { return this.client.listTables() }

    // Metadata
    getMetadata() { return this.client.getMetadata() }

    // Rows
    listRows(query: { table: string; page?: number; page_size?: number }) { return this.client.listRows(query) }
    getRow(table: string, rowId: string) { return this.client.getRow(table, rowId) }
    addRow(table: string, row: Record<string, unknown>) { return this.client.addRow(table, row) }
    addRows(table: string, rows: Array<Record<string, unknown>>) { return this.client.addRows(table, rows) }
    updateRow(table: string, rowId: string, row: Record<string, unknown>) { return this.client.updateRow(table, rowId, row) }
    updateRows(table: string, updates: Array<{ row_id: string; row: Record<string, unknown> }>) { return this.client.updateRows(table, updates) }
    deleteRow(table: string, rowId: string) { return this.client.deleteRow(table, rowId) }
    deleteRows(table: string, rowIds: string[]) { return this.client.deleteRows(table, rowIds) }
    searchRows(table: string, query: Record<string, unknown>) { return this.client.searchRows(table, query) }

    // SQL
    querySql(sql: string, parameters?: any[]) { return this.client.querySql(sql, parameters) }

    // Collaborators
    listCollaborators() { return this.client.listCollaborators() }

    // Links
    createLinks(args: { table: string; linkColumn: string; pairs: Array<{ fromRowId: string; toRowId: string }> }) { return this.client.createLinks(args) }
    deleteLinks(args: { table: string; linkColumn: string; pairs: Array<{ fromRowId: string; toRowId: string }> }) { return this.client.deleteLinks(args) }

    // Column options
    addColumnOptions(args: { table: string; column: string; options: Array<{ name: string; color?: string; textColor?: string }> }) { return this.client.addColumnOptions(args) }

    // Row activities
    getRowActivities(rowId: string, page?: number) { return this.client.getRowActivities(rowId, page) }

    // Snapshots
    createSnapshot() { return this.client.createSnapshot() }

    // File upload
    uploadFile(args: { table: string; column: string; rowId: string; fileName: string; fileData: string; replace?: boolean }) { return this.client.uploadFile(args) }

    // File download
    downloadFile(args: { table: string; column: string; rowId: string; fileName?: string }) { return this.client.downloadFile(args) }
}
