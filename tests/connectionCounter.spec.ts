import { describe, expect, it } from 'vitest'

import { ConnectionCounter } from '../src/ratelimit/connectionCounter'

describe('ConnectionCounter', () => {
    it('allows connections within limit', () => {
        const counter = new ConnectionCounter(3)
        expect(counter.acquire('token1')).toBe(true)
        expect(counter.acquire('token1')).toBe(true)
        expect(counter.acquire('token1')).toBe(true)
    })

    it('denies connections over limit', () => {
        const counter = new ConnectionCounter(2)
        counter.acquire('token1')
        counter.acquire('token1')
        expect(counter.acquire('token1')).toBe(false)
    })

    it('release frees a slot', () => {
        const counter = new ConnectionCounter(1)
        counter.acquire('token1')
        expect(counter.acquire('token1')).toBe(false)
        counter.release('token1')
        expect(counter.acquire('token1')).toBe(true)
    })

    it('tracks tokens independently', () => {
        const counter = new ConnectionCounter(1)
        counter.acquire('a')
        expect(counter.acquire('a')).toBe(false)
        expect(counter.acquire('b')).toBe(true)
    })

    it('release on zero count is safe', () => {
        const counter = new ConnectionCounter(5)
        counter.release('nonexistent') // should not throw
    })
})
