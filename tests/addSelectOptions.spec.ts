import { describe, expect, it } from 'vitest'

import { registerAddSelectOptions } from '../src/mcp/tools/addSelectOption.js'
import type { ClientLike } from '../src/mcp/tools/types.js'

type Handler = (args: unknown) => Promise<any>

/** Metadata with one single-select column that already has two options. */
function metadataWithOptions(names: string[]) {
    return {
        tables: [
            {
                _id: 'tbl1',
                name: 'Tasks',
                columns: [
                    { key: 'col1', name: 'Title', type: 'text' },
                    {
                        key: 'col2',
                        name: 'Statut',
                        type: 'single-select',
                        data: { options: names.map((n, i) => ({ id: `o${i}`, name: n, color: '#fff' })) },
                    },
                ],
            },
        ],
    }
}

/** Wire the registrar to a fake client and return the handler plus recorded calls. */
function setup(existing: string[]) {
    const calls: Array<{ table: string; column: string; options: Array<{ name: string }> }> = []
    const client = {
        getMetadata: async () => metadataWithOptions(existing),
        addColumnOptions: async (args: any) => {
            calls.push(args)
            return { success: true }
        },
    } as unknown as ClientLike

    let handler: Handler | undefined
    const server = {
        registerTool: (_name: string, _cfg: unknown, h: Handler) => {
            handler = h
        },
    }

    registerAddSelectOptions(server as any, {
        client,
        env: {} as any,
        getInputSchema: (s: any) => s,
    })

    return { handler: handler as Handler, calls }
}

function parse(result: any): any {
    return JSON.parse(result.content[0].text)
}

describe('add_select_options', () => {
    it('adds options that do not exist yet', async () => {
        const { handler, calls } = setup(['En cours'])
        const result = await handler({
            table: 'Tasks',
            column: 'Statut',
            options: [{ name: 'Reconnu' }],
        })

        expect(calls).toHaveLength(1)
        expect(calls[0].options.map((o) => o.name)).toEqual(['Reconnu'])
        expect(parse(result).added).toEqual(['Reconnu'])
    })

    it('skips options that already exist instead of duplicating them', async () => {
        const { handler, calls } = setup(['En cours', 'Reconnu'])
        const result = await handler({
            table: 'Tasks',
            column: 'Statut',
            options: [{ name: 'En cours' }, { name: 'Non reconnu' }],
        })

        expect(calls).toHaveLength(1)
        expect(calls[0].options.map((o) => o.name)).toEqual(['Non reconnu'])
        const data = parse(result)
        expect(data.added).toEqual(['Non reconnu'])
        expect(data.skipped).toEqual(['En cours'])
    })

    it('makes no API call when every option already exists', async () => {
        const { handler, calls } = setup(['En cours', 'Reconnu'])
        const result = await handler({
            table: 'Tasks',
            column: 'Statut',
            options: [{ name: 'En cours' }, { name: 'Reconnu' }],
        })

        expect(calls).toHaveLength(0)
        const data = parse(result)
        expect(data.added).toEqual([])
        expect(data.skipped).toEqual(['En cours', 'Reconnu'])
    })

    it('collapses duplicates within a single request', async () => {
        const { handler, calls } = setup([])
        await handler({
            table: 'Tasks',
            column: 'Statut',
            options: [{ name: 'Nouveau' }, { name: 'Nouveau' }],
        })

        expect(calls[0].options.map((o) => o.name)).toEqual(['Nouveau'])
    })

    it('treats option names as case-sensitive, like SeaTable does', async () => {
        const { handler, calls } = setup(['En cours'])
        await handler({
            table: 'Tasks',
            column: 'Statut',
            options: [{ name: 'EN COURS' }],
        })

        expect(calls[0].options.map((o) => o.name)).toEqual(['EN COURS'])
    })

    it('fails clearly when the column does not exist', async () => {
        const { handler } = setup(['En cours'])
        await expect(
            handler({ table: 'Tasks', column: 'Nope', options: [{ name: 'x' }] })
        ).rejects.toThrow(/Nope/)
    })
})
