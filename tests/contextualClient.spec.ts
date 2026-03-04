import { beforeAll, describe, expect, it } from 'vitest'

import type { ClientLike } from '../src/mcp/tools/types'
import { ContextualClient } from '../src/seatable/contextualClient'

/** Minimal mock registry that returns different mock clients per base name */
function createMockRegistry(baseNames: string[]) {
    const clients = new Map<string, ClientLike>()
    for (const name of baseNames) {
        clients.set(name, createMockClient(name))
    }

    return {
        baseNames,
        isMultiBase: baseNames.length > 1,
        resolve(baseName?: string): ClientLike {
            if (!baseName) {
                if (baseNames.length === 1) return clients.get(baseNames[0])!
                throw new Error(`Multiple bases available (${baseNames.join(', ')}). Specify "base" parameter.`)
            }
            const client = clients.get(baseName)
            if (!client) throw new Error(`Unknown base "${baseName}". Available: ${baseNames.join(', ')}`)
            return client
        },
    }
}

/** Creates a mock client that tags results with the base name */
function createMockClient(baseName: string): ClientLike {
    return {
        listTables: async () => [{ name: `Table_${baseName}`, _id: `tbl_${baseName}` }],
        getMetadata: async () => ({ tables: [] }),
        listRows: async () => ({ rows: [] }),
        getRow: async () => ({ _id: 'r1', _base: baseName }),
        addRow: async (_t: string, row: Record<string, unknown>) => ({ _id: 'new', ...row, _base: baseName }),
        updateRow: async () => ({ _id: 'r1', _base: baseName }),
        deleteRow: async () => ({ success: true }),
        searchRows: async () => ({ rows: [] }),
        querySql: async () => ({ metadata: {}, results: [] }),
        listCollaborators: async () => [],
        createLinks: async () => ({ success: true }),
        deleteLinks: async () => ({ success: true }),
        addColumnOptions: async () => ({ success: true }),
        uploadFile: async () => ({ file_name: 'f.png', file_size: 0, asset_url: '/mock', column_type: 'image' }),
    } as ClientLike
}

describe('ContextualClient', () => {
    it('delegates to the correct base after setBase()', async () => {
        const registry = createMockRegistry(['CRM', 'Projects'])
        const ctx = new ContextualClient(registry as any)

        ctx.setBase('CRM')
        const crmTables = await ctx.listTables()
        expect(crmTables[0].name).toBe('Table_CRM')

        ctx.setBase('Projects')
        const projTables = await ctx.listTables()
        expect(projTables[0].name).toBe('Table_Projects')
    })

    it('defaults to single base when no name set', async () => {
        const registry = createMockRegistry(['OnlyBase'])
        const ctx = new ContextualClient(registry as any)

        // No setBase call — should resolve to the single base
        const tables = await ctx.listTables()
        expect(tables[0].name).toBe('Table_OnlyBase')
    })

    it('throws when multi-base and no name set', () => {
        const registry = createMockRegistry(['A', 'B'])
        const ctx = new ContextualClient(registry as any)

        // The getter throws synchronously when resolving the client
        expect(() => ctx.listTables()).toThrow('Specify "base" parameter')
    })

    it('throws for unknown base name', () => {
        const registry = createMockRegistry(['CRM'])
        const ctx = new ContextualClient(registry as any)

        ctx.setBase('Nonexistent')
        expect(() => ctx.listTables()).toThrow('Unknown base "Nonexistent"')
    })

    it('proxies all ClientLike methods', async () => {
        const registry = createMockRegistry(['CRM'])
        const ctx = new ContextualClient(registry as any)
        ctx.setBase('CRM')

        // Verify a representative set of methods all resolve without error
        await expect(ctx.getMetadata()).resolves.toBeDefined()
        await expect(ctx.listRows({ table: 'T' })).resolves.toBeDefined()
        await expect(ctx.getRow('T', 'r1')).resolves.toBeDefined()
        await expect(ctx.addRow('T', { Name: 'x' })).resolves.toBeDefined()
        await expect(ctx.updateRow('T', 'r1', { Name: 'y' })).resolves.toBeDefined()
        await expect(ctx.deleteRow('T', 'r1')).resolves.toBeDefined()
        await expect(ctx.searchRows('T', { Name: 'x' })).resolves.toBeDefined()
        await expect(ctx.querySql('SELECT 1')).resolves.toBeDefined()
        await expect(ctx.listCollaborators()).resolves.toBeDefined()
        await expect(ctx.createLinks({ table: 'T', linkColumn: 'L', pairs: [] })).resolves.toBeDefined()
        await expect(ctx.deleteLinks({ table: 'T', linkColumn: 'L', pairs: [] })).resolves.toBeDefined()
        await expect(ctx.addColumnOptions({ table: 'T', column: 'C', options: [] })).resolves.toBeDefined()
        await expect(ctx.uploadFile({ table: 'T', column: 'C', rowId: 'r1', fileName: 'f.png', fileData: '' })).resolves.toBeDefined()
    })

    it('setBase changes routing between calls', async () => {
        const registry = createMockRegistry(['CRM', 'Projects'])
        const ctx = new ContextualClient(registry as any)

        ctx.setBase('CRM')
        const row1 = await ctx.addRow('T', { x: 1 })
        expect((row1 as any)._base).toBe('CRM')

        ctx.setBase('Projects')
        const row2 = await ctx.addRow('T', { x: 2 })
        expect((row2 as any)._base).toBe('Projects')
    })
})
