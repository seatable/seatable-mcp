import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Authenticated, stateless envelope for values the server hands out but must be
 * able to read back — OAuth access/refresh tokens and client registrations.
 *
 * The SeaTable API token is sealed inside; it never leaves the process in the
 * clear. Because the envelope carries its own expiry and is authenticated with
 * AES-256-GCM, no server-side storage is required and the values survive both a
 * restart and a second instance sharing the same secret.
 */

/** Domain separator — a value sealed as one kind can never be opened as another. */
export type TokenKind = 'access' | 'refresh' | 'client'

const PREFIX: Record<TokenKind, string> = {
    access: 'mcpa1.',
    refresh: 'mcpr1.',
    client: 'mcpc1.',
}

const NONCE_BYTES = 12
const TAG_BYTES = 16
const HKDF_SALT = 'seatable-mcp/token-cipher/v1'

export interface SealedPayload {
    /** Absolute expiry, epoch ms. Written by seal(), checked by open(). */
    exp: number
    [key: string]: unknown
}

export class TokenCipher {
    private readonly key: Buffer

    constructor(secret: string) {
        if (!secret || secret.length < 16) {
            throw new Error('TokenCipher secret must be at least 16 characters')
        }
        this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.from(HKDF_SALT), Buffer.from('key'), 32))
    }

    seal(kind: TokenKind, payload: Record<string, unknown>, ttlMs: number): string {
        const body: SealedPayload = { ...payload, exp: Date.now() + ttlMs }
        const nonce = randomBytes(NONCE_BYTES)
        const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
        cipher.setAAD(Buffer.from(kind))
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf-8'), cipher.final()])
        const tag = cipher.getAuthTag()
        return PREFIX[kind] + Buffer.concat([nonce, ciphertext, tag]).toString('base64url')
    }

    /** Returns the payload, or undefined if the value is forged, tampered with, of the wrong kind, or expired. */
    open<T extends Record<string, unknown> = Record<string, unknown>>(kind: TokenKind, value: string): (T & SealedPayload) | undefined {
        const prefix = PREFIX[kind]
        if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined

        try {
            const raw = Buffer.from(value.slice(prefix.length), 'base64url')
            if (raw.length <= NONCE_BYTES + TAG_BYTES) return undefined

            const nonce = raw.subarray(0, NONCE_BYTES)
            const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)
            const tag = raw.subarray(raw.length - TAG_BYTES)

            const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
            decipher.setAAD(Buffer.from(kind))
            decipher.setAuthTag(tag)
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')

            const payload = JSON.parse(plaintext) as T & SealedPayload
            if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return undefined
            return payload
        } catch {
            // Any failure — bad base64, failed auth tag, malformed JSON — is a rejection.
            return undefined
        }
    }
}
