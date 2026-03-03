import { describe, expect, it } from 'vitest'

import { ClientRegistry } from '../src/seatable/clientRegistry'

const baseConfig = { serverUrl: 'http://localhost' }

describe('ClientRegistry', () => {
    it('resolves single base without name', () => {
        const registry = new ClientRegistry(
            [{ name: 'CRM', apiToken: 'token-crm' }],
            baseConfig
        )
        expect(registry.baseNames).toEqual(['CRM'])
        expect(registry.isMultiBase).toBe(false)
        const client = registry.resolve()
        expect(client).toBeTruthy()
    })

    it('resolves single base by name', () => {
        const registry = new ClientRegistry(
            [{ name: 'CRM', apiToken: 'token-crm' }],
            baseConfig
        )
        const client = registry.resolve('CRM')
        expect(client).toBeTruthy()
    })

    it('resolves multi-base by name', () => {
        const registry = new ClientRegistry(
            [
                { name: 'CRM', apiToken: 'token-crm' },
                { name: 'Projects', apiToken: 'token-proj' },
            ],
            baseConfig
        )
        expect(registry.baseNames).toEqual(['CRM', 'Projects'])
        expect(registry.isMultiBase).toBe(true)
        expect(registry.resolve('CRM')).toBeTruthy()
        expect(registry.resolve('Projects')).toBeTruthy()
    })

    it('throws when multi-base and no name given', () => {
        const registry = new ClientRegistry(
            [
                { name: 'CRM', apiToken: 'token-crm' },
                { name: 'Projects', apiToken: 'token-proj' },
            ],
            baseConfig
        )
        expect(() => registry.resolve()).toThrow('Specify "base" parameter')
    })

    it('throws for unknown base name', () => {
        const registry = new ClientRegistry(
            [{ name: 'CRM', apiToken: 'token-crm' }],
            baseConfig
        )
        expect(() => registry.resolve('Nonexistent')).toThrow('Unknown base "Nonexistent"')
    })
})
