import { beforeAll, describe, expect, it } from 'vitest'

import { getEnv } from '../src/config/env'
import { getStaticToolDefinitions } from '../src/mcp/server'

/*
 * The JSON Schema is what clients see. A field with a default has to stay
 * optional: converted from the parsed output instead of the input it becomes
 * required, and models start failing on calls that used to work.
 */
const REQUIRED: Record<string, string[]> = {
    list_tables: [],
    list_rows: ['table'],
    get_row: ['table', 'row_id'],
    add_row: ['table', 'row'],
    append_rows: ['table', 'rows'],
    update_rows: ['table', 'updates'],
    delete_rows: ['table', 'row_ids'],
    find_rows: ['table'],
    search_rows: ['table', 'query'],
    upsert_rows: ['table', 'key_columns', 'rows'],
    link_rows: ['table', 'link_column', 'pairs'],
    unlink_rows: ['table', 'link_column', 'pairs'],
    get_schema: [],
    query_sql: ['sql'],
    execute_sql: ['sql'],
    list_collaborators: [],
    upload_file: ['table', 'column', 'row_id', 'file_name', 'file_data'],
    download_file: ['table', 'column', 'row_id'],
    create_snapshot: [],
    get_row_activities: ['table', 'row_id'],
    add_select_options: ['table', 'column', 'options'],
    ping_seatable: [],
}

describe('tool input schemas', () => {
    let tools: Array<{ name: string; inputSchema: any }>

    beforeAll(() => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_API_TOKEN = 'test-token'
        process.env.SEATABLE_MOCK = 'true'
        tools = getStaticToolDefinitions()
    })

    it('keep their required fields', () => {
        const actual = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []]))
        expect(actual).toEqual(REQUIRED)
    })

    it('are objects that allow additional properties', () => {
        // These two declare their schema by hand instead of converting one.
        const handWritten = ['list_tables', 'list_collaborators']
        for (const { name, inputSchema } of tools) {
            expect(inputSchema.type, name).toBe('object')
            if (!handWritten.includes(name)) expect(inputSchema.additionalProperties, name).toBe(true)
        }
    })

    it('keep descriptions, defaults and limits', () => {
        const findRows = tools.find((t) => t.name === 'find_rows')!.inputSchema.properties
        expect(findRows.table.description).toBe('Target table name')
        expect(findRows.page.default).toBe(1)
        expect(findRows.page_size.maximum).toBe(1000)

        const appendRows = tools.find((t) => t.name === 'append_rows')!.inputSchema.properties
        expect(appendRows.rows.maxItems).toBe(100)
    })
})

describe('TRUST_PROXY', () => {
    const withValue = (value: string | undefined) => {
        const before = process.env.TRUST_PROXY
        if (value === undefined) delete process.env.TRUST_PROXY
        else process.env.TRUST_PROXY = value
        try {
            return getEnv().TRUST_PROXY
        } finally {
            if (before === undefined) delete process.env.TRUST_PROXY
            else process.env.TRUST_PROXY = before
        }
    }

    it('is on unless switched off', () => {
        process.env.SEATABLE_SERVER_URL = 'http://localhost'
        process.env.SEATABLE_API_TOKEN = 'test-token'
        expect(withValue(undefined)).toBe(true)
        expect(withValue('true')).toBe(true)
        expect(withValue('0')).toBe(false)
        expect(withValue('false')).toBe(false)
    })
})
