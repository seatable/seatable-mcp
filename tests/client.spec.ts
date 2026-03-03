import { describe, expect, it } from 'vitest'

import { SeaTableClient } from '../src/seatable/client'

// Basic shape tests for the client. These are lightweight and do not hit a real API.
describe('SeaTableClient', () => {
    const config = {
        serverUrl: 'http://localhost',
        apiToken: 'test-token',
        baseUuid: 'test-base',
    }

    it('constructs without error', () => {
        const client = new SeaTableClient(config)
        expect(client).toBeTruthy()
    })

    it('constructs with all options', () => {
        const client = new SeaTableClient({
            ...config,
            timeoutMs: 5000,
        })
        expect(client).toBeTruthy()
    })

    it('exposes expected methods', () => {
        const client = new SeaTableClient(config)
        expect(typeof client.getMetadata).toBe('function')
        expect(typeof client.listTables).toBe('function')
        expect(typeof client.listRows).toBe('function')
        expect(typeof client.getRow).toBe('function')
        expect(typeof client.addRow).toBe('function')
        expect(typeof client.updateRow).toBe('function')
        expect(typeof client.deleteRow).toBe('function')
        expect(typeof client.searchRows).toBe('function')
        expect(typeof client.querySql).toBe('function')
    })
})
