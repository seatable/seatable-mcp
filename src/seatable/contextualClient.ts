import { AsyncLocalStorage } from 'node:async_hooks'

import type { ClientLike } from '../mcp/tools/types.js'
import type { ClientRegistry } from './clientRegistry.js'

/**
 * The store is an object rather than the bare name so that "no scope at all"
 * (getStore() === undefined) stays distinguishable from "in a scope, no base
 * named" ({ base: undefined }). Those two need very different errors.
 */
const baseContext = new AsyncLocalStorage<{ base?: string }>()

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
        return baseContext.run({ base: name }, fn)
    }

    /**
     * Resolving outside a runWithBase() scope is always a programming error, and
     * it used to hide well: with a single base it quietly succeeded via the
     * registry default, and only with two or more did it surface — as "Specify
     * base parameter", which blames the caller for omitting an argument they
     * did supply. It cost five months to find that way once, so it is named
     * here and fails the same way whatever the base count.
     */
    private get client(): ClientLike {
        const store = baseContext.getStore()
        if (!store) {
            throw new Error(
                'ContextualClient was used outside runWithBase(). The base context only exists for the '
                + 'duration of that scope — read what you need inside it rather than after it returns.'
            )
        }
        return this.registry.resolve(store.base)
    }

    // Base info
    getBaseInfo() { return this.client.getBaseInfo?.() ?? {} }

    // Tables
    listTables() { return this.client.listTables() }

    // Metadata
    getMetadata() { return this.client.getMetadata() }
    clearMetadataCache() { this.client.clearMetadataCache?.() }

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
