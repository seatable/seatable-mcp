import { describe, expect, it } from 'vitest'

import { SlidingWindowLimiter } from '../src/ratelimit/rateLimiter'

describe('SlidingWindowLimiter', () => {
    it('allows requests within limit', () => {
        const limiter = new SlidingWindowLimiter(5, 60_000)
        for (let i = 0; i < 5; i++) {
            expect(limiter.check('key1').allowed).toBe(true)
        }
    })

    it('denies requests over limit', () => {
        const limiter = new SlidingWindowLimiter(3, 60_000)
        limiter.check('key1')
        limiter.check('key1')
        limiter.check('key1')
        const result = limiter.check('key1')
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
            expect(result.retryAfterMs).toBeGreaterThan(0)
        }
    })

    it('tracks keys independently', () => {
        const limiter = new SlidingWindowLimiter(2, 60_000)
        limiter.check('a')
        limiter.check('a')
        expect(limiter.check('a').allowed).toBe(false)
        expect(limiter.check('b').allowed).toBe(true)
    })

    it('cleanup removes expired entries', () => {
        const limiter = new SlidingWindowLimiter(10, 60_000)
        limiter.check('old')

        // Force the window entry to be old
        const windows = (limiter as any).windows as Map<string, any>
        const entry = windows.get('old')!
        entry.currentStart = Date.now() - 200_000

        limiter.cleanup()
        expect(windows.has('old')).toBe(false)
    })
})
