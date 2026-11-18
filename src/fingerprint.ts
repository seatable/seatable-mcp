import { createHash } from 'node:crypto'

function fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/** Session IDs are credentials-adjacent routing values — log a fingerprint, never the value. */
export function sessionFingerprint(sessionId: string): string {
    return fingerprint(sessionId)
}

/** Same rule for API tokens: enough to correlate one tenant's lines, never the credential. */
export function tokenFingerprint(apiToken: string): string {
    return fingerprint(apiToken)
}
