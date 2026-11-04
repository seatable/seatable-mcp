import axios from 'axios'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { makeError } from '../src/errors'
import { SeaTableClient } from '../src/seatable/client'
import { buildServer, SeaTableMCPServer } from '../src/mcp/server'

beforeAll(() => {
    process.env.SEATABLE_SERVER_URL = 'http://localhost'
    process.env.SEATABLE_API_TOKEN = 'test-token'
    process.env.SEATABLE_MOCK = 'true'
})

function callTool(server: SeaTableMCPServer, name: string, args?: Record<string, unknown>) {
    return (server as any).handleCallTool({
        params: { name, arguments: args ?? {} },
    })
}

function parseContent(result: any): any {
    return JSON.parse(result.content[0].text)
}

describe('download_file tool', () => {
    let server: SeaTableMCPServer

    beforeAll(() => {
        server = buildServer()
    })

    // --- Positive tests ---

    it('returns mock file content with required args', async () => {
        const result = await callTool(server, 'download_file', {
            table: 'Table1',
            column: 'Docs',
            row_id: 'row_1',
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data).toHaveProperty('file_name')
        expect(data).toHaveProperty('file_size')
        expect(data).toHaveProperty('content')
        expect(data).toHaveProperty('content_type', 'text')
    })

    it('passes file_name to mock when specified', async () => {
        const result = await callTool(server, 'download_file', {
            table: 'Table1',
            column: 'Docs',
            row_id: 'row_1',
            file_name: 'report.csv',
        })
        expect(result.isError).toBeUndefined()
        const data = parseContent(result)
        expect(data.file_name).toBe('report.csv')
    })

    // --- Negative tests ---

    it('rejects missing table parameter', async () => {
        const result = await callTool(server, 'download_file', {
            column: 'Docs',
            row_id: 'row_1',
        })
        expect(result.isError).toBe(true)
    })

    it('rejects missing column parameter', async () => {
        const result = await callTool(server, 'download_file', {
            table: 'Table1',
            row_id: 'row_1',
        })
        expect(result.isError).toBe(true)
    })

    it('rejects missing row_id parameter', async () => {
        const result = await callTool(server, 'download_file', {
            table: 'Table1',
            column: 'Docs',
        })
        expect(result.isError).toBe(true)
    })

    it('rejects empty args', async () => {
        const result = await callTool(server, 'download_file', {})
        expect(result.isError).toBe(true)
    })
})

describe('download_file client logic', () => {
    const textExts = (SeaTableClient as any).TEXT_EXTENSIONS as Set<string>
    const maxSize = (SeaTableClient as any).MAX_FILE_SIZE as number

    it('TEXT_EXTENSIONS contains common text file types', () => {
        for (const ext of ['txt', 'csv', 'json', 'md', 'xml', 'html', 'yaml', 'yml', 'sql', 'py', 'js', 'ts']) {
            expect(textExts.has(ext), `expected "${ext}" to be a text extension`).toBe(true)
        }
    })

    it('TEXT_EXTENSIONS does not contain binary types', () => {
        for (const ext of ['pdf', 'docx', 'xlsx', 'png', 'jpg', 'gif', 'zip', 'tar', 'exe', 'mp4']) {
            expect(textExts.has(ext), `expected "${ext}" NOT to be a text extension`).toBe(false)
        }
    })

    it('MAX_FILE_SIZE is 1 MB', () => {
        expect(maxSize).toBe(1 * 1024 * 1024)
    })
})

// Directory review fails tools that answer with a bare "ERR_SERVER". These
// run the real client with its SeaTable calls stubbed out, so the error
// handling in downloadFile/uploadFile is exercised end to end.
describe('download_file / upload_file error messages', () => {
    afterEach(() => vi.restoreAllMocks())

    const metadata = {
        tables: [{ name: 'Docs', columns: [
            { name: 'Files', type: 'file' },
            { name: 'Title', type: 'text' },
        ] }],
    }

    function stubbedClient(getRow: (table: string, rowId: string) => Promise<any>) {
        const client = new SeaTableClient({ serverUrl: 'http://localhost', apiToken: 'test-token' }) as any
        client.ensureInitialized = async () => {}
        client.getMetadata = async () => metadata
        client.getRow = getRow
        return client as SeaTableClient
    }
    const download = (client: SeaTableClient, args: Partial<{ table: string; column: string; rowId: string }> = {}) =>
        client.downloadFile({ table: 'Docs', column: 'Files', rowId: 'r1', ...args })

    it('names the row and column when there is no file', async () => {
        const client = stubbedClient(async () => ({ Files: [] }))
        await expect(download(client)).rejects.toMatchObject({
            code: 'ERR_VALIDATION',
            message: 'No files found in column "Files" for row "r1"',
        })
    })

    it('reports unknown tables and columns with schema codes', async () => {
        const client = stubbedClient(async () => ({}))
        await expect(download(client, { table: 'Nope' })).rejects.toMatchObject({ code: 'ERR_SCHEMA_UNKNOWN_TABLE', message: 'Table "Nope" not found' })
        await expect(download(client, { column: 'Nope' })).rejects.toMatchObject({ code: 'ERR_SCHEMA_UNKNOWN_COLUMN' })
        await expect(download(client, { column: 'Title' })).rejects.toMatchObject({ code: 'ERR_VALIDATION', message: expect.stringContaining('expected "image" or "file"') })
    })

    it('keeps the code and message of a failed SeaTable call', async () => {
        const client = stubbedClient(async () => { throw makeError('ERR_BAD_REQUEST', 'ERR_BAD_REQUEST: row not found') })
        await expect(download(client)).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST', message: 'ERR_BAD_REQUEST: row not found' })
    })

    it('still converts HTTP errors', async () => {
        const client = stubbedClient(async () => ({ Files: [{ name: 'a.pdf', url: '/workspace/1/asset/u/files/2026-11/a.pdf' }] }))
        const httpError = Object.assign(new Error('Request failed'), {
            isAxiosError: true,
            response: { status: 404, data: { error_msg: 'File not found' } },
        })
        vi.spyOn(axios, 'get').mockRejectedValueOnce(httpError)
        await expect(download(client)).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST', message: 'ERR_BAD_REQUEST: File not found' })
    })

    it('upload_file keeps its validation messages', async () => {
        const client = stubbedClient(async () => ({}))
        await expect(client.uploadFile({ table: 'Docs', column: 'Nope', rowId: 'r1', fileName: 'a.txt', fileData: 'YQ==' }))
            .rejects.toMatchObject({ code: 'ERR_SCHEMA_UNKNOWN_COLUMN', message: 'Column "Nope" not found in table "Docs"' })
    })
})
