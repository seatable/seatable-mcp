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
    createTable(tableName: string, columns?: Array<Record<string, unknown>>) { return this.client.createTable(tableName, columns) }
    renameTable(from: string, to: string) { return this.client.renameTable(from, to) }
    deleteTable(name: string) { return this.client.deleteTable(name) }

    // Columns
    createColumn(table: string, column: Record<string, unknown>) { return this.client.createColumn(table, column) }
    updateColumn(table: string, columnName: string, patch: Record<string, unknown>) { return this.client.updateColumn(table, columnName, patch) }
    deleteColumn(table: string, columnName: string) { return this.client.deleteColumn(table, columnName) }

    // Metadata
    getMetadata() { return this.client.getMetadata() }

    // Rows
    listRows(query: { table: string; page?: number; page_size?: number; filter?: Record<string, unknown>; search?: string; view?: string; order_by?: string; direction?: 'asc' | 'desc' }) { return this.client.listRows(query) }
    getRow(table: string, rowId: string) { return this.client.getRow(table, rowId) }
    addRow(table: string, row: Record<string, unknown>) { return this.client.addRow(table, row) }
    updateRow(table: string, rowId: string, row: Record<string, unknown>) { return this.client.updateRow(table, rowId, row) }
    deleteRow(table: string, rowId: string) { return this.client.deleteRow(table, rowId) }
    searchRows(table: string, query: Record<string, unknown>) { return this.client.searchRows(table, query) }

    // SQL
    querySql(sql: string, parameters?: any[]) { return this.client.querySql(sql, parameters) }

    // Select options
    updateSelectOptions(table: string, column: string, options: any[], return_options?: boolean) { return this.client.updateSelectOptions(table, column, options, return_options) }
}
