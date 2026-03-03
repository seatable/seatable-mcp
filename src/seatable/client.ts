import axios, { AxiosInstance } from 'axios'
import axiosRetry from 'axios-retry'
import Bottleneck from 'bottleneck'
import { z } from 'zod'

import { getEnv } from '../config/env.js'
import { toCodedAxiosError } from '../errors.js'
import { logger } from '../logger.js'
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
    view: z.string().optional(),
    order_by: z.string().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    filter: z.record(z.any()).optional(),
    search: z.string().optional(),
})
export type ListRowsQuery = z.infer<typeof ListRowsQuerySchema>

export class SeaTableClient {
    private readonly tokenManager: TokenManager
    private readonly limiter: Bottleneck
    private readonly serverUrl: string
    private readonly timeoutMs: number

    private http?: AxiosInstance
    private initialized = false
    private initializing?: Promise<void>

    constructor(config: SeaTableClientConfig) {
        this.serverUrl = config.serverUrl.replace(/\/$/, '')
        this.timeoutMs = config.timeoutMs ?? 30000

        this.tokenManager = new TokenManager({
            serverUrl: this.serverUrl,
            apiToken: config.apiToken,
            timeoutMs: config.timeoutMs,
        })

        this.limiter = new Bottleneck({ maxConcurrent: 1, minTime: 200 }) // 5 RPS

        logger.info({ msg: `SeaTableClient constructor, serverUrl: ${this.serverUrl}` })
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
            try {
                return await fn(this.http!)
            } catch (err) {
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
        filter?: Record<string, unknown>
        search?: string
        view?: string
        order_by?: string
        direction?: 'asc' | 'desc'
    }): Promise<ListRowsResponse> {
        const parsed = ListRowsQuerySchema.parse(query)
        return this.request('listRows', async (http) => {
            const params: Record<string, unknown> = {
                table_name: parsed.table,
                start: (parsed.page - 1) * parsed.page_size,
                limit: parsed.page_size,
                convert_keys: true,
            }
            if (parsed.view) params.view_name = parsed.view
            const res = await http.get('/rows/', { params })
            const rows: SeaTableRow[] = res.data.rows ?? res.data
            return { rows, page: parsed.page, page_size: parsed.page_size, total: rows.length }
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
        const conditions = Object.entries(query).map(([col]) => `\`${col}\` = ?`)
        const values = Object.values(query)
        const sql = `SELECT * FROM \`${table}\` WHERE ${conditions.join(' AND ')}`
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
