import axios from 'axios'

import { logger } from '../logger.js'
import { authValidationsTotal } from '../metrics/index.js'

/**
 * valid: SeaTable accepted the token. revoked: SeaTable answered 401/403/404,
 * the token is gone for good. unknown: no answer (network error, timeout, 5xx),
 * which says nothing about the token itself.
 */
export type TokenStatus = 'valid' | 'revoked' | 'unknown'

interface CacheEntry {
    status: TokenStatus
    expiresAt: number
}

// Kept deliberately short: this is the window in which a revoked SeaTable token
// still passes validation, for established sessions as well as new ones.
const POSITIVE_TTL_MS = 60 * 1000 // 1 minute
const NEGATIVE_TTL_MS = 1 * 60 * 1000 // 1 minute

export class TokenValidator {
    private readonly serverUrl: string
    private readonly cache = new Map<string, CacheEntry>()
    private cleanupInterval?: ReturnType<typeof setInterval>

    constructor(serverUrl: string) {
        this.serverUrl = serverUrl.replace(/\/$/, '')
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000)
        // Don't keep the process alive just for cleanup
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref()
        }
    }

    async validate(apiToken: string): Promise<boolean> {
        return (await this.check(apiToken)) === 'valid'
    }

    async check(apiToken: string): Promise<TokenStatus> {
        const cached = this.cache.get(apiToken)
        if (cached && Date.now() < cached.expiresAt) {
            logger.debug({ cached: cached.status }, 'Token validation cache hit')
            authValidationsTotal.inc({ result: 'cache_hit' })
            return cached.status
        }

        try {
            const url = `${this.serverUrl}/api/v2.1/dtable/app-access-token/`
            const res = await axios.get(url, {
                headers: { Authorization: `Bearer ${apiToken}` },
                timeout: 10_000,
            })
            const status: TokenStatus = res.data?.access_token ? 'valid' : 'unknown'
            this.cache.set(apiToken, { status, expiresAt: Date.now() + POSITIVE_TTL_MS })
            authValidationsTotal.inc({ result: 'success' })
            return status
        } catch (err: any) {
            const httpStatus = err?.response?.status
            logger.warn({ status: httpStatus }, 'Token validation failed')
            const status: TokenStatus = httpStatus === 401 || httpStatus === 403 || httpStatus === 404 ? 'revoked' : 'unknown'
            this.cache.set(apiToken, { status, expiresAt: Date.now() + NEGATIVE_TTL_MS })
            authValidationsTotal.inc({ result: 'failure' })
            return status
        }
    }

    /**
     * Does this token authenticate as a SeaTable *account* token?
     *
     * Only asked after validate() failed, so the extra request is bounded by the
     * failure rate. Used to tell the user they pasted the wrong kind of token.
     */
    async looksLikeAccountToken(apiToken: string): Promise<boolean> {
        try {
            const res = await axios.get(`${this.serverUrl}/api2/account/info/`, {
                headers: { Authorization: `Token ${apiToken}` },
                timeout: 10_000,
            })
            return res.status === 200
        } catch {
            return false
        }
    }

    cleanup(): void {
        const now = Date.now()
        for (const [key, entry] of this.cache) {
            if (now >= entry.expiresAt) {
                this.cache.delete(key)
            }
        }
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = undefined
        }
        this.cache.clear()
    }
}
