import type { ListRowsResponse, SeaTableRow, SeaTableTable } from './types.js'

// A simple in-memory mock implementation for testing and DX.
export class MockSeaTableClient {
  private tables: Map<string, { id: string; rows: Map<string, SeaTableRow>; columns: Set<string> }>

  constructor() {
    this.tables = new Map()
    // default table for convenience
    this.ensureTable('Table1')
  }

  private ensureTable(name: string) {
    if (!this.tables.has(name)) {
      this.tables.set(name, { id: `tbl_${name}`, rows: new Map(), columns: new Set(['Name']) })
    }
  }

  async listTables(): Promise<SeaTableTable[]> {
    return Array.from(this.tables.entries()).map(([name, t]) => ({ name, _id: t.id }))
  }

  async getMetadata(): Promise<any> {
    return {
      tables: Array.from(this.tables.entries()).map(([name, t]) => ({
        name,
        _id: t.id,
        columns: Array.from(t.columns).map((c, i) => ({ name: c, key: `col_${i}`, type: 'text' })),
      })),
    }
  }

  async listRows(query: { table: string; page?: number; page_size?: number; view?: string }): Promise<ListRowsResponse> {
    const t = this.tables.get(query.table)
    if (!t) return { rows: [] }
    const rows = Array.from(t.rows.values())
    const page = query.page ?? 1
    const pageSize = query.page_size ?? 100
    const start = (page - 1) * pageSize
    const end = start + pageSize
    const slice = rows.slice(start, end)
    return { rows: slice, page, page_size: pageSize, has_more: end < rows.length }
  }

  async getRow(table: string, rowId: string): Promise<SeaTableRow> {
    const t = this.tables.get(table)
    if (!t) throw new Error('mock: table not found')
    const r = t.rows.get(rowId)
    if (!r) throw new Error('mock: row not found')
    return r
  }

  async addRow(table: string, row: Record<string, unknown>): Promise<SeaTableRow> {
    this.ensureTable(table)
    const t = this.tables.get(table)!
    const id = `row_${t.rows.size + 1}`
    const newRow: SeaTableRow = { _id: id, ...row }
    t.rows.set(id, newRow)
    return newRow
  }

  async updateRow(table: string, rowId: string, row: Record<string, unknown>): Promise<SeaTableRow> {
    const t = this.tables.get(table)
    if (!t) throw new Error('mock: table not found')
    const existing = t.rows.get(rowId)
    if (!existing) throw new Error('mock: row not found')
    const updated = { ...existing, ...row }
    t.rows.set(rowId, updated)
    return updated as SeaTableRow
  }

  async deleteRow(table: string, rowId: string): Promise<{ success: boolean }> {
    const t = this.tables.get(table)
    if (!t) return { success: false }
    t.rows.delete(rowId)
    return { success: true }
  }

  async searchRows(table: string, query: Record<string, unknown>): Promise<ListRowsResponse> {
    const t = this.tables.get(table)
    if (!t) return { rows: [] }
    const rows = Array.from(t.rows.values()).filter((r) =>
      Object.entries(query).every(([k, v]) => (r as any)[k] === v)
    )
    return { rows, page: 1, page_size: rows.length, has_more: false }
  }

  async querySql(sql: string, parameters?: any[]): Promise<{ metadata: any; results: any[] }> {
    // Mock implementation - just return empty results for now
    return {
      metadata: {
        table_count: this.tables.size,
        sql_query: sql,
        parameters: parameters || []
      },
      results: []
    }
  }

  async listCollaborators(): Promise<Array<{ email: string; name: string }>> {
    return [
      { email: 'admin@example.com', name: 'Admin User' },
      { email: 'user1@example.com', name: 'Test User' },
    ]
  }

  async createLinks(args: {
    table: string; linkColumn: string;
    pairs: Array<{ fromRowId: string; toRowId: string }>
  }): Promise<any> {
    return { success: true }
  }

  async deleteLinks(args: {
    table: string; linkColumn: string;
    pairs: Array<{ fromRowId: string; toRowId: string }>
  }): Promise<any> {
    return { success: true }
  }

  async addColumnOptions(args: {
    table: string; column: string;
    options: Array<{ name: string; color?: string; textColor?: string }>
  }): Promise<any> {
    return { success: true }
  }

  async uploadFile(args: {
    table: string; column: string; rowId: string;
    fileName: string; fileData: string; replace?: boolean
  }): Promise<{ file_name: string; file_size: number; asset_url: string; column_type: string }> {
    return {
      file_name: args.fileName,
      file_size: Buffer.from(args.fileData, 'base64').length,
      asset_url: `/workspace/1/asset/mock-uuid/images/${args.fileName}`,
      column_type: 'image',
    }
  }
}
