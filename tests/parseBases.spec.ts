import { describe, expect, it } from 'vitest'

import { parseBases } from '../src/config/env'

describe('parseBases (JSON format)', () => {
    it('parses a single entry', () => {
        const result = parseBases('[{"base_name":"CRM","api_token":"tok123"}]')
        expect(result).toEqual([{ name: 'CRM', apiToken: 'tok123' }])
    })

    it('parses multiple entries', () => {
        const result = parseBases(
            '[{"base_name":"CRM","api_token":"tok1"},{"base_name":"Projects","api_token":"tok2"}]'
        )
        expect(result).toEqual([
            { name: 'CRM', apiToken: 'tok1' },
            { name: 'Projects', apiToken: 'tok2' },
        ])
    })

    it('handles base names with special characters', () => {
        const result = parseBases(
            '[{"base_name":"Sales, Q1: Results","api_token":"tok1"}]'
        )
        expect(result).toEqual([{ name: 'Sales, Q1: Results', apiToken: 'tok1' }])
    })

    it('throws on invalid JSON', () => {
        expect(() => parseBases('not-json')).toThrow('valid JSON array')
    })

    it('throws on empty array', () => {
        expect(() => parseBases('[]')).toThrow('non-empty JSON array')
    })

    it('throws on non-array JSON', () => {
        expect(() => parseBases('{"base_name":"CRM"}')).toThrow('non-empty JSON array')
    })

    it('throws when base_name is missing', () => {
        expect(() => parseBases('[{"api_token":"tok1"}]')).toThrow('missing or empty "base_name"')
    })

    it('throws when api_token is missing', () => {
        expect(() => parseBases('[{"base_name":"CRM"}]')).toThrow('missing or empty "api_token"')
    })

    it('throws when entry is not an object', () => {
        expect(() => parseBases('["just-a-string"]')).toThrow('expected an object')
    })
})
