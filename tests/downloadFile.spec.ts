import { beforeAll, describe, expect, it } from 'vitest'

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
