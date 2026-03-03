/**
 * Tracks concurrent connections per key with a configurable limit.
 */
export class ConnectionCounter {
    private readonly maxConnections: number
    private readonly counts = new Map<string, number>()

    constructor(maxConnections: number) {
        this.maxConnections = maxConnections
    }

    acquire(key: string): boolean {
        const current = this.counts.get(key) ?? 0
        if (current >= this.maxConnections) return false
        this.counts.set(key, current + 1)
        return true
    }

    release(key: string): void {
        const current = this.counts.get(key) ?? 0
        if (current <= 1) {
            this.counts.delete(key)
        } else {
            this.counts.set(key, current - 1)
        }
    }
}
