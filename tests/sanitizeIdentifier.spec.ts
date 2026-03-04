import { describe, expect, it } from 'vitest'

import { sanitizeIdentifier } from '../src/seatable/client'

describe('sanitizeIdentifier', () => {
    it('passes through simple names unchanged', () => {
        expect(sanitizeIdentifier('Name')).toBe('Name')
        expect(sanitizeIdentifier('my_column')).toBe('my_column')
    })

    it('escapes single backtick', () => {
        expect(sanitizeIdentifier('col`name')).toBe('col``name')
    })

    it('escapes multiple backticks', () => {
        expect(sanitizeIdentifier('`a`b`')).toBe('``a``b``')
    })

    it('handles empty string', () => {
        expect(sanitizeIdentifier('')).toBe('')
    })

    it('does not alter names with spaces or special chars (non-backtick)', () => {
        expect(sanitizeIdentifier('Column Name')).toBe('Column Name')
        expect(sanitizeIdentifier("it's")).toBe("it's")
        expect(sanitizeIdentifier('col"name')).toBe('col"name')
    })

    it('prevents SQL injection via backtick breakout', () => {
        // An attacker might try: table` WHERE 1=1; DROP TABLE users; --
        const malicious = 'table` WHERE 1=1; DROP TABLE users; --'
        const escaped = sanitizeIdentifier(malicious)
        // The backtick is doubled, so wrapping in backticks stays safe: `table`` WHERE 1=1; ...`
        expect(escaped).toBe('table`` WHERE 1=1; DROP TABLE users; --')
        expect(escaped).not.toContain('`\n')
        // When used as `{escaped}`, the SQL parser treats everything as one identifier
    })
})
