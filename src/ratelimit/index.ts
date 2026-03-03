import { ConnectionCounter } from './connectionCounter.js'
import { SlidingWindowLimiter } from './rateLimiter.js'

export { ConnectionCounter } from './connectionCounter.js'
export { SlidingWindowLimiter } from './rateLimiter.js'

export interface RateLimitResult {
    allowed: true
}

export interface RateLimitDenied {
    allowed: false
    retryAfterMs: number
    reason: string
}

const ONE_MINUTE = 60_000

export class RateLimitManager {
    readonly perToken = new SlidingWindowLimiter(60, ONE_MINUTE)
    readonly perIp = new SlidingWindowLimiter(120, ONE_MINUTE)
    readonly global = new SlidingWindowLimiter(5000, ONE_MINUTE)
    readonly connections = new ConnectionCounter(5)

    private cleanupInterval?: ReturnType<typeof setInterval>

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000)
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref()
        }
    }

    check(opts: { ip: string; token?: string }): RateLimitResult | RateLimitDenied {
        // Global limit
        const globalResult = this.global.check('global')
        if (!globalResult.allowed) {
            return { allowed: false, retryAfterMs: globalResult.retryAfterMs, reason: 'Global rate limit exceeded' }
        }

        // Per-IP limit
        const ipResult = this.perIp.check(opts.ip)
        if (!ipResult.allowed) {
            return { allowed: false, retryAfterMs: ipResult.retryAfterMs, reason: 'IP rate limit exceeded' }
        }

        // Per-token limit
        if (opts.token) {
            const tokenResult = this.perToken.check(opts.token)
            if (!tokenResult.allowed) {
                return { allowed: false, retryAfterMs: tokenResult.retryAfterMs, reason: 'Token rate limit exceeded' }
            }
        }

        return { allowed: true }
    }

    private cleanup(): void {
        this.perToken.cleanup()
        this.perIp.cleanup()
        this.global.cleanup()
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = undefined
        }
    }
}
