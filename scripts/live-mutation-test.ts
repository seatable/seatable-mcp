#!/usr/bin/env tsx
/**
 * live-mutation-test.ts
 * End-to-end exercise of mutation and query tools over the deployed Worker SSE transport.
 *
 * Usage:
 *   npx tsx scripts/live-mutation-test.ts --baseUrl=https://<worker>.workers.dev --table=Test --debug
 */
import { EventSource } from 'eventsource'

interface Args { baseUrl: string; table: string; debug: boolean }

function parseArgs(): Args {
  const out: Partial<Args> = { baseUrl: 'http://localhost:8787', debug: false }
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split('=')
    if (k === '--baseUrl' && v) out.baseUrl = v
    if (k === '--table' && v) out.table = v
    if (k === '--debug') out.debug = true
  }
  if (!out.table) {
    console.error('Missing --table=<name>')
    process.exit(1)
  }
  return out as Args
}

type Pending = { resolve: (v:any)=>void; reject:(e:any)=>void; method:string }

async function main() {
  const args = parseArgs()
  const sseUrl = args.baseUrl.replace(/\/$/, '') + '/sse'
  const es = new EventSource(sseUrl)
  let endpoint: string | undefined
  const pending = new Map<number, Pending>()
  let nextId = 1
  const deadline = (ms: number, label: string) => setTimeout(()=>{
    console.error(`Timeout waiting for ${label}`)
    process.exit(1)
  }, ms)

  function debug(...m:any[]) { if (args.debug) console.log('[debug]', ...m) }

  const endpointReady = new Promise<void>((resolve, reject) => {
    const t = deadline(8000,'endpoint event')
    es.addEventListener('endpoint', (ev:any)=>{
      clearTimeout(t)
      endpoint = args.baseUrl.replace(/\/$/, '') + ev.data
      debug('endpoint ->', endpoint)
      resolve()
    })
    es.onerror = (e:any)=>{ clearTimeout(t); reject(e) }
  })

  es.onmessage = (ev:any)=>{
    const raw = ev.data as string
    if(!raw) return
    try {
      const msg = JSON.parse(raw)
      debug('evt', msg)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        if (msg.error) p.reject(new Error(msg.error.message || 'RPC error'))
        else p.resolve(msg)
        pending.delete(msg.id)
      }
    } catch {/* ignore non-json */}
  }

  await endpointReady
  if (!endpoint) throw new Error('No message endpoint resolved')

  async function rpc(method:string, params:any) {
    const id = nextId++
    const promise = new Promise<any>((resolve,reject)=>{
      pending.set(id,{resolve,reject,method})
      setTimeout(()=>{ if(pending.has(id)){ pending.get(id)!.reject(new Error(`Timeout on ${method}`)); pending.delete(id) } },15000)
    })
    await fetch(endpoint!, { method:'POST', headers:{'Content-Type':'application/json','mcp-protocol-version':'2024-11-05'}, body: JSON.stringify({ jsonrpc:'2.0', id, method, params }) })
    return promise
  }

  async function tool(name:string, input:any) {
    // Primary attempt using spec 'arguments'
    let resp = await rpc('tools/call', { name, arguments: input })
    let content = resp.result?.content?.[0]?.text
    let parsed: any = content
    try { parsed = content ? JSON.parse(content) : content } catch {/* ignore */}

    // Heuristic: if we see zod errors complaining required fields missing AND we passed them,
    // retry using legacy/alternate key 'args' (some early server variants used this).
    const missingRequired = typeof parsed === 'object' && parsed && parsed.error && /invalid_type/.test(parsed.error)
      && /"table"/.test(parsed.error)
    if (missingRequired) {
      const resp2 = await rpc('tools/call', { name, args: input })
      const content2 = resp2.result?.content?.[0]?.text
      let parsed2: any = content2
      try { parsed2 = content2 ? JSON.parse(content2) : content2 } catch {/* ignore */}
      // If second attempt produced a non-error, prefer it; else keep original for transparency
      if (!(typeof parsed2 === 'object' && parsed2 && parsed2.error)) {
        resp = resp2
        content = content2
        parsed = parsed2
      } else {
        parsed = { primary_error: parsed, secondary_error: parsed2 }
      }
    }
    return { raw: resp, parsed }
  }

  // Initialize & list tools
  await rpc('initialize',{ protocolVersion:'2024-11-05', capabilities:{ tools:{} }, clientInfo:{ name:'live-mutation-test', version:'0.1.0' } })
  const toolsList = await rpc('tools/list', {})
  const names = toolsList.result?.tools?.map((t:any)=>t.name) || []
  console.log('Tools available:', names.sort().join(', '))

  const summary: Record<string, any> = {}
  const table = args.table

  // list_tables
  if (names.includes('list_tables')) {
    summary.list_tables = (await tool('list_tables', {})).parsed
  }

  // add_row
  let addedRowId: string | undefined
  if (names.includes('add_row')) {
    const res = await tool('add_row', { table, row: { mcp_probe: 'mutation', ts: new Date().toISOString(), probe_counter: Math.floor(Math.random()*1000) } })
    summary.add_row = res.parsed
    addedRowId = res.parsed?._id || res.parsed?.id || res.parsed?.row_id
  }

  // list_rows first page
  if (names.includes('list_rows')) {
    summary.list_rows_initial = (await tool('list_rows', { table, page:1, page_size:5 })).parsed
  }

  // update_rows
  if (addedRowId && names.includes('update_rows')) {
    summary.update_rows = (await tool('update_rows', { table, updates:[{ row_id: addedRowId, values:{ probe_counter: 9999, mcp_probe_updated: true } }] })).parsed
  }

  // find_rows (DSL) looking for updated row
  if (names.includes('find_rows')) {
    summary.find_rows = (await tool('find_rows', { table, where:{ eq:{ field:'mcp_probe', value:'mutation' } }, page:1, page_size:5 })).parsed
  }

  // search_rows (server-side filter) if available
  if (names.includes('search_rows')) {
    summary.search_rows = (await tool('search_rows', { table, query:{ mcp_probe:'mutation' } })).parsed
  }

  // upsert_rows with two keys
  if (names.includes('upsert_rows')) {
    summary.upsert_rows = (await tool('upsert_rows', { table, key_columns:['mcp_key'], rows:[{ mcp_key:'key-1', val:1 }, { mcp_key:'key-2', val:2 }] })).parsed
  }

  // append_rows
  if (names.includes('append_rows')) {
    summary.append_rows = (await tool('append_rows', { table, rows:[{ batch_tag:'append', n:1 }, { batch_tag:'append', n:2 }] })).parsed
  }

  // delete_rows (cleanup added row only)
  if (addedRowId && names.includes('delete_rows')) {
    summary.delete_rows = (await tool('delete_rows', { table, row_ids:[addedRowId] })).parsed
  }

  // final list_rows snapshot
  if (names.includes('list_rows')) {
    summary.list_rows_final = (await tool('list_rows', { table, page:1, page_size:5 })).parsed
  }

  es.close()
  console.log('\n=== Mutation Test Summary (truncated JSON) ===')
  for (const [k,v] of Object.entries(summary)) {
    const s = JSON.stringify(v)
    console.log(k+':', s.length > 400 ? s.slice(0,400)+'…' : s)
  }
}

main().catch(err => { console.error('live-mutation-test failed:', err); process.exitCode = 1 })
