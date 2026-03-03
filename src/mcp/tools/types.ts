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
    listRows(query: { table: string; page?: number; page_size?: number; view?: string }): Promise<{ rows: any[]; page?: number; page_size?: number; total?: number; has_more?: boolean }>
    getRow(table: string, rowId: string): Promise<any>
    addRow(table: string, row: Record<string, unknown>): Promise<any>
    updateRow(table: string, rowId: string, row: Record<string, unknown>): Promise<any>
    deleteRow(table: string, rowId: string): Promise<{ success: boolean }>
    searchRows(table: string, query: Record<string, unknown>): Promise<{ rows: any[]; page?: number; page_size?: number; total?: number; has_more?: boolean }>

    // SQL
    querySql(sql: string, parameters?: any[]): Promise<{ metadata: any; results: any[] }>

    // Collaborators
    listCollaborators(): Promise<Array<{ email: string; name: string }>>

    // Links
    createLinks(args: { table: string; linkColumn: string; pairs: Array<{ fromRowId: string; toRowId: string }> }): Promise<any>
    deleteLinks(args: { table: string; linkColumn: string; pairs: Array<{ fromRowId: string; toRowId: string }> }): Promise<any>

    // Column options
    addColumnOptions(args: { table: string; column: string; options: Array<{ name: string; color?: string; textColor?: string }> }): Promise<any>

    // File upload
    uploadFile(args: {
        table: string; column: string; rowId: string;
        fileName: string; fileData: string; replace?: boolean
    }): Promise<{ file_name: string; file_size: number; asset_url: string; column_type: string }>
}

export type ToolDeps = { client: ClientLike; env: Env; getInputSchema: (schema: any) => any; baseNames?: string[] }

export type ToolRegistrar = (
    server: McpServerLike,
    deps: ToolDeps
) => void
