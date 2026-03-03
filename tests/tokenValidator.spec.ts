import { afterEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'

import { TokenValidator } from '../src/auth/tokenValidator'

const serverUrl = 'http://localhost'

describe('TokenValidator', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('validates a valid token', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ data: { access_token: 'base-token' } })

        const validator = new TokenValidator(serverUrl)
        try {
            const result = await validator.validate('good-token')
            expect(result).toBe(true)
            expect(axios.get).toHaveBeenCalledWith(
                `${serverUrl}/api/v2.1/dtable/app-access-token/`,
                expect.objectContaining({
                    headers: { Authorization: 'Bearer good-token' },
                })
            )
        } finally {
            validator.destroy()
        }
    })

    it('rejects an invalid token', async () => {
        vi.spyOn(axios, 'get').mockRejectedValue({ response: { status: 401 } })

        const validator = new TokenValidator(serverUrl)
        try {
            const result = await validator.validate('bad-token')
            expect(result).toBe(false)
        } finally {
            validator.destroy()
        }
    })

    it('caches positive result', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({ data: { access_token: 'base-token' } })

        const validator = new TokenValidator(serverUrl)
        try {
            await validator.validate('cached-token')
            await validator.validate('cached-token')
            expect(getSpy).toHaveBeenCalledTimes(1)
        } finally {
            validator.destroy()
        }
    })

    it('caches negative result', async () => {
        const getSpy = vi.spyOn(axios, 'get').mockRejectedValue({ response: { status: 401 } })

        const validator = new TokenValidator(serverUrl)
        try {
            await validator.validate('bad-token')
            await validator.validate('bad-token')
            expect(getSpy).toHaveBeenCalledTimes(1)
        } finally {
            validator.destroy()
        }
    })

    it('cleanup removes expired entries', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ data: { access_token: 'base-token' } })

        const validator = new TokenValidator(serverUrl)
        try {
            await validator.validate('token-a')

            // Force the cache entry to be expired
            const cache = (validator as any).cache as Map<string, { valid: boolean; expiresAt: number }>
            const entry = cache.get('token-a')!
            entry.expiresAt = Date.now() - 1

            validator.cleanup()
            expect(cache.has('token-a')).toBe(false)
        } finally {
            validator.destroy()
        }
    })

    it('rejects token when response has no access_token', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ data: {} })

        const validator = new TokenValidator(serverUrl)
        try {
            const result = await validator.validate('empty-response-token')
            expect(result).toBe(false)
        } finally {
            validator.destroy()
        }
    })
})
