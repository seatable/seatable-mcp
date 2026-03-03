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

    // Collaborators
    listCollaborators(): Promise<Array<{ email: string; name: string }>>
}

export type ToolDeps = { client: ClientLike; env: Env; getInputSchema: (schema: any) => any; baseNames?: string[] }

export type ToolRegistrar = (
    server: McpServerLike,
    deps: ToolDeps
) => void
