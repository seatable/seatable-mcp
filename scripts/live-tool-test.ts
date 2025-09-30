#!/usr/bin/env tsx
/**
 * live-tool-test.ts
 * Simple end-to-end test runner that talks to the deployed Worker SSE transport
 * using raw JSON-RPC and exercises a subset of tools.
 *
 * Usage:
 *   tsx scripts/live-tool-test.ts --baseUrl=https://<worker>.workers.dev --table=MyTable
 *   (Optional) --debug to log all raw events
 */
import { EventSource } from 'eventsource'

interface Args { baseUrl: string; table?: string; debug: boolean }

function parseArgs(): Args {
  const out: Args = { baseUrl: 'http://localhost:8787', debug: false }
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split('=')
    if (k === '--baseUrl' && v) out.baseUrl = v
    if (k === '--table' && v) out.table = v
    if (k === '--debug') out.debug = true
  }
  return out
}

type Pending = { resolve: (v: any)=>void; reject: (e:any)=>void; method: string }

async function run() {
  const args = parseArgs()
  const sseUrl = args.baseUrl.replace(/\/$/, '') + '/sse'
  const es = new EventSource(sseUrl)
  let messageEndpoint: string | undefined
  const pending = new Map<number, Pending>()
  let nextId = 1

  function log(...m: any[]) { if (args.debug) console.log('[debug]', ...m) }

  const endpointPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for endpoint event')), 8000)
    es.addEventListener('endpoint', (ev: any) => {
      clearTimeout(timer)
      const data = ev.data as string
      messageEndpoint = args.baseUrl.replace(/\/$/, '') + data
      log('endpoint ->', messageEndpoint)
      resolve()
    })
    es.onerror = (err: any) => {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error('SSE error'))
    }
  })

  es.onmessage = (ev: any) => {
    try {
      const raw = ev.data as string
      if (!raw) return
      const msg = JSON.parse(raw)
      if (args.debug) log('event', msg)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        if (msg.error) p.reject(new Error(msg.error.message || 'RPC error'))
        else p.resolve(msg)
        pending.delete(msg.id)
      }
    } catch {/* ignore */}
  }

  await endpointPromise
  if (!messageEndpoint) throw new Error('No message endpoint discovered')

  async function rpc(method: string, params: any) {
    const id = nextId++
    const promise = new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      setTimeout(() => {
        if (pending.has(id)) {
          pending.get(id)!.reject(new Error(`Timeout on ${method} id=${id}`))
          pending.delete(id)
        }
      }, 15000)
    })
    await fetch(messageEndpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'mcp-protocol-version': '2024-11-05' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    return promise
  }

  function unwrap(result: any) {
    const toolResult = result?.result
    if (!toolResult) return result
    return toolResult
  }

  // 1. initialize
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'live-tool-test', version: '0.1.0' } })
  const toolsResp = await rpc('tools/list', {})
  const toolNames = toolsResp.result?.tools?.map((t:any) => t.name) || []
  console.log('Tools:', toolNames.sort().join(', '))

  // Basic tests (skip mutations needing table if not provided)
  const results: Record<string, any> = {}
  async function callTool(name: string, input: any) {
    const resp = await rpc('tools/call', { name, arguments: input })
    const content = resp.result?.content?.[0]?.text
    let parsed: any
    try { parsed = content ? JSON.parse(content) : content } catch { parsed = content }
    results[name] = parsed
  }

  if (toolNames.includes('ping_seatable')) await callTool('ping_seatable', {})
  if (args.table) {
    if (toolNames.includes('list_tables')) await callTool('list_tables', {})
    if (toolNames.includes('list_rows')) await callTool('list_rows', { table: args.table, page: 1, page_size: 5 })
  }

  if (args.table && toolNames.includes('add_row')) {
    await callTool('add_row', { table: args.table, row: { mcp_probe: 'ok', ts: new Date().toISOString() } })
  }

  es.close()
  console.log('\nSummary:')
  for (const [k, v] of Object.entries(results)) {
    console.log('-', k, '=>', JSON.stringify(v).slice(0, 300))
  }
}

run().catch(err => {
  console.error('live-tool-test failed:', err)
  process.exitCode = 1
})
