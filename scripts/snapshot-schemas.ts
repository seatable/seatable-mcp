#!/usr/bin/env tsx
/**
 * snapshot-schemas.ts
 * Fetches tool schemas from a running Cloudflare Worker MCP endpoint (/mcp list_tools)
 * and writes a canonical snapshot JSON for diffing in CI.
 *
 * Usage:
 *   tsx scripts/snapshot-schemas.ts --baseUrl=https://<worker>.workers.dev --out=tests/fixtures/tool-schemas.snapshot.json
 *   tsx scripts/snapshot-schemas.ts (defaults: baseUrl=http://localhost:8787, out=tests/fixtures/tool-schemas.snapshot.json)
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventSource } from 'eventsource'

interface Args { baseUrl: string; out: string }

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const out: Args = { baseUrl: 'http://localhost:8787', out: 'tests/fixtures/tool-schemas.snapshot.json' }
  for (const a of argv) {
    const [k, v] = a.split('=')
    if (k === '--baseUrl' && v) out.baseUrl = v
    if (k === '--out' && v) out.out = v
  }
  return out
}

async function httpListTools(baseUrl: string) {
  // Try an initialize first (some implementations may require it)
  const initRes = await fetch(baseUrl.replace(/\/$/, '') + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'mcp-protocol-version': '2024-11-05'
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'schema-snapshot', version: '0.1.0' }
      }
    })
  })
  if (initRes.status === 406) throw new Error('HTTP_NOT_ACCEPTABLE')
  if (!initRes.ok) throw new Error(`Initialize failed HTTP ${initRes.status}`)

  const listRes = await fetch(baseUrl.replace(/\/$/, '') + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'mcp-protocol-version': '2024-11-05'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  })
  if (listRes.status === 406) throw new Error('HTTP_NOT_ACCEPTABLE')
  if (!listRes.ok) throw new Error(`List tools failed HTTP ${listRes.status}`)
  const json = await listRes.json()
  if (!json.result?.tools) throw new Error('Unexpected list_tools response shape')
  return json.result.tools
}

async function sseListTools(baseUrl: string) {
  const sseUrl = baseUrl.replace(/\/$/, '') + '/sse'
  let messageEndpoint: string | undefined
  const pending: Record<number, (value: any) => void> = {}
  const failures: Record<number, (reason?: any) => void> = {}

  const waitFor = (id: number) => new Promise<any>((resolve, reject) => {
    pending[id] = resolve
    failures[id] = reject
    setTimeout(() => {
      if (pending[id]) {
        delete pending[id]
        delete failures[id]
        reject(new Error(`Timeout waiting for response id ${id}`))
      }
    }, 10000)
  })

  const es = new EventSource(sseUrl)
  const endpointPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Timeout waiting for endpoint event')) }, 8000)
    es.addEventListener('endpoint', (ev: any) => {
      clearTimeout(timer)
      // @ts-ignore
      const data = ev.data as string
      messageEndpoint = baseUrl.replace(/\/$/, '') + data
      resolve()
    })
    es.onerror = (err: unknown) => {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error('SSE error'))
    }
  })

  es.onmessage = (ev: any) => {
    try {
      // @ts-ignore
      const raw = ev.data as string
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed.id && pending[parsed.id]) {
        pending[parsed.id](parsed)
        delete pending[parsed.id]
        delete failures[parsed.id]
      }
    } catch {
      // ignore non-JSON events
    }
  }

  await endpointPromise
  if (!messageEndpoint) throw new Error('No message endpoint resolved')

  // Helper to post JSON-RPC to message endpoint
  async function rpc(id: number, method: string, params: any) {
    await fetch(messageEndpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'mcp-protocol-version': '2024-11-05' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
  }

  // Initialize (id 1) and list tools (id 2)
  const pInit = waitFor(1)
  await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'schema-snapshot', version: '0.1.0' } })
  await pInit // ensure initialize acknowledged before listing tools (some servers may enforce ordering)
  const pList = waitFor(2)
  await rpc(2, 'tools/list', {})
  const listResp = await pList
  es.close()
  if (!listResp.result?.tools) throw new Error('tools/list response missing tools array')
  return listResp.result.tools
}

function normalize(tools: any[]): any {
  // Sort tools & properties for stable output
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
    const tool = { ...t }
    if (tool.inputSchema && tool.inputSchema.properties) {
      const props = tool.inputSchema.properties
      const ordered: Record<string, any> = {}
      Object.keys(props).sort().forEach(k => { ordered[k] = props[k] })
      tool.inputSchema.properties = ordered
    }
    return tool
  })
  return { generated_at: new Date().toISOString(), tools: sorted }
}

async function main() {
  const { baseUrl, out } = parseArgs()
  let tools: any[] = []
  try {
    tools = await httpListTools(baseUrl)
  } catch (e: any) {
    if (e && e.message === 'HTTP_NOT_ACCEPTABLE') {
      console.warn('HTTP transport not accepted, falling back to SSE...')
      tools = await sseListTools(baseUrl)
    } else {
      console.warn('HTTP list_tools failed, attempting SSE fallback:', e?.message)
      tools = await sseListTools(baseUrl)
    }
  }
  const normalized = normalize(tools)
  const outPath = path.resolve(out)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  console.log(`Schema snapshot written: ${outPath}`)
}

main().catch(err => {
  console.error('snapshot-schemas failed:', err)
  process.exitCode = 1
})
