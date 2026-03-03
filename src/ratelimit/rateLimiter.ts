/**
 * Sliding-window rate limiter using fixed-window approximation.
 * No external dependencies.
 */

interface WindowEntry {
    current: number
    previous: number
    currentStart: number
}

export class SlidingWindowLimiter {
    private readonly maxRequests: number
    private readonly windowMs: number
    private readonly windows = new Map<string, WindowEntry>()

    constructor(maxRequests: number, windowMs: number) {
        this.maxRequests = maxRequests
        this.windowMs = windowMs
    }

    check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
        const now = Date.now()
        let entry = this.windows.get(key)

        if (!entry) {
            entry = { current: 0, previous: 0, currentStart: now }
            this.windows.set(key, entry)
        }

        // Roll window if needed
        const elapsed = now - entry.currentStart
        if (elapsed >= this.windowMs) {
            const windowsElapsed = Math.floor(elapsed / this.windowMs)
            if (windowsElapsed >= 2) {
                entry.previous = 0
            } else {
                entry.previous = entry.current
            }
            entry.current = 0
            entry.currentStart += windowsElapsed * this.windowMs
        }

        // Weighted count: previous window weight based on remaining overlap
        const elapsedInCurrent = now - entry.currentStart
        const previousWeight = Math.max(0, 1 - elapsedInCurrent / this.windowMs)
        const estimatedCount = entry.previous * previousWeight + entry.current

        if (estimatedCount >= this.maxRequests) {
            const retryAfterMs = Math.ceil(this.windowMs - elapsedInCurrent)
            return { allowed: false, retryAfterMs }
        }

        entry.current++
        return { allowed: true }
    }

    cleanup(): void {
        const now = Date.now()
        const cutoff = now - this.windowMs * 2
        for (const [key, entry] of this.windows) {
            if (entry.currentStart < cutoff) {
                this.windows.delete(key)
            }
        }
    }
}
