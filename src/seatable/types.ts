// SeaTable API Types (simplified)

export interface SeaTableTable {
    name: string
    _id: string
}

export interface SeaTableRow {
    _id: string
    _rev?: number
    [key: string]: unknown
}

export interface ListRowsResponse {
    rows: SeaTableRow[]
    page?: number
    page_size?: number
    total?: number
    has_more?: boolean
}

export interface SeaTableError {
    code?: number
    message: string
    data?: unknown
}
