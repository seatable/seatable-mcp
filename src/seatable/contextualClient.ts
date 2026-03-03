import type { ClientLike } from '../mcp/tools/types.js'
import type { ClientRegistry } from './clientRegistry.js'

/**
 * A ClientLike proxy that delegates to a specific base client
 * based on the currently set base name. This avoids modifying
 * every tool file — the base parameter is extracted centrally
 * in handleCallTool() and applied via setBase().
 */
export class ContextualClient implements ClientLike {
    private readonly registry: ClientRegistry
    private currentBase?: string

    constructor(registry: ClientRegistry) {
        this.registry = registry
    }

    setBase(name?: string): void {
        this.currentBase = name
    }

    private get client(): ClientLike {
        return this.registry.resolve(this.currentBase)
    }

    // Tables
    listTables() { return this.client.listTables() }

    // Metadata
    getMetadata() { return this.client.getMetadata() }

    // Rows
    listRows(query: { table: string; page?: number; page_size?: number; view?: string }) { return this.client.listRows(query) }
    getRow(table: string, rowId: string) { return this.client.getRow(table, rowId) }
    addRow(table: string, row: Record<string, unknown>) { return this.client.addRow(table, row) }
    updateRow(table: string, rowId: string, row: Record<string, unknown>) { return this.client.updateRow(table, rowId, row) }
    deleteRow(table: string, rowId: string) { return this.client.deleteRow(table, rowId) }
    searchRows(table: string, query: Record<string, unknown>) { return this.client.searchRows(table, query) }

    // SQL
    querySql(sql: string, parameters?: any[]) { return this.client.querySql(sql, parameters) }

    // Collaborators
    listCollaborators() { return this.client.listCollaborators() }

    // Links
    createLinks(args: { table: string; linkColumn: string; pairs: Array<{ fromRowId: string; toRowId: string }> }) { return this.client.createLinks(args) }
    deleteLinks(args: { table: string; linkColumn: string; pairs: Array<{ fromRowId: string; toRowId: string }> }) { return this.client.deleteLinks(args) }

    // File upload
    uploadFile(args: { table: string; column: string; rowId: string; fileName: string; fileData: string; replace?: boolean }) { return this.client.uploadFile(args) }
}
