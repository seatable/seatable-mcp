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

  async createTable(tableName: string, _columns?: Array<Record<string, unknown>>): Promise<{ name: string }> {
    this.ensureTable(tableName)
    return { name: tableName }
  }
  async renameTable(from: string, to: string): Promise<{ name: string }> {
    const t = this.tables.get(from)
    if (!t) throw new Error('mock: table not found')
    this.tables.set(to, t)
    this.tables.delete(from)
    return { name: to }
  }
  async deleteTable(name: string): Promise<{ success: boolean }> {
    this.tables.delete(name)
    return { success: true }
  }

  async createColumn(table: string, column: Record<string, unknown>) {
    this.ensureTable(table)
    const t = this.tables.get(table)!
    const name = String((column as any).column_name || (column as any).name || 'Unnamed')
    t.columns.add(name)
    return { name }
  }
  async updateColumn(table: string, _columnName: string, patch: Record<string, unknown>) {
    this.ensureTable(table)
    const t = this.tables.get(table)!
    if (patch && (patch as any).new_column_name) {
      const from = String(_columnName)
      const to = String((patch as any).new_column_name)
      if (t.columns.has(from)) {
        t.columns.delete(from)
        t.columns.add(to)
      }
    }
    return { success: true }
  }
  async deleteColumn(table: string, columnName: string) {
    this.ensureTable(table)
    const t = this.tables.get(table)!
    t.columns.delete(columnName)
    return { success: true }
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

  async listRows(query: { table: string; page?: number; page_size?: number; filter?: Record<string, unknown> }): Promise<ListRowsResponse> {
    const t = this.tables.get(query.table)
    if (!t) return { rows: [] }
    let rows = Array.from(t.rows.values())
    if (query.filter) {
      rows = rows.filter((r) => Object.entries(query.filter!).every(([k, v]) => (r as any)[k] === v))
    }
    const page = query.page ?? 1
    const pageSize = query.page_size ?? 100
    const start = (page - 1) * pageSize
    const end = start + pageSize
    return { rows: rows.slice(start, end), page, page_size: pageSize, total: rows.length }
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
    return this.listRows({ table, filter: query })
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
}
