import axios, { AxiosInstance } from 'axios'
import axiosRetry from 'axios-retry'
import Bottleneck from 'bottleneck'
import { z } from 'zod'

import { getEnv } from '../config/env.js'
import { toCodedAxiosError } from '../errors.js'
import { logger } from '../logger.js'
import { seatableApiDurationSeconds, seatableApiRequestsTotal } from '../metrics/index.js'
import { TokenManager } from './tokenManager.js'
import { ListRowsResponse, SeaTableRow, SeaTableTable } from './types.js'
import { logAxiosError } from './utils.js'

export interface SeaTableClientConfig {
    serverUrl: string
    apiToken: string
    timeoutMs?: number
}

const ListRowsQuerySchema = z.object({
    table: z.string(),
    page: z.number().int().min(1).default(1),
    page_size: z.number().int().min(1).max(1000).default(100),
})
export type ListRowsQuery = z.infer<typeof ListRowsQuerySchema>

/** Escape backticks in SQL identifiers to prevent injection. */
export function sanitizeIdentifier(name: string): string {
    return name.replace(/`/g, '``')
}

export class SeaTableClient {
    private readonly tokenManager: TokenManager
    private readonly limiter: Bottleneck
    private readonly serverUrl: string
    private readonly apiToken: string
    private readonly timeoutMs: number

    private http?: AxiosInstance
    private initialized = false
    private initializing?: Promise<void>

    constructor(config: SeaTableClientConfig) {
        this.serverUrl = config.serverUrl.replace(/\/$/, '')
        this.apiToken = config.apiToken
        this.timeoutMs = config.timeoutMs ?? 30000

        this.tokenManager = new TokenManager({
            serverUrl: this.serverUrl,
            apiToken: config.apiToken,
            timeoutMs: config.timeoutMs,
        })

        this.limiter = new Bottleneck({ maxConcurrent: 1, minTime: 200 }) // 5 RPS

        logger.debug({ serverUrl: this.serverUrl }, 'SeaTableClient created')
    }

    /** Returns dtable_uuid and app_name from the last token exchange (available after first API call). */
    getBaseInfo(): { dtableUuid?: string; appName?: string } {
        return {
            dtableUuid: this.tokenManager.getDtableUuid(),
            appName: this.tokenManager.getAppName(),
        }
    }

    // --- Lazy initialization ---

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return
        if (!this.initializing) this.initializing = this.init()
        await this.initializing
    }

    private async init(): Promise<void> {
        // Trigger token exchange to get base token + dtable_uuid
        await this.tokenManager.getToken()

        const baseUuid = this.tokenManager.getDtableUuid()
        if (!baseUuid) {
            throw new Error(
                'Cannot determine base UUID. Ensure the token exchange returns dtable_uuid.'
            )
        }

        const baseURL = `${this.serverUrl}/api-gateway/api/v2/dtables/${baseUuid}`
        logger.info({ baseURL }, 'SeaTableClient initialized')

        this.http = axios.create({
            baseURL,
            timeout: this.timeoutMs,
        })

        // Add Bearer token to every request
        this.http.interceptors.request.use(async (config) => {
            const token = await this.tokenManager.getToken()
            config.headers.Authorization = `Bearer ${token}`
            return config
        })

        // Retry with exponential backoff
        axiosRetry(this.http, {
            retries: 3,
            retryDelay: axiosRetry.exponentialDelay,
            retryCondition: (error) => {
                return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 429
            },
        })

        this.initialized = true
    }

    private async request<T>(op: string, fn: (http: AxiosInstance) => Promise<T>): Promise<T> {
        await this.ensureInitialized()
        return this.limiter.schedule(async () => {
            const start = Date.now()
            try {
                const result = await fn(this.http!)
                const durationSec = (Date.now() - start) / 1000
                seatableApiRequestsTotal.inc({ operation: op, status: 'success' })
                seatableApiDurationSeconds.observe({ operation: op }, durationSec)
                return result
            } catch (err) {
                const durationSec = (Date.now() - start) / 1000
                seatableApiRequestsTotal.inc({ operation: op, status: 'error' })
                seatableApiDurationSeconds.observe({ operation: op }, durationSec)
                logAxiosError(err, op)
                throw toCodedAxiosError(err, op)
            }
        })
    }

    // --- Metadata & Tables ---

    async getMetadata(): Promise<any> {
        return this.request('getMetadata', async (http) => {
            const res = await http.get('/metadata/')
            return res.data.metadata ?? res.data
        })
    }

    async listTables(): Promise<SeaTableTable[]> {
        const meta = await this.getMetadata()
        return (meta.tables ?? []) as SeaTableTable[]
    }

    // --- Rows ---

    async listRows(query: {
        table: string
        page?: number
        page_size?: number
    }): Promise<ListRowsResponse> {
        const parsed = ListRowsQuerySchema.parse(query)
        return this.request('listRows', async (http) => {
            const params: Record<string, unknown> = {
                table_name: parsed.table,
                start: (parsed.page - 1) * parsed.page_size,
                limit: parsed.page_size,
                convert_keys: true,
            }
            const res = await http.get('/rows/', { params })
            const rows: SeaTableRow[] = res.data.rows ?? res.data
            return { rows, page: parsed.page, page_size: parsed.page_size, has_more: rows.length === parsed.page_size }
        })
    }

    async getRow(table: string, rowId: string): Promise<SeaTableRow> {
        return this.request('getRow', async (http) => {
            const res = await http.get(`/rows/${rowId}/`, {
                params: { table_name: table, convert_keys: true },
            })
            return res.data
        })
    }

    async addRow(table: string, row: Record<string, unknown>): Promise<SeaTableRow> {
        return this.request('addRow', async (http) => {
            const res = await http.post('/rows/', {
                table_name: table,
                rows: [row],
                convert_keys: true,
            })
            return res.data.first_row ?? res.data
        })
    }

    async updateRow(table: string, rowId: string, row: Record<string, unknown>): Promise<any> {
        return this.request('updateRow', async (http) => {
            const res = await http.put('/rows/', {
                table_name: table,
                updates: [{ row_id: rowId, row }],
            })
            return res.data
        })
    }

    async deleteRow(table: string, rowId: string): Promise<{ success: boolean }> {
        return this.request('deleteRow', async (http) => {
            const res = await http.delete('/rows/', {
                data: { table_name: table, row_ids: [rowId] },
            })
            return res.data
        })
    }

    async searchRows(table: string, query: Record<string, unknown>): Promise<ListRowsResponse> {
        // Build SQL WHERE clause from key-value pairs
        const conditions = Object.entries(query).map(([col]) => `\`${sanitizeIdentifier(col)}\` = ?`)
        const values = Object.values(query)
        const sql = `SELECT * FROM \`${sanitizeIdentifier(table)}\` WHERE ${conditions.join(' AND ')}`
        const result = await this.querySql(sql, values)
        return { rows: result.results as SeaTableRow[] }
    }

    // --- SQL ---

    async querySql(sql: string, parameters?: any[]): Promise<{ metadata: any; results: any[] }> {
        return this.request('querySql', async (http) => {
            const body: Record<string, unknown> = { sql, convert_keys: true }
            if (parameters?.length) body.parameters = parameters
            const res = await http.post('/sql/', body)
            return {
                metadata: res.data.metadata ?? {},
                results: res.data.results ?? res.data.rows ?? [],
            }
        })
    }

    async listCollaborators(): Promise<Array<{ email: string; name: string }>> {
        await this.ensureInitialized()
        return this.limiter.schedule(async () => {
            try {
                const token = await this.tokenManager.getToken()
                const uuid = this.tokenManager.getDtableUuid()
                const url = `${this.serverUrl}/api/v2.1/dtables/${uuid}/related-users/`
                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: this.timeoutMs,
                })
                return res.data.user_list ?? []
            } catch (err) {
                logAxiosError(err, 'listCollaborators')
                throw toCodedAxiosError(err, 'listCollaborators')
            }
        })
    }

    // --- Links ---

    private async resolveLinkColumn(tableName: string, linkColumnName: string): Promise<{
        link_id: string
        table_id: string
        other_table_id: string
    }> {
        const metadata = await this.getMetadata()
        const tableObj = (metadata.tables ?? []).find((t: any) => t.name === tableName)
        if (!tableObj) throw new Error(`Table "${tableName}" not found`)

        const colObj = (tableObj.columns ?? []).find((c: any) => c.name === linkColumnName)
        if (!colObj) throw new Error(`Column "${linkColumnName}" not found in table "${tableName}"`)
        if (colObj.type !== 'link') {
            throw new Error(`Column "${linkColumnName}" is type "${colObj.type}", expected "link"`)
        }

        const { link_id, table_id, other_table_id } = colObj.data
        // If the user is linking from the "other" side, swap the IDs
        if (tableObj._id === table_id) {
            return { link_id, table_id, other_table_id }
        }
        return { link_id, table_id: other_table_id, other_table_id: table_id }
    }

    async createLinks(args: {
        table: string
        linkColumn: string
        pairs: Array<{ fromRowId: string; toRowId: string }>
    }): Promise<any> {
        await this.ensureInitialized()
        const { link_id, table_id, other_table_id } = await this.resolveLinkColumn(args.table, args.linkColumn)

        // Group pairs into other_rows_ids_map
        const map: Record<string, string[]> = {}
        for (const { fromRowId, toRowId } of args.pairs) {
            if (!map[fromRowId]) map[fromRowId] = []
            map[fromRowId].push(toRowId)
        }

        return this.request('createLinks', async (http) => {
            const res = await http.post('/links/', {
                link_id,
                table_id,
                other_table_id,
                other_rows_ids_map: map,
            })
            return res.data
        })
    }

    async deleteLinks(args: {
        table: string
        linkColumn: string
        pairs: Array<{ fromRowId: string; toRowId: string }>
    }): Promise<any> {
        await this.ensureInitialized()
        const { link_id, table_id, other_table_id } = await this.resolveLinkColumn(args.table, args.linkColumn)

        // Group pairs into other_rows_ids_map
        const map: Record<string, string[]> = {}
        for (const { fromRowId, toRowId } of args.pairs) {
            if (!map[fromRowId]) map[fromRowId] = []
            map[fromRowId].push(toRowId)
        }

        return this.request('deleteLinks', async (http) => {
            const res = await http.delete('/links/', {
                data: {
                    link_id,
                    table_id,
                    other_table_id,
                    other_rows_ids_map: map,
                },
            })
            return res.data
        })
    }

    // --- Column options ---

    async addColumnOptions(args: {
        table: string
        column: string
        options: Array<{ name: string; color?: string; textColor?: string }>
    }): Promise<any> {
        // SeaTable API requires both color and textColor on every option
        const COLORS = ['#FFDDA3', '#FF9F9F', '#EEE8F3', '#B3CEF3', '#D4EDDA', '#D4C5F9', '#7BC8F6', '#3BC97A']
        const options = args.options.map((opt) => ({
            name: opt.name,
            color: opt.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
            textColor: opt.textColor ?? '#202020',
        }))
        return this.request('addColumnOptions', async (http) => {
            const res = await http.post('/column-options/', {
                table_name: args.table,
                column: args.column,
                options,
            })
            return res.data
        })
    }

    // --- File upload ---

    async uploadFile(args: {
        table: string
        column: string
        rowId: string
        fileName: string
        fileData: string // base64
        replace?: boolean
    }): Promise<{ file_name: string; file_size: number; asset_url: string; column_type: string }> {
        await this.ensureInitialized()
        // Note: no outer limiter.schedule() here — the sub-calls (getMetadata, getRow,
        // updateRow) each schedule through the limiter individually. Wrapping everything
        // would deadlock because Bottleneck has maxConcurrent=1.
        try {
            const { table, column, rowId, fileName, fileData, replace } = args

            // 1. Validate column type via metadata
            const metadata = await this.getMetadata()
            const tableObj = (metadata.tables ?? []).find((t: any) => t.name === table)
            if (!tableObj) throw new Error(`Table "${table}" not found`)
            const colObj = (tableObj.columns ?? []).find((c: any) => c.name === column)
            if (!colObj) throw new Error(`Column "${column}" not found in table "${table}"`)
            if (colObj.type !== 'image' && colObj.type !== 'file') {
                throw new Error(`Column "${column}" is type "${colObj.type}", expected "image" or "file"`)
            }
            const columnType: 'image' | 'file' = colObj.type

            // 2. Get upload link (uses original API token, not base token)
            const uploadInfo = await this.limiter.schedule(async () => {
                const url = `${this.serverUrl}/api/v2.1/dtable/app-upload-link/`
                const res = await axios.get(url, {
                    headers: { Authorization: `Token ${this.apiToken}` },
                    timeout: this.timeoutMs,
                })
                return res.data as {
                    upload_link: string
                    parent_path: string
                    img_relative_path: string
                    file_relative_path: string
                }
            })

            // 3. Upload file via multipart form
            const relativePath = columnType === 'image'
                ? uploadInfo.img_relative_path
                : uploadInfo.file_relative_path
            const fileBuffer = Buffer.from(fileData, 'base64')
            const formData = new FormData()
            formData.append('file', new Blob([fileBuffer]), fileName)
            formData.append('parent_dir', uploadInfo.parent_path)
            formData.append('relative_path', relativePath)

            const uploaded = await this.limiter.schedule(async () => {
                const res = await axios.post(`${uploadInfo.upload_link}?ret-json=1`, formData, {
                    timeout: this.timeoutMs,
                })
                return Array.isArray(res.data) ? res.data[0] : res.data
            })

            // 4. Construct asset URL
            const workspaceId = this.tokenManager.getWorkspaceId()
            if (!workspaceId) {
                throw new Error('Missing workspace_id for asset URL construction')
            }
            // parent_path is "/asset/{uuid}", relativePath is e.g. "files/2026-03"
            const assetUrl = `/workspace/${workspaceId}${uploadInfo.parent_path}/${relativePath}/${uploaded.name}`

            // 5. Merge with existing values unless replace=true
            let newValue: unknown
            if (columnType === 'image') {
                const urls = [assetUrl]
                if (!replace) {
                    const existingRow = await this.getRow(table, rowId)
                    const existing = existingRow[column]
                    if (Array.isArray(existing)) urls.unshift(...existing)
                }
                newValue = urls
            } else {
                const fileObj = { name: uploaded.name, size: uploaded.size, type: 'file', url: assetUrl }
                const files = [fileObj]
                if (!replace) {
                    const existingRow = await this.getRow(table, rowId)
                    const existing = existingRow[column]
                    if (Array.isArray(existing)) files.unshift(...existing)
                }
                newValue = files
            }

            // 6. Update the row
            await this.updateRow(table, rowId, { [column]: newValue })

            return {
                file_name: uploaded.name,
                file_size: uploaded.size ?? fileBuffer.length,
                asset_url: assetUrl,
                column_type: columnType,
            }
        } catch (err) {
            logAxiosError(err, 'uploadFile')
            throw toCodedAxiosError(err, 'uploadFile')
        }
    }

    // --- Row activities ---

    async getRowActivities(rowId: string, page?: number): Promise<{ activities: any[]; total_count: number }> {
        return this.request('getRowActivities', async (http) => {
            const res = await http.get('/activities/', {
                params: { row_id: rowId, page: page ?? 1, per_page: 25 },
            })
            return res.data
        })
    }

    // --- Snapshots ---

    async createSnapshot(): Promise<{ status: string; snapshot: { dtable_uuid: string; dtable_name: string; commit_id: string; ctime: number } }> {
        await this.ensureInitialized()
        const dtableName = this.tokenManager.getDtableName()
        if (!dtableName) {
            throw new Error('Cannot determine base name. Ensure the token exchange returns dtable_name.')
        }
        return this.request('createSnapshot', async (http) => {
            const res = await http.post('/snapshot/', { dtable_name: dtableName })
            return res.data
        })
    }

    // --- File download ---

    private static readonly TEXT_EXTENSIONS = new Set([
        'txt', 'csv', 'md', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts',
        'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sql', 'sh',
        'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'swift',
    ])

    private static readonly MAX_FILE_SIZE = 1 * 1024 * 1024 // 1 MB

    async downloadFile(args: {
        table: string
        column: string
        rowId: string
        fileName?: string
    }): Promise<{ file_name: string; file_size: number; content: string; content_type: 'text' | 'pdf_text' | 'binary_url'; download_link?: string }> {
        await this.ensureInitialized()
        try {
            const { table, column, rowId, fileName } = args

            // 1. Validate column type via metadata
            const metadata = await this.getMetadata()
            const tableObj = (metadata.tables ?? []).find((t: any) => t.name === table)
            if (!tableObj) throw new Error(`Table "${table}" not found`)
            const colObj = (tableObj.columns ?? []).find((c: any) => c.name === column)
            if (!colObj) throw new Error(`Column "${column}" not found in table "${table}"`)
            if (colObj.type !== 'image' && colObj.type !== 'file') {
                throw new Error(`Column "${column}" is type "${colObj.type}", expected "image" or "file"`)
            }

            // 2. Get the file entry from the row
            const row = await this.getRow(table, rowId)
            const columnValue = row[column]
            if (!columnValue || (Array.isArray(columnValue) && columnValue.length === 0)) {
                throw new Error(`No files found in column "${column}" for row "${rowId}"`)
            }

            let filePath: string
            let resolvedFileName: string

            if (colObj.type === 'image') {
                // Image columns store an array of URL strings
                const urls = columnValue as string[]
                if (fileName) {
                    const match = urls.find((u: string) => u.includes(fileName))
                    if (!match) throw new Error(`File "${fileName}" not found in column "${column}"`)
                    filePath = match
                } else {
                    filePath = urls[0]
                }
                resolvedFileName = filePath.split('/').pop() ?? 'unknown'
            } else {
                // File columns store an array of {name, size, type, url} objects
                const files = columnValue as Array<{ name: string; url: string; size?: number }>
                let fileObj: { name: string; url: string; size?: number }
                if (fileName) {
                    const match = files.find((f) => f.name === fileName)
                    if (!match) throw new Error(`File "${fileName}" not found in column "${column}"`)
                    fileObj = match
                } else {
                    fileObj = files[0]
                }
                filePath = fileObj.url
                resolvedFileName = fileObj.name
            }

            // 3. Extract the asset path from the full URL
            // filePath may be relative ("/workspace/1/asset/<uuid>/files/2024-01/report.pdf")
            // or absolute ("https://server/workspace/1/asset/<uuid>/files/2026-03/Request%20For%20Quotation.pdf")
            // or an external URL ("https://example.com/image.png") for linked images
            const decodedPath = decodeURIComponent(filePath)
            const assetMatch = decodedPath.match(/\/asset\/(.+)/)
            if (!assetMatch) {
                // External URL — not a SeaTable asset, return the URL directly
                return {
                    file_name: resolvedFileName,
                    file_size: 0,
                    content: `External file. Use the download link to access it.`,
                    content_type: 'binary_url' as const,
                    download_link: filePath,
                }
            }
            const assetPath = `/${assetMatch[1]}`

            // The download-link API expects a path like "/files/2024-01/report.pdf" or "/images/2024-01/photo.png"
            const pathMatch = assetPath.match(/\/((?:files|images)\/.+)/)
            if (!pathMatch) throw new Error(`Cannot extract download path from "${assetPath}"`)
            const downloadPath = `/${pathMatch[1]}`

            // 4. Get download link
            const downloadLink = await this.limiter.schedule(async () => {
                const url = `${this.serverUrl}/api/v2.1/dtable/app-download-link/`
                const res = await axios.get(url, {
                    headers: { Authorization: `Token ${this.apiToken}` },
                    params: { path: downloadPath },
                    timeout: this.timeoutMs,
                })
                return res.data.download_link as string
            })

            // 5. Determine file type
            const ext = resolvedFileName.split('.').pop()?.toLowerCase() ?? ''
            const isText = SeaTableClient.TEXT_EXTENSIONS.has(ext)
            const isPdf = ext === 'pdf'

            if (!isText && !isPdf) {
                // Binary file — return download link only
                return {
                    file_name: resolvedFileName,
                    file_size: 0,
                    content: `Binary file. Use the download link to access it.`,
                    content_type: 'binary_url',
                    download_link: downloadLink,
                }
            }

            // 6. Download file content
            const fileResponse = await this.limiter.schedule(async () => {
                return axios.get(downloadLink, {
                    responseType: 'arraybuffer',
                    timeout: this.timeoutMs,
                    maxContentLength: SeaTableClient.MAX_FILE_SIZE,
                    maxBodyLength: SeaTableClient.MAX_FILE_SIZE,
                })
            })

            const buffer = Buffer.from(fileResponse.data)
            const fileSize = buffer.length

            if (fileSize > SeaTableClient.MAX_FILE_SIZE) {
                return {
                    file_name: resolvedFileName,
                    file_size: fileSize,
                    content: `File exceeds 1 MB size limit (${(fileSize / 1024 / 1024).toFixed(1)} MB). Use the download link to access it.`,
                    content_type: 'binary_url',
                    download_link: downloadLink,
                }
            }

            // 7. Extract text content
            if (isPdf) {
                const { PDFParse } = await import('pdf-parse')
                const parser = new PDFParse({ data: new Uint8Array(buffer) })
                const textResult = await parser.getText()
                await parser.destroy()
                return {
                    file_name: resolvedFileName,
                    file_size: fileSize,
                    content: textResult.text,
                    content_type: 'pdf_text',
                }
            }

            // Text file
            return {
                file_name: resolvedFileName,
                file_size: fileSize,
                content: buffer.toString('utf-8'),
                content_type: 'text',
            }
        } catch (err) {
            logAxiosError(err, 'downloadFile')
            throw toCodedAxiosError(err, 'downloadFile')
        }
    }

}

/** Create a client from environment variables (selfhosted mode). */
export function createClientFromEnv(): SeaTableClient {
    const env = getEnv()
    if (!env.SEATABLE_API_TOKEN) {
        throw new Error('SEATABLE_API_TOKEN is required to create a client from env')
    }
    return new SeaTableClient({
        serverUrl: env.SEATABLE_SERVER_URL,
        apiToken: env.SEATABLE_API_TOKEN,
        timeoutMs: env.HTTP_TIMEOUT_MS,
    })
}

/** Create a client from a provided API token (managed mode). Server URL from env. */
export function createClientFromToken(apiToken: string): SeaTableClient {
    const env = getEnv()
    return new SeaTableClient({
        serverUrl: env.SEATABLE_SERVER_URL,
        apiToken,
        timeoutMs: env.HTTP_TIMEOUT_MS,
    })
}
