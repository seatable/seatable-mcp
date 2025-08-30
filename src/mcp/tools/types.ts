// Minimal server interface we rely on
export type McpServerLike = {
    // Accept any registerTool signature to stay compatible with SDK
    registerTool: (...args: any[]) => any
}

import type { Env } from '../../config/env.js'

// Client shape used by tools (structural typing over concrete class)
export interface ClientLike {
    // Tables
    listTables(): Promise<Array<{ name: string; _id: string }>>
    createTable(tableName: string, columns?: Array<Record<string, unknown>>): Promise<{ name: string }>
    renameTable(from: string, to: string): Promise<{ name: string }>
    deleteTable(name: string): Promise<{ success: boolean }>

    // Columns
    createColumn(table: string, column: Record<string, unknown>): Promise<any>
    updateColumn(table: string, columnName: string, patch: Record<string, unknown>): Promise<any>
    deleteColumn(table: string, columnName: string): Promise<{ success: boolean }>

    // Metadata
    getMetadata(): Promise<any>

    // Rows
    listRows(query: { table: string; page?: number; page_size?: number; filter?: Record<string, unknown>; search?: string; view?: string; order_by?: string; direction?: 'asc' | 'desc' }): Promise<{ rows: any[]; page?: number; page_size?: number; total?: number }>
    getRow(table: string, rowId: string): Promise<any>
    addRow(table: string, row: Record<string, unknown>): Promise<any>
    updateRow(table: string, rowId: string, row: Record<string, unknown>): Promise<any>
    deleteRow(table: string, rowId: string): Promise<{ success: boolean }>
    searchRows(table: string, query: Record<string, unknown>): Promise<{ rows: any[]; page?: number; page_size?: number; total?: number }>
    // SQL
    querySql(sql: string, parameters?: any[]): Promise<{ metadata: any; results: any[] }>
}

export type ToolRegistrar = (
    server: McpServerLike,
    deps: { client: ClientLike; env: Env; getInputSchema: (schema: any) => any }
) => void
