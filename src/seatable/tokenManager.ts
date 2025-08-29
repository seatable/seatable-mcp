import axios, { AxiosError, AxiosInstance } from 'axios'

import { getEnv } from '../config/env.js'
import { logAxiosError } from './utils.js'

export type TokenInfo = {
    token: string
    expiresAt: number // epoch ms
}

export class TokenManager {
    private readonly http: AxiosInstance
    private readonly serverUrl: string
    private readonly apiToken: string

    private current?: TokenInfo
    private refreshing?: Promise<string>

    constructor(opts: { serverUrl: string; apiToken: string; baseUuid: string; timeoutMs?: number }) {
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

    private isExpired(info?: TokenInfo): boolean {
        if (!info) return true
        return Date.now() >= info.expiresAt
    }

    private extractTokenAndExpiry(data: any): { token: string; expiresAt: number } {
        const token: string = data?.access_token || data?.token || ''
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
        return { token, expiresAt }
    }

    private async fetchAppToken(): Promise<string> {
        const env = getEnv()
        const expParam = env.SEATABLE_ACCESS_TOKEN_EXP || '1h'
        const url = `${this.serverUrl}/api/v2.1/dtable/app-access-token/?exp=${encodeURIComponent(expParam)}`
        try {
            const res = await this.http.get(url, { headers: { Authorization: `Bearer ${this.apiToken}` } })
            const { token, expiresAt } = this.extractTokenAndExpiry(res.data)
            if (!token) throw new Error('App token response missing access token')
            this.current = { token, expiresAt }
            return token
        } catch (err) {
            logAxiosError(err, 'token_exchange_app')
            const status = (err as AxiosError).response?.status
            throw new Error(`Failed to fetch app-access-token (${status ?? 'no-status'})`)
        }
    }
}
