import { describe, expect, it, beforeAll } from 'vitest'

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_BASE_UUID = 'test-base'
})

import { SeaTableClient } from '../src/seatable/client'

// Basic shape tests for the client. These are lightweight and do not hit a real API.
describe('SeaTableClient', () => {
    it('constructs without error', () => {
        const client = new SeaTableClient()
        expect(client).toBeTruthy()
    })

    it('exposes expected methods', () => {
        const client = new SeaTableClient()
        expect(typeof client.getMetadata).toBe('function')
        expect(typeof client.listTables).toBe('function')
        expect(typeof client.listRows).toBe('function')
        expect(typeof client.getRow).toBe('function')
        expect(typeof client.addRow).toBe('function')
        expect(typeof client.updateRow).toBe('function')
        expect(typeof client.deleteRow).toBe('function')
        expect(typeof client.searchRows).toBe('function')
        expect(typeof client.querySql).toBe('function')
        expect(typeof client.createTable).toBe('function')
        expect(typeof client.renameTable).toBe('function')
        expect(typeof client.deleteTable).toBe('function')
        expect(typeof client.createColumn).toBe('function')
        expect(typeof client.updateColumn).toBe('function')
        expect(typeof client.deleteColumn).toBe('function')
        expect(typeof client.updateSelectOptions).toBe('function')
    })
})
