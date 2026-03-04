import axios from 'axios'

import { logger } from '../logger.js'
import { authValidationsTotal } from '../metrics/index.js'

interface CacheEntry {
    valid: boolean
    expiresAt: number
}

const POSITIVE_TTL_MS = 5 * 60 * 1000 // 5 minutes
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
        const cached = this.cache.get(apiToken)
        if (cached && Date.now() < cached.expiresAt) {
            logger.debug({ cached: cached.valid }, 'Token validation cache hit')
            authValidationsTotal.inc({ result: 'cache_hit' })
            return cached.valid
        }

        try {
            const url = `${this.serverUrl}/api/v2.1/dtable/app-access-token/`
            const res = await axios.get(url, {
                headers: { Authorization: `Bearer ${apiToken}` },
                timeout: 10_000,
            })
            const valid = !!res.data?.access_token
            this.cache.set(apiToken, { valid, expiresAt: Date.now() + POSITIVE_TTL_MS })
            authValidationsTotal.inc({ result: 'success' })
            return valid
        } catch (err: any) {
            const status = err?.response?.status
            logger.warn({ status }, 'Token validation failed')
            this.cache.set(apiToken, { valid: false, expiresAt: Date.now() + NEGATIVE_TTL_MS })
            authValidationsTotal.inc({ result: 'failure' })
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
