import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry from 'axios-retry'
import Bottleneck from 'bottleneck'
import { z } from 'zod'

import { getEnv } from '../config/env.js'
import { toCodedAxiosError } from '../errors.js'
import { logger } from '../logger.js'
import { TokenManager } from './tokenManager.js'
import { ListRowsResponse, SeaTableRow, SeaTableTable } from './types.js'
import { logAxiosError } from './utils.js'

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
    private readonly http: AxiosInstance
    private readonly gatewayHttp: AxiosInstance
    private readonly externalHttp: AxiosInstance
    private readonly limiter: Bottleneck
    private readonly tokenManager: TokenManager

    // EndpointResolver (rows)
    private rowsSurface?: 'gateway-token' | 'gateway-bearer' | 'v21' | 'v1'
    private v1RowsDisabled = false

    constructor() {
        const env = getEnv()
        const serverUrl = env.SEATABLE_SERVER_URL.replace(/\/$/, '')
        
        logger.info({ msg: `SeaTableClient constructor, serverUrl: ${serverUrl}` })
        
        // Detect Cloud and disable v1 immediately, reset any cached surface
        if (serverUrl.includes('cloud.seatable.io')) {
            this.v1RowsDisabled = true
            this.rowsSurface = undefined // Force re-probe
            logger.info({ msg: 'Cloud detected: v1 disabled, rowsSurface reset' })
        }
        
        this.tokenManager = new TokenManager({
            serverUrl: serverUrl,
            apiToken: env.SEATABLE_API_TOKEN,
            baseUuid: env.SEATABLE_BASE_UUID,
            timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? 20000),
        })
        this.http = axios.create({
            baseURL: `${serverUrl}/dtable-server/api/v1/dtables/${env.SEATABLE_BASE_UUID}`,
            timeout: Number(env.HTTP_TIMEOUT_MS ?? 20000),
            headers: { 'Content-Type': 'application/json' },
        })
        this.gatewayHttp = axios.create({
            baseURL: `${serverUrl}/api-gateway/api/v2/dtables/${env.SEATABLE_BASE_UUID}`,
            timeout: Number(env.HTTP_TIMEOUT_MS ?? 20000),
            headers: { 'Content-Type': 'application/json' },
        })
        this.externalHttp = axios.create({
            baseURL: `${serverUrl}/api/v2.1/dtables/${env.SEATABLE_BASE_UUID}`,
            timeout: Number(env.HTTP_TIMEOUT_MS ?? 20000),
            headers: { 'Content-Type': 'application/json' },
        })

        // 5 RPS default (minTime ~ 200ms)
        this.limiter = new Bottleneck({ minTime: 200 })

        const addMeta = (config: any) => {
            config.metadata = config.metadata || {}
            config.metadata.requestId = config.metadata.requestId || Math.random().toString(36).slice(2)
            config.metadata.startedAt = Date.now()
            return config
        }

        // Interceptors: set Authorization only if missing so per-call overrides work
        const addBearerIfMissing = async (config: any) => {
            config.headers = config.headers || {}
            if (!("Authorization" in config.headers)) {
                const token = await this.tokenManager.getToken()
                ;(config.headers as any).Authorization = `Bearer ${token}`
            }
            return addMeta(config)
        }
        this.http.interceptors.request.use(addBearerIfMissing)
        this.externalHttp.interceptors.request.use(addBearerIfMissing)
        this.gatewayHttp.interceptors.request.use(addBearerIfMissing)

        const retryConfig = {
            retries: 3,
            retryDelay: (retryCount: number) => {
                const base = axiosRetry.exponentialDelay(retryCount)
                const jitter = Math.floor(Math.random() * 250)
                return base + jitter
            },
            retryCondition: (error: AxiosError) => {
                const status = error.response?.status
                return [408, 429, 500, 502, 503, 504].includes(status ?? 0)
            },
        }
        axiosRetry(this.http, retryConfig)
        axiosRetry(this.gatewayHttp, retryConfig)
        axiosRetry(this.externalHttp, retryConfig)

        // On 401, force refresh token once and retry (for Bearer flows)
        const onAuthError = async (error: AxiosError) => {
            if (error.response?.status === 401) {
                try {
                    const cfg = error.config!
                    await this.tokenManager.forceRefresh()
                    const t = await this.tokenManager.getToken()
                    cfg.headers = cfg.headers || {}
                    ;(cfg.headers as any).Authorization = `Bearer ${t}`
                    const url = (cfg.baseURL || '') + (cfg.url || '')
                    if (url.includes('/api-gateway/')) return this.gatewayHttp.request(cfg)
                    if (url.includes('/api/v2.1/')) return this.externalHttp.request(cfg)
                    return this.http.request(cfg)
                } catch (_) {
                    return Promise.reject(toCodedAxiosError(error, 'auth'))
                }
            }
            return Promise.reject(error)
        }
        this.http.interceptors.response.use((r) => r, onAuthError)
        this.gatewayHttp.interceptors.response.use((r) => r, onAuthError)
        this.externalHttp.interceptors.response.use((r) => r, onAuthError)
    }

    private shouldFallback(error: unknown): boolean {
        const err = error as AxiosError
        const status = err.response?.status
        const baseURL = (err.config as any)?.baseURL || ''
        // Fallback on network/no response, 404/405, and gateway-specific persistent 403
        if (!err.response) return true
        if (status === 404 || status === 405) return true
        if (status === 403 && String(baseURL).includes('/api-gateway/')) return true
        return false
    }

    private isOpTypeInvalid(error: unknown): boolean {
        const err = error as AxiosError
        const status = err.response?.status
        const data = err.response?.data as any
        const msg = typeof data === 'string' ? data : data?.message
        return status === 400 && /op_type invalid/i.test(String(msg))
    }

    private extractTablesFromMetadata(data: any): SeaTableTable[] {
        const tables = (data && (data.tables || data?.metadata?.tables)) || []
        return Array.isArray(tables) ? (tables as SeaTableTable[]) : []
    }

    // --- EndpointResolver (rows) ---
    private async gwAuthHeader(mode: 'token' | 'bearer') {
        if (mode === 'token') return { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` }
        const t = await this.tokenManager.getToken()
        return { Authorization: `Bearer ${t}` }
    }

    private isV1Deprecated404(error: any): boolean {
        const status = error?.response?.status
        const data = error?.response?.data
        return (
            status === 404 && typeof data === 'string' && /deprecated/i.test(data)
        )
    }

    private async probeRows(table: string): Promise<'gateway-token' | 'gateway-bearer' | 'v21' | 'v1'> {
        const params = { table_name: table, table, page: 1, page_size: 1 }
        
        // For Cloud instances, skip v1 probing entirely
        if (this.v1RowsDisabled) {
            // 1) Gateway with Bearer first (most likely to work on Cloud)
            try {
                const h = await this.gwAuthHeader('bearer')
                await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params, headers: h }))
                return 'gateway-bearer'
            } catch (_) {}
            // 2) Gateway with Token
            try {
                await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params, headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                return 'gateway-token'
            } catch (_) {}
            // 3) v2.1
            try {
                await this.limiter.schedule(() => this.externalHttp.get('/rows/', { params }))
                return 'v21'
            } catch (_) {}
            // Default to gateway-bearer for Cloud instances
            return 'gateway-bearer'
        }
        
        // Original probe logic for non-Cloud instances
        // 1) Gateway with Bearer first
        try {
            const h = await this.gwAuthHeader('bearer')
            await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params, headers: h }))
            return 'gateway-bearer'
        } catch (_) {}
        // 2) Gateway with Token
        try {
            await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params, headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
            return 'gateway-token'
        } catch (_) {}
        // 3) v2.1
        try {
            await this.limiter.schedule(() => this.externalHttp.get('/rows/', { params }))
            return 'v21'
        } catch (_) {}
        // 4) v1 (only for non-Cloud) - only try if we haven't detected it's disabled
        if (!this.v1RowsDisabled) {
            try {
                await this.limiter.schedule(() => this.http.get('/rows/', { params }))
                return 'v1'
            } catch (err) {
                if (this.isV1Deprecated404(err)) {
                    this.v1RowsDisabled = true
                }
                // Don't throw here, fall through to default
            }
        }
        // Default to gateway-bearer
        return 'gateway-bearer'
    }

    private async ensureRowsSurface(table: string) {
        if (!this.rowsSurface) {
            this.rowsSurface = await this.probeRows(table)
            logger.info({ msg: `probeRows result: ${this.rowsSurface}, v1Disabled: ${this.v1RowsDisabled}` })
        }
        // If we previously detected v1 is disabled and current surface is v1, switch to gateway
        if (this.v1RowsDisabled && this.rowsSurface === 'v1') {
            logger.info({ msg: 'Switching from v1 to gateway-bearer due to v1 being disabled' })
            this.rowsSurface = 'gateway-bearer'
        }
        logger.info({ msg: `Using rowsSurface: ${this.rowsSurface}` })
    }

    // --- Tables ---
    async createTable(tableName: string, columns?: Array<Record<string, unknown>>): Promise<{ name: string }> {
        try {
            const res = await this.limiter.schedule(() =>
                this.gatewayHttp.post('/tables/', { table_name: tableName, columns })
            )
            return (res as any).data
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    const res = await this.limiter.schedule(() =>
                        this.http.post('/tables/', { table_name: tableName, columns })
                    )
                    return (res as any).data
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            const res = await this.limiter.schedule(() =>
                                this.externalHttp.post('/tables/', { table_name: tableName, columns })
                            )
                            return (res as any).data
                        } catch (err3) {
                            logAxiosError(err3, 'createTable')
                            throw toCodedAxiosError(err3, 'createTable')
                        }
                    }
                    logAxiosError(err2, 'createTable')
                    throw toCodedAxiosError(err2, 'createTable')
                }
            }
            logAxiosError(error, 'createTable')
            throw toCodedAxiosError(error, 'createTable')
        }
    }

    async renameTable(from: string, to: string): Promise<{ name: string }> {
        try {
            const res = await this.limiter.schedule(() =>
                this.gatewayHttp.put('/tables/', { table_name: from, new_table_name: to })
            )
            return (res as any).data
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    const res = await this.limiter.schedule(() =>
                        this.http.put('/tables/', { table_name: from, new_table_name: to })
                    )
                    return (res as any).data
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            const res = await this.limiter.schedule(() =>
                                this.externalHttp.put('/tables/', { table_name: from, new_table_name: to })
                            )
                            return (res as any).data
                        } catch (err3) {
                            logAxiosError(err3, 'renameTable')
                            throw toCodedAxiosError(err3, 'renameTable')
                        }
                    }
                    logAxiosError(err2, 'renameTable')
                    throw toCodedAxiosError(err2, 'renameTable')
                }
            }
            logAxiosError(error, 'renameTable')
            throw toCodedAxiosError(error, 'renameTable')
        }
    }

    async deleteTable(name: string): Promise<{ success: boolean }> {
        try {
            await this.limiter.schedule(() => this.gatewayHttp.delete('/tables/', { data: { table_name: name } }))
            return { success: true }
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    await this.limiter.schedule(() => this.http.delete('/tables/', { data: { table_name: name } }))
                    return { success: true }
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            await this.limiter.schedule(() =>
                                this.externalHttp.delete('/tables/', { data: { table_name: name } })
                            )
                            return { success: true }
                        } catch (err3) {
                            logAxiosError(err3, 'deleteTable')
                            throw toCodedAxiosError(err3, 'deleteTable')
                        }
                    }
                    logAxiosError(err2, 'deleteTable')
                    throw toCodedAxiosError(err2, 'deleteTable')
                }
            }
            logAxiosError(error, 'deleteTable')
            throw toCodedAxiosError(error, 'deleteTable')
        }
    }

    // --- Columns (API-Gateway v2 preferred) ---
    async createColumn(table: string, column: Record<string, unknown>) {
        try {
            const res = await this.limiter.schedule(() =>
                this.gatewayHttp.post('/columns/', { table_name: table, ...column })
            )
            return (res as any).data
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    const res = await this.limiter.schedule(() =>
                        this.externalHttp.post('/columns/', { table_name: table, ...column })
                    )
                    return (res as any).data
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            const res = await this.limiter.schedule(() =>
                                this.http.post('/columns/', { table_name: table, ...column })
                            )
                            return (res as any).data
                        } catch (err3) {
                            logAxiosError(err3, 'createColumn')
                            throw toCodedAxiosError(err3, 'createColumn')
                        }
                    }
                    logAxiosError(err2, 'createColumn')
                    throw toCodedAxiosError(err2, 'createColumn')
                }
            }
            logAxiosError(error, 'createColumn')
            throw toCodedAxiosError(error, 'createColumn')
        }
    }

    async updateColumn(table: string, columnName: string, patch: Record<string, unknown>) {
        const base = { table_name: table, column_name: columnName, column: columnName }
        const candidates: Record<string, unknown>[] = []

        const hasOptionsTopLevel = Object.prototype.hasOwnProperty.call(patch, 'options')
        const hasData = Object.prototype.hasOwnProperty.call(patch, 'data')
        const hasColumnType = Object.prototype.hasOwnProperty.call(patch, 'column_type')
        const hasNewName = Object.prototype.hasOwnProperty.call(patch, 'new_column_name')

        if (hasOptionsTopLevel) {
            const options = (patch as any).options
            candidates.push({ ...base, op_type: 'set_column_data', data: { options } })
            candidates.push({ ...base, op_type: 'set_column_options', data: { options } })
            candidates.push({ ...base, op_type: 'set_options', data: { options } })
            candidates.push({ ...base, op_type: 'modify', data: { options } })
            candidates.push({ ...base, op_type: 'update_column', data: { options } })
            candidates.push({ ...base, op_type: 'set_column_data', data: options })
            candidates.push({ ...base, op_type: 'modify', data: { choices: options?.options ?? options } })
        }
        if (hasData) {
            const data = (patch as any).data
            candidates.push({ ...base, op_type: 'set_column_data', data })
            candidates.push({ ...base, op_type: 'set_column_options', data })
            candidates.push({ ...base, op_type: 'set_options', data })
            candidates.push({ ...base, op_type: 'modify', data })
            candidates.push({ ...base, op_type: 'update_column', data })
        }
        if (hasColumnType) {
            const column_type = (patch as any).column_type
            candidates.push({ ...base, op_type: 'modify_column_type', new_column_type: column_type })
            candidates.push({ ...base, op_type: 'set_column_type', column_type })
            candidates.push({ ...base, op_type: 'modify', column_type })
            candidates.push({ ...base, op_type: 'update_column', column_type })
        }
        if (hasNewName) {
            const new_column_name = (patch as any).new_column_name
            candidates.push({ ...base, op_type: 'rename_column', new_column_name })
            candidates.push({ ...base, op_type: 'rename', new_column_name })
            candidates.push({ ...base, op_type: 'modify', new_column_name })
            candidates.push({ ...base, op_type: 'update_column', new_column_name })
        }
        if (candidates.length === 0) {
            candidates.push({ ...base, ...patch })
        }

        const tryBodies = async (inst: AxiosInstance) => {
            let lastErr: any
            for (const body of candidates) {
                try {
                    const res = await this.limiter.schedule(() => inst.put('/columns/', body))
                    return (res as any).data
                } catch (e) {
                    lastErr = e
                    const err = e as AxiosError
                    const status = err.response?.status
                    const data: any = err.response?.data
                    const msg = typeof data === 'string' ? data : data?.message || data?.error_message
                    if (status === 400) {
                        if (/op_type invalid|op_type required|invalid op_type/i.test(String(msg))) continue
                        if (data?.error_type === 'parameter_error') continue
                        if (/new_column_type\s+invalid|required/i.test(String(msg))) continue
                    }
                    throw e
                }
            }
            throw lastErr
        }

        try {
            return await tryBodies(this.gatewayHttp)
        } catch (error) {
            if (this.shouldFallback(error) || this.isOpTypeInvalid(error)) {
                try {
                    return await tryBodies(this.externalHttp)
                } catch (err2) {
                    if (this.shouldFallback(err2) || this.isOpTypeInvalid(err2)) {
                        try {
                            return await tryBodies(this.http)
                        } catch (err3) {
                            logAxiosError(err3, 'updateColumn')
                            throw toCodedAxiosError(err3, 'updateColumn')
                        }
                    }
                    logAxiosError(err2, 'updateColumn')
                    throw toCodedAxiosError(err2, 'updateColumn')
                }
            }
            logAxiosError(error, 'updateColumn')
            throw toCodedAxiosError(error, 'updateColumn')
        }
    }

    async deleteColumn(table: string, columnName: string) {
        try {
            await this.limiter.schedule(() =>
                this.gatewayHttp.delete('/columns/', { data: { table_name: table, column: columnName, column_name: columnName } })
            )
            return { success: true }
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    await this.limiter.schedule(() =>
                        this.externalHttp.delete('/columns/', { data: { table_name: table, column_name: columnName } })
                    )
                    return { success: true }
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            await this.limiter.schedule(() =>
                                this.http.delete('/columns/', { data: { table_name: table, column_name: columnName } })
                            )
                            return { success: true }
                        } catch (err3) {
                            logAxiosError(err3, 'deleteColumn')
                            throw toCodedAxiosError(err3, 'deleteColumn')
                        }
                    }
                    logAxiosError(err2, 'deleteColumn')
                    throw toCodedAxiosError(err2, 'deleteColumn')
                }
            }
            logAxiosError(error, 'deleteColumn')
            throw toCodedAxiosError(error, 'deleteColumn')
        }
    }

    // --- Metadata and Rows ---
    async listTables(): Promise<SeaTableTable[]> {
        try {
            // Prefer gateway metadata
            const meta = await this.limiter.schedule(() => this.gatewayHttp.get('/metadata'))
            return this.extractTablesFromMetadata((meta as any).data)
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    const res = await this.limiter.schedule(() => this.externalHttp.get('/metadata'))
                    return this.extractTablesFromMetadata((res as any).data)
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            const res = await this.limiter.schedule(() => this.http.get('/metadata/tables'))
                            return ((res as any).data.tables as SeaTableTable[]) || []
                        } catch (err3) {
                            logAxiosError(err3, 'listTables')
                            throw toCodedAxiosError(err3, 'listTables')
                        }
                    }
                    logAxiosError(err2, 'listTables')
                    throw toCodedAxiosError(err2, 'listTables')
                }
            }
            logAxiosError(error, 'listTables')
            throw toCodedAxiosError(error, 'listTables')
        }
    }

    async getMetadata(): Promise<any> {
        try {
            const res = await this.limiter.schedule(() => this.gatewayHttp.get('/metadata'))
            return (res as any).data
        } catch (error) {
            if (this.shouldFallback(error)) {
                try {
                    const res = await this.limiter.schedule(() => this.externalHttp.get('/metadata'))
                    return (res as any).data
                } catch (err2) {
                    if (this.shouldFallback(err2)) {
                        try {
                            const res = await this.limiter.schedule(() => this.http.get('/metadata'))
                            return (res as any).data
                        } catch (err3) {
                            logAxiosError(err3, 'getMetadata')
                            throw toCodedAxiosError(err3, 'getMetadata')
                        }
                    }
                    logAxiosError(err2, 'getMetadata')
                    throw toCodedAxiosError(err2, 'getMetadata')
                }
            }
            logAxiosError(error, 'getMetadata')
            throw toCodedAxiosError(error, 'getMetadata')
        }
    }

    // Rows: use resolver
    async listRows(query: ListRowsQuery): Promise<ListRowsResponse> {
        const parsed = ListRowsQuerySchema.parse(query)
        await this.ensureRowsSurface(parsed.table)
        const common = {
            table_name: parsed.table,
            table: parsed.table,
            order_by: parsed.order_by,
            direction: parsed.direction,
            filter: parsed.filter,
            search: parsed.search,
            view: parsed.view,
        }
        const start = ((parsed.page ?? 1) - 1) * (parsed.page_size ?? 100) + 1
        const limit = parsed.page_size ?? 100
        const paramsGateway = { ...common, start, limit }
        const paramsV21 = { ...common, page: parsed.page, page_size: parsed.page_size }
        const paramsV1 = { ...common, per_page: parsed.page_size, page: parsed.page }
        try {
            switch (this.rowsSurface) {
                case 'gateway-token': {
                    const res = await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params: paramsGateway, headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                    return (res as any).data as ListRowsResponse
                }
                case 'gateway-bearer': {
                    const h = await this.gwAuthHeader('bearer')
                    const res = await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params: paramsGateway, headers: h }))
                    return (res as any).data as ListRowsResponse
                }
                case 'v21': {
                    const res = await this.limiter.schedule(() => this.externalHttp.get('/rows/', { params: paramsV21 }))
                    return (res as any).data as ListRowsResponse
                }
                case 'v1':
                default: {
                    const res = await this.limiter.schedule(() => this.http.get('/rows/', { params: paramsV1 }))
                    return (res as any).data as ListRowsResponse
                }
            }
        } catch (error) {
            const err = error as AxiosError
            const isExternal = String((err.config as any)?.baseURL || '').includes('/api/v2.1/')
            const status = err.response?.status
            const data = err.response?.data
            const looksHtml = typeof data === 'string' && /<html/i.test(data)
            if (this.rowsSurface === 'v21' && isExternal && status === 404 && looksHtml) {
                this.rowsSurface = 'gateway-bearer'
                const h = await this.gwAuthHeader('bearer')
                const res = await this.limiter.schedule(() => this.gatewayHttp.get('/rows/', { params: paramsGateway, headers: h }))
                return (res as any).data as ListRowsResponse
            }
            logAxiosError(error, 'listRows')
            throw toCodedAxiosError(error, 'listRows')
        }
    }

    async getRow(table: string, rowId: string): Promise<SeaTableRow> {
        // Force gateway-bearer for all Cloud instances
        if (getEnv().SEATABLE_SERVER_URL.includes('cloud.seatable.io')) {
            const h = await this.gwAuthHeader('bearer')
            logger.info({ msg: 'Cloud detected - forcing gateway-bearer for getRow' })
            try {
                const params = { table_name: table, table }
                const res = await this.limiter.schedule(() => this.gatewayHttp.get(`/rows/${rowId}/`, { params, headers: h }))
                return (res as any).data as SeaTableRow
            } catch (err) {
                logger.info({ msg: 'Gateway getRow failed', status: (err as any).response?.status })
                throw err
            }
        }
        
        // Original logic for non-Cloud instances
        await this.ensureRowsSurface(table)
        const params = { table_name: table, table }
        try {
            switch (this.rowsSurface) {
                case 'gateway-token': {
                    const res = await this.limiter.schedule(() => this.gatewayHttp.get(`/rows/${rowId}/`, { params, headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                    return (res as any).data as SeaTableRow
                }
                case 'gateway-bearer': {
                    const h = await this.gwAuthHeader('bearer')
                    const res = await this.limiter.schedule(() => this.gatewayHttp.get(`/rows/${rowId}/`, { params, headers: h }))
                    return (res as any).data as SeaTableRow
                }
                case 'v21': {
                    const res = await this.limiter.schedule(() => this.externalHttp.get(`/rows/${rowId}/`, { params }))
                    return (res as any).data as SeaTableRow
                }
                case 'v1':
                default: {
                    const res = await this.limiter.schedule(() => this.http.get(`/rows/${rowId}/`, { params }))
                    return (res as any).data as SeaTableRow
                }
            }
        } catch (error) {
            logAxiosError(error, 'getRow')
            throw toCodedAxiosError(error, 'getRow')
        }
    }

    async addRow(table: string, row: Record<string, unknown>): Promise<SeaTableRow> {
        await this.ensureRowsSurface(table)
        const pickRowId = (data: any): string | undefined => {
            if (!data) return undefined
            if (typeof data.row_id === 'string') return data.row_id
            if (data.row && typeof data.row._id === 'string') return data.row._id
            const takeFrom = (arr: any): string | undefined => {
                if (Array.isArray(arr) && arr.length) {
                    const v = arr[0]
                    if (typeof v === 'string') return v
                    if (v && typeof v.row_id === 'string') return v.row_id
                    if (v && typeof v._id === 'string') return v._id
                }
                return undefined
            }
            return (
                takeFrom(data.row_ids) ||
                takeFrom(data.inserted_row_ids) ||
                (typeof data._id === 'string' ? data._id : undefined)
            )
        }
        try {
            switch (this.rowsSurface) {
                case 'gateway-token': {
                    const body = { table_name: table, rows: [row] }
                    const res = await this.limiter.schedule(() => this.gatewayHttp.post('/rows/', body, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                    const data: any = (res as any).data
                    const firstRow = data?.rows?.[0]
                    if (firstRow && typeof firstRow === 'object' && firstRow._id) return firstRow as SeaTableRow
                    const rowId = pickRowId(data)
                    if (rowId) return await this.getRow(table, rowId)
                    return { ...(row as any) }
                }
                case 'gateway-bearer': {
                    const body = { table_name: table, rows: [row] }
                    const h = await this.gwAuthHeader('bearer')
                    const res = await this.limiter.schedule(() => this.gatewayHttp.post('/rows/', body, { headers: h }))
                    const data: any = (res as any).data
                    const firstRow = data?.rows?.[0]
                    if (firstRow && typeof firstRow === 'object' && firstRow._id) return firstRow as SeaTableRow
                    const rowId = pickRowId(data)
                    if (rowId) return await this.getRow(table, rowId)
                    return { ...(row as any) }
                }
                case 'v21': {
                    const res = await this.limiter.schedule(() => this.externalHttp.post('/rows/', { table_name: table, row }))
                    return (res as any).data as SeaTableRow
                }
                case 'v1':
                default: {
                    const res = await this.limiter.schedule(() => this.http.post('/rows/', { table_name: table, row }))
                    return (res as any).data as SeaTableRow
                }
            }
        } catch (error) {
            logAxiosError(error, 'addRow')
            throw toCodedAxiosError(error, 'addRow')
        }
    }

    async updateRow(table: string, rowId: string, row: Record<string, unknown>): Promise<SeaTableRow> {
        // Force gateway-bearer for all Cloud instances
        if (getEnv().SEATABLE_SERVER_URL.includes('cloud.seatable.io')) {
            const h = await this.gwAuthHeader('bearer')
            logger.info({ msg: 'Cloud detected - using gateway PUT /rows/ with updates[]' })
            // Primary: API-Gateway batch-style PUT to /rows/
            const updatesBody = { table_name: table, updates: [{ row_id: rowId, row }] }
            try {
                await this.limiter.schedule(() => this.gatewayHttp.put('/rows/', updatesBody, { headers: h }))
                return await this.getRow(table, rowId)
            } catch (err0) {
                logger.info({ msg: 'Gateway PUT /rows/ (updates[]) failed, trying other variants', status: (err0 as any).response?.status })
            }
            // Try API-Gateway variants in order of likelihood
            const batchBody = { table_name: table, updates: [{ row_id: rowId, row }] }
            try {
                await this.limiter.schedule(() => this.gatewayHttp.post('/rows/batch-update/', batchBody, { headers: h }))
                return await this.getRow(table, rowId)
            } catch (err1) {
                logger.info({ msg: 'Gateway batch-update/ failed, trying without trailing slash', status: (err1 as any).response?.status })
            }
            try {
                await this.limiter.schedule(() => this.gatewayHttp.post('/rows/batch-update', batchBody, { headers: h }))
                return await this.getRow(table, rowId)
            } catch (err2) {
                logger.info({ msg: 'Gateway batch-update failed, trying PATCH', status: (err2 as any).response?.status })
            }
            try {
                const body = { table_name: table, row }
                const res = await this.limiter.schedule(() => this.gatewayHttp.patch(`/rows/${rowId}/`, body, { headers: h }))
                return (res as any).data as SeaTableRow
            } catch (err3) {
                logger.info({ msg: 'Gateway PATCH failed, trying PUT', status: (err3 as any).response?.status })
            }
            try {
                const body = { table_name: table, row }
                const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/${rowId}/`, body, { headers: h }))
                return (res as any).data as SeaTableRow
            } catch (err4) {
                logger.info({ msg: 'Gateway PUT also failed, trying POST /rows/{id}/', status: (err4 as any).response?.status })
            }
            // Try POST /rows/{id}/ with body
            try {
                const body = { table_name: table, row }
                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/${rowId}/`, body, { headers: h }))
                return (res as any).data as SeaTableRow
            } catch (err5) {
                logger.info({ msg: 'Gateway POST /rows/{id}/ failed, trying PUT /rows/ with row_id', status: (err5 as any).response?.status })
            }
            // Try PUT /rows/ with row_id envelope
            try {
                const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                return (res as any).data as SeaTableRow
            } catch (err6) {
                logger.info({ msg: 'Gateway PUT /rows/ with row_id failed, trying POST /rows/ with row_id', status: (err6 as any).response?.status })
            }
            try {
                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                return (res as any).data as SeaTableRow
            } catch (err7) {
                logger.info({ msg: 'Gateway POST with row_id failed', status: (err7 as any).response?.status })
                throw err7
            }
        }
        
        // Original logic for non-Cloud instances
        await this.ensureRowsSurface(table)
        
        logger.info({ msg: `updateRow using rowsSurface: ${this.rowsSurface}, v1Disabled: ${this.v1RowsDisabled}` })
        
        try {
            switch (this.rowsSurface) {
                case 'gateway-token': {
                    const body = { table_name: table, row }
                    try {
                        const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/${rowId}/`, body, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                        return (res as any).data as SeaTableRow
                    } catch (err) {
                        if (this.shouldFallback(err)) {
                            // First: batch-style PUT /rows/ with updates[]
                            try {
                                const updatesBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                                await this.limiter.schedule(() => this.gatewayHttp.put('/rows/', updatesBody, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                                return await this.getRow(table, rowId)
                            } catch (_) {}
                            // Then: gateway batch update endpoint
                            try {
                                const batchBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                                await this.limiter.schedule(() => this.gatewayHttp.post('/rows/batch-update', batchBody, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                                return await this.getRow(table, rowId)
                            } catch (_) {}
                            // Try gateway POST /rows/{id}/
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/${rowId}/`, { table_name: table, row }, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                            // Try gateway PUT /rows/ with row_id
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                            // Try gateway POST /rows/ with row_id
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                        }
                        throw err
                    }
                }
                case 'gateway-bearer': {
                    const body = { table_name: table, row }
                    const h = await this.gwAuthHeader('bearer')
                    logger.info({ msg: 'Trying gateway-bearer PUT /rows/' + rowId })
                    try {
                        const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/${rowId}/`, body, { headers: h }))
                        return (res as any).data as SeaTableRow
                    } catch (err) {
                        logger.info({ msg: 'Gateway PUT failed', status: (err as any).response?.status })
                        if (this.shouldFallback(err)) {
                            // First: batch-style PUT /rows/ with updates[]
                            try {
                                logger.info({ msg: 'Trying gateway PUT /rows/ with updates[]' })
                                const updatesBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                                await this.limiter.schedule(() => this.gatewayHttp.put('/rows/', updatesBody, { headers: h }))
                                return await this.getRow(table, rowId)
                            } catch (putRowsErr) {
                                logger.info({ msg: 'Gateway PUT /rows/ with updates[] failed', status: (putRowsErr as any).response?.status })
                            }
                            // Try gateway batch update endpoint
                            try {
                                logger.info({ msg: 'Trying gateway batch-update' })
                                const batchBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                                await this.limiter.schedule(() => this.gatewayHttp.post('/rows/batch-update', batchBody, { headers: h }))
                                return await this.getRow(table, rowId)
                            } catch (batchErr) {
                                logger.info({ msg: 'Batch update failed', status: (batchErr as any).response?.status })
                            }
                            // Try gateway POST /rows/{id}/
                            try {
                                logger.info({ msg: 'Trying gateway POST /rows/{id}/' })
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/${rowId}/`, { table_name: table, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (postIdErr) {
                                logger.info({ msg: 'Gateway POST /rows/{id}/ failed', status: (postIdErr as any).response?.status })
                            }
                            // Try gateway PUT /rows/ with row_id
                            try {
                                logger.info({ msg: 'Trying gateway PUT /rows/ with row_id' })
                                const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (putRowsIdErr) {
                                logger.info({ msg: 'Gateway PUT /rows/ with row_id failed', status: (putRowsIdErr as any).response?.status })
                            }
                            // Try gateway POST /rows/ with row_id
                            try {
                                logger.info({ msg: 'Trying gateway POST /rows/ with row_id' })
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (postErr) {
                                logger.info({ msg: 'Gateway POST failed', status: (postErr as any).response?.status })
                            }
                        }
                        throw err
                    }
                }
                case 'v21': {
                    try {
                        const res = await this.limiter.schedule(() => this.externalHttp.put(`/rows/${rowId}/`, { table_name: table, row }))
                        return (res as any).data as SeaTableRow
                    } catch (err) {
                        if (this.shouldFallback(err)) {
                            // Try v2.1 POST
                            try {
                                const res = await this.limiter.schedule(() => this.externalHttp.post(`/rows/`, { table_name: table, row_id: rowId, row }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                            // Fallback to gateway bearer
                            const h = await this.gwAuthHeader('bearer')
                            try {
                                // Batch-style PUT /rows/ with updates[]
                                const updatesBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                                await this.limiter.schedule(() => this.gatewayHttp.put('/rows/', updatesBody, { headers: h }))
                                return await this.getRow(table, rowId)
                            } catch (_) {}
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/${rowId}/`, { table_name: table, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                            // Try gateway batch update
                            try {
                                const batchBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                                await this.limiter.schedule(() => this.gatewayHttp.post('/rows/batch-update', batchBody, { headers: h }))
                                return await this.getRow(table, rowId)
                            } catch (_) {}
                            // Try gateway POST /rows/{id}/
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/${rowId}/`, { table_name: table, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                            // Try gateway PUT /rows/ with row_id
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                            // Try gateway POST /rows/ with row_id
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                                return (res as any).data as SeaTableRow
                            } catch (_) {}
                        }
                        throw err
                    }
                }
                case 'v1':
                default: {
                    // This should never happen on Cloud since we disabled v1
                    logger.warn({ msg: `updateRow fallback to v1 case - this should not happen on Cloud. v1Disabled: ${this.v1RowsDisabled}` })
                    
                    // Redirect to gateway immediately on Cloud
                    const h = await this.gwAuthHeader('bearer')
                    try {
                        const batchBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                        await this.limiter.schedule(() => this.gatewayHttp.post('/rows/batch-update', batchBody, { headers: h }))
                        return await this.getRow(table, rowId)
                    } catch (err) {
                        // Try gateway PUT as fallback
                        try {
                            // Batch-style PUT /rows/ with updates[]
                            const updatesBody = { table_name: table, updates: [{ row_id: rowId, row }] }
                            await this.limiter.schedule(() => this.gatewayHttp.put('/rows/', updatesBody, { headers: h }))
                            return await this.getRow(table, rowId)
                        } catch (_) {}
                        try {
                            const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/${rowId}/`, { table_name: table, row }, { headers: h }))
                            return (res as any).data as SeaTableRow
                        } catch (_) {}
                        // Try gateway POST /rows/{id}/ as additional fallback
                        try {
                            const res = await this.limiter.schedule(() => this.gatewayHttp.post(`/rows/${rowId}/`, { table_name: table, row }, { headers: h }))
                            return (res as any).data as SeaTableRow
                        } catch (_) {}
                        // Try gateway PUT /rows/ with row_id
                        try {
                            const res = await this.limiter.schedule(() => this.gatewayHttp.put(`/rows/`, { table_name: table, row_id: rowId, row }, { headers: h }))
                            return (res as any).data as SeaTableRow
                        } catch (_) {}
                        throw err
                    }
                }
            }
        } catch (error) {
            logAxiosError(error, 'updateRow')
            throw toCodedAxiosError(error, 'updateRow')
        }
    }

    async deleteRow(table: string, rowId: string): Promise<{ success: boolean }> {
        await this.ensureRowsSurface(table)
        try {
            switch (this.rowsSurface) {
                case 'gateway-token': {
                    // API-Gateway expects DELETE /rows/ with body; use row_ids array for reliability
                    await this.limiter.schedule(() => this.gatewayHttp.delete(`/rows/`, { data: { table_name: table, row_ids: [rowId] }, headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                    return { success: true }
                }
                case 'gateway-bearer': {
                    const h = await this.gwAuthHeader('bearer')
                    // API-Gateway expects DELETE /rows/ with body; use row_ids array for reliability
                    await this.limiter.schedule(() => this.gatewayHttp.delete(`/rows/`, { data: { table_name: table, row_ids: [rowId] }, headers: h }))
                    return { success: true }
                }
                case 'v21': {
                    await this.limiter.schedule(() => this.externalHttp.delete(`/rows/${rowId}/`, { data: { table_name: table } }))
                    return { success: true }
                }
                case 'v1':
                default: {
                    await this.limiter.schedule(() => this.http.delete(`/rows/`, { data: { table_name: table, row_id: rowId } }))
                    return { success: true }
                }
            }
        } catch (error) {
            logAxiosError(error, 'deleteRow')
            throw toCodedAxiosError(error, 'deleteRow')
        }
    }

    async searchRows(table: string, query: Record<string, unknown>): Promise<ListRowsResponse> {
        await this.ensureRowsSurface(table)
        const body = { table, table_name: table, filter: query }

        const clientSideFilter = async (): Promise<ListRowsResponse> => {
            const pageSize = 500
            let page = 1
            const rows: any[] = []
            // Fetch up to 10 pages (5k rows) for safety
            for (let i = 0; i < 10; i++) {
                const res = await this.listRows({ table, page, page_size: pageSize })
                rows.push(...res.rows)
                if (res.rows.length < pageSize) break
                page += 1
            }
            // Build name->key map from metadata so we can read values stored under internal keys
            const meta = await this.getMetadata()
            const tables: any[] = (meta?.tables ?? meta?.metadata?.tables) || []
            const t = tables.find((x) => x.name === table)
            const nameToKey: Record<string, string> = {}
            if (t && Array.isArray(t.columns)) {
                for (const c of t.columns) {
                    if (c && typeof c.name === 'string' && typeof c.key === 'string') nameToKey[c.name] = c.key
                }
            }
            const keys = Object.keys(query)
            const filtered = rows.filter((r) => keys.every((k) => {
                const v = (r as any)[k]
                const altKey = nameToKey[k]
                const v2 = altKey ? (r as any)[altKey] : undefined
                const target = (query as any)[k]
                return v === target || v2 === target
            }))
            return { rows: filtered }
        }

        try {
            switch (this.rowsSurface) {
                case 'gateway-token': {
                    try {
                        const res = await this.limiter.schedule(() => this.gatewayHttp.post('/rows/filter', body, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                        return (res as any).data as ListRowsResponse
                    } catch (err1) {
                        const status = (err1 as AxiosError).response?.status
                        if (status === 404 || status === 405) {
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post('/rows/filter/', body, { headers: { Authorization: `Token ${getEnv().SEATABLE_API_TOKEN}` } }))
                                return (res as any).data as ListRowsResponse
                            } catch (_) {
                                return await clientSideFilter()
                            }
                        }
                        throw err1
                    }
                }
                case 'gateway-bearer': {
                    const h = await this.gwAuthHeader('bearer')
                    try {
                        const res = await this.limiter.schedule(() => this.gatewayHttp.post('/rows/filter', body, { headers: h }))
                        return (res as any).data as ListRowsResponse
                    } catch (err1) {
                        const status = (err1 as AxiosError).response?.status
                        if (status === 404 || status === 405) {
                            try {
                                const res = await this.limiter.schedule(() => this.gatewayHttp.post('/rows/filter/', body, { headers: h }))
                                return (res as any).data as ListRowsResponse
                            } catch (_) {
                                return await clientSideFilter()
                            }
                        }
                        throw err1
                    }
                }
                case 'v21': {
                    const res = await this.limiter.schedule(() => this.externalHttp.post('/rows/filter', body))
                    return (res as any).data as ListRowsResponse
                }
                case 'v1':
                default: {
                    const res = await this.limiter.schedule(() => this.http.post('/rows/filter', body))
                    return (res as any).data as ListRowsResponse
                }
            }
        } catch (error) {
            logAxiosError(error, 'searchRows')
            throw toCodedAxiosError(error, 'searchRows')
        }
    }

    async updateSelectOptions(table: string, column: string, options: Array<{ id: string, name?: string, color?: string }>, return_options = true): Promise<any> {
        // Prefer API-Gateway dedicated endpoint
        const h = await this.gwAuthHeader('bearer')
        try {
            const res = await this.limiter.schedule(() => this.gatewayHttp.put('/column-options/', {
                table_name: table,
                column,
                options,
                return_options,
            }, { headers: h }))
            return (res as any).data
        } catch (error) {
            // Fallback to generic column update shapes if gateway not available
            try {
                return await this.updateColumn(table, column, { data: { options } })
            } catch (err2) {
                logAxiosError(error, 'updateSelectOptions')
                throw toCodedAxiosError(error, 'updateSelectOptions')
            }
        }
    }
}
