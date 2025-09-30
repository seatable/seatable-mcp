#!/usr/bin/env tsx
/**
 * transport-parity.ts
 * Executes a matrix of tool calls against both /mcp (streamable HTTP) and /sse (SSE) transports
 * and reports any differences in top-level tool result content payload text.
 *
 * Usage:
 *   tsx scripts/transport-parity.ts --baseUrl=http://localhost:8787 --tools=list_tables,list_rows
 *
 * By default runs a small default set.
 */
import { randomUUID } from 'node:crypto'
import { EventSource } from 'eventsource'

interface Args { baseUrl: string; tools?: string[] }
function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const out: Args = { baseUrl: 'http://localhost:8787' }
  for (const a of argv) {
    const [k, v] = a.split('=')
    if (k === '--baseUrl' && v) out.baseUrl = v
    if (k === '--tools' && v) out.tools = v.split(',').filter(Boolean)
  }
  return out
}

interface CallResult { ok: boolean; text?: string; error?: string }

async function callHTTP(baseUrl: string, name: string, args: any): Promise<CallResult> {
  const id = randomUUID()
  const body = { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const json = await res.json()
  const content = json.result?.content?.[0]?.text ?? json.result?.content?.[0]?.text ?? JSON.stringify(json.result || json.error)
  return { ok: !json.result?.isError, text: content }
}

async function callSSE(baseUrl: string, name: string, args: any): Promise<CallResult> {
  let endpoint: string | undefined
  const esUrl = baseUrl.replace(/\/$/, '') + '/sse'
  const pending: Record<number, (v: any) => void> = {}
  const waitFor = (id: number) => new Promise<any>((resolve, reject) => {
    pending[id] = resolve
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error(`Timeout id ${id}`)) } }, 10000)
  })
  try {
    const es = new EventSource(esUrl)
    const endpointPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting endpoint')), 8000)
      es.addEventListener('endpoint', (ev: any) => {
        clearTimeout(timer)
        // @ts-ignore
        const data = ev.data as string
        endpoint = baseUrl.replace(/\/$/, '') + data
        resolve()
      })
      es.onerror = (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error('SSE error')) }
    })
    es.onmessage = (ev: any) => {
      try {
        // @ts-ignore
        const raw = ev.data as string
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (parsed.id && pending[parsed.id]) { pending[parsed.id](parsed); delete pending[parsed.id] }
      } catch { /* ignore */ }
    }
    await endpointPromise
    if (!endpoint) return { ok: false, error: 'No message endpoint resolved' }

    async function rpc(id: number, method: string, params: any) {
      await fetch(endpoint!, { method: 'POST', headers: { 'Content-Type': 'application/json', 'mcp-protocol-version': '2024-11-05' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    }
    const pInit = waitFor(1)
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'parity-script', version: '0.1.0' } })
    await pInit
    const pCall = waitFor(2)
    await rpc(2, 'tools/call', { name, arguments: args })
    const resp = await pCall
    es.close()
    const content = resp.result?.content?.[0]?.text || JSON.stringify(resp.result || resp.error)
    return { ok: !resp.result?.isError, text: content }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function main() {
  const { baseUrl, tools } = parseArgs()
  const matrix = tools && tools.length ? tools : ['ping_seatable']
  const results: any[] = []
  for (const tool of matrix) {
    const args = {} // Extend: argument presets per tool
    const httpRes = await callHTTP(baseUrl, tool, args)
    const sseRes = await callSSE(baseUrl, tool, args)
    results.push({ tool, http: httpRes, sse: sseRes })
  }

  let diffs = 0
  for (const r of results) {
    if (r.http.text !== r.sse.text || r.http.ok !== r.sse.ok) diffs++
  }

  console.log(JSON.stringify({ baseUrl, results, diffs }, null, 2))
  if (diffs > 0) {
    process.exitCode = 1
  }
}

main().catch(err => { console.error('transport-parity failed:', err); process.exitCode = 1 })
