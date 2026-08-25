import { describe, expect, it } from 'vitest'

import { TokenCipher } from '../src/auth/tokenCipher.js'

const SECRET = 'test-secret-value-that-is-long-enough-for-hkdf'

describe('TokenCipher', () => {
    it('seals and opens a payload round-trip', () => {
        const cipher = new TokenCipher(SECRET)
        const sealed = cipher.seal('access', { apiToken: 'raw-seatable-token' }, 3600_000)

        expect(sealed).not.toContain('raw-seatable-token')

        const opened = cipher.open('access', sealed)
        expect(opened?.apiToken).toBe('raw-seatable-token')
    })

    it('never emits the plaintext token in the sealed value', () => {
        const cipher = new TokenCipher(SECRET)
        const sealed = cipher.seal('access', { apiToken: 'super-secret-abc123' }, 3600_000)

        // Neither raw, nor base64, nor hex of the token may appear
        expect(sealed).not.toContain('super-secret-abc123')
        expect(sealed).not.toContain(Buffer.from('super-secret-abc123').toString('base64'))
        expect(sealed).not.toContain(Buffer.from('super-secret-abc123').toString('base64url'))
        expect(sealed).not.toContain(Buffer.from('super-secret-abc123').toString('hex'))
    })

    it('produces a different ciphertext each time (random nonce)', () => {
        const cipher = new TokenCipher(SECRET)
        const a = cipher.seal('access', { apiToken: 'same' }, 3600_000)
        const b = cipher.seal('access', { apiToken: 'same' }, 3600_000)
        expect(a).not.toBe(b)
        expect(cipher.open('access', a)?.apiToken).toBe('same')
        expect(cipher.open('access', b)?.apiToken).toBe('same')
    })

    it('rejects a token sealed with a different secret', () => {
        const sealed = new TokenCipher(SECRET).seal('access', { apiToken: 'x' }, 3600_000)
        const other = new TokenCipher('a-completely-different-secret-value-here')
        expect(other.open('access', sealed)).toBeUndefined()
    })

    it('rejects a tampered ciphertext (AEAD integrity)', () => {
        const cipher = new TokenCipher(SECRET)
        const sealed = cipher.seal('access', { apiToken: 'x' }, 3600_000)
        const tampered = sealed.slice(0, -3) + (sealed.slice(-3) === 'AAA' ? 'BBB' : 'AAA')
        expect(cipher.open('access', tampered)).toBeUndefined()
    })

    it('rejects a value of a different kind (domain separation)', () => {
        const cipher = new TokenCipher(SECRET)
        const refresh = cipher.seal('refresh', { apiToken: 'x' }, 3600_000)
        // A refresh token must not be usable where an access token is expected
        expect(cipher.open('access', refresh)).toBeUndefined()
        expect(cipher.open('refresh', refresh)?.apiToken).toBe('x')
    })

    it('rejects an expired token', () => {
        const cipher = new TokenCipher(SECRET)
        const sealed = cipher.seal('access', { apiToken: 'x' }, -1000)
        expect(cipher.open('access', sealed)).toBeUndefined()
    })

    it('rejects arbitrary attacker-supplied garbage', () => {
        const cipher = new TokenCipher(SECRET)
        expect(cipher.open('access', 'not-a-token')).toBeUndefined()
        expect(cipher.open('access', '')).toBeUndefined()
        expect(cipher.open('access', 'stmcp1.AAAA')).toBeUndefined()
    })
})
