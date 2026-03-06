import axios, { AxiosError, AxiosInstance } from 'axios'

import { logAxiosError } from './utils.js'

export type TokenInfo = {
    token: string
    expiresAt: number // epoch ms
    dtableUuid?: string
    workspaceId?: number
    appName?: string
}

export class TokenManager {
    private readonly http: AxiosInstance
    private readonly serverUrl: string
    private readonly apiToken: string

    private current?: TokenInfo
    private refreshing?: Promise<string>

    constructor(opts: { serverUrl: string; apiToken: string; timeoutMs?: number }) {
        this.serverUrl = opts.serverUrl.replace(/\/$/, '')
        this.apiToken = opts.apiToken
        this.http = axios.create({ timeout: opts.timeoutMs ?? 15000 })
    }

    async getToken(): Promise<string> {
        if (!this.isExpired(this.current)) return this.current!.token
        if (!this.refreshing) this.refreshing = this.fetchAppToken()
        try {
            return await this.refreshing
        } finally {
            this.refreshing = undefined
        }
    }

    async forceRefresh(): Promise<string> {
        this.refreshing = this.fetchAppToken()
        try {
            return await this.refreshing
        } finally {
            this.refreshing = undefined
        }
    }

    /** Returns dtable_uuid from the last token exchange, or undefined if not yet fetched. */
    getDtableUuid(): string | undefined {
        return this.current?.dtableUuid
    }

    /** Returns workspace_id from the last token exchange, or undefined if not yet fetched. */
    getWorkspaceId(): number | undefined {
        return this.current?.workspaceId
    }

    /** Returns app_name from the last token exchange, or undefined if not yet fetched. */
    getAppName(): string | undefined {
        return this.current?.appName
    }

    private isExpired(info?: TokenInfo): boolean {
        if (!info) return true
        return Date.now() >= info.expiresAt
    }

    private extractTokenAndExpiry(data: any): { token: string; expiresAt: number; dtableUuid?: string; workspaceId?: number; appName?: string } {
        const token: string = data?.access_token || data?.token || ''
        const dtableUuid: string | undefined = data?.dtable_uuid || undefined
        const workspaceId: number | undefined = typeof data?.workspace_id === 'number' ? data.workspace_id : undefined
        const appName: string | undefined = data?.app_name || undefined
        const now = Date.now()
        let expiresAt = now + 60 * 60 * 1000 // default 1h
        const seconds = data?.expires_in ?? data?.expire_in ?? data?.ttl ?? data?.exp
        if (typeof seconds === 'number') {
            expiresAt = now + seconds * 1000
        } else if (typeof data?.expires_at === 'string') {
            const ts = Date.parse(data.expires_at)
            if (!Number.isNaN(ts)) expiresAt = ts
        }
        // Renew 1 minute early
        expiresAt -= 60 * 1000
        return { token, expiresAt, dtableUuid, workspaceId, appName }
    }

    private async fetchAppToken(): Promise<string> {
        const url = `${this.serverUrl}/api/v2.1/dtable/app-access-token/`
        try {
            const res = await this.http.get(url, { headers: { Authorization: `Bearer ${this.apiToken}` } })
            const { token, expiresAt, dtableUuid, workspaceId, appName } = this.extractTokenAndExpiry(res.data)
            if (!token) throw new Error('App token response missing access token')
            this.current = { token, expiresAt, dtableUuid, workspaceId, appName }
            return token
        } catch (err) {
            logAxiosError(err, 'token_exchange_app')
            const axErr = err as AxiosError
            const status = axErr.response?.status
            const detail = (axErr.response?.data as any)?.error_msg
                || (axErr.response?.data as any)?.detail
                || axErr.code  // e.g. ENOTFOUND, ECONNREFUSED, ETIMEDOUT
                || axErr.message
                || 'unknown error'
            throw new Error(
                status
                    ? `Failed to authenticate with SeaTable (HTTP ${status}): ${detail}`
                    : `Failed to connect to ${this.serverUrl}: ${detail}`
            )
        }
    }
}
