#!/usr/bin/env tsx
/**
 * variant-payload-test.ts
 * Attempts multiple JSON-RPC payload shapes for tools/call to discover which form the server actually accepts.
 * Focuses on a single tool (add_row) but can be adapted.
 *
 * Usage:
 *   npx tsx scripts/variant-payload-test.ts --baseUrl=https://<worker>.workers.dev --table=Test
 */
import { EventSource } from 'eventsource'

interface Args { baseUrl: string; table: string }
function parseArgs(): Args {
  const out: Partial<Args> = { baseUrl: 'http://localhost:8787' }
  for (const a of process.argv.slice(2)) {
    const [k,v] = a.split('=')
    if (k==='--baseUrl' && v) out.baseUrl = v
    if (k==='--table' && v) out.table = v
  }
  if (!out.table) { console.error('Missing --table'); process.exit(1) }
  return out as Args
}

type Pending = { resolve:(v:any)=>void; reject:(e:any)=>void }

async function main() {
  const args = parseArgs()
  const sseUrl = args.baseUrl.replace(/\/$/, '') + '/sse'
  const es = new EventSource(sseUrl)
  let endpoint: string | undefined
  const pending = new Map<number, Pending>()
  let nextId = 1

  const endpointReady = new Promise<void>((resolve,reject)=>{
    const t = setTimeout(()=>reject(new Error('endpoint timeout')), 8000)
    es.addEventListener('endpoint',(ev:any)=>{ clearTimeout(t); endpoint = args.baseUrl.replace(/\/$/, '') + ev.data; resolve() })
    es.onerror = (e:any)=>{ clearTimeout(t); reject(e) }
  })

  es.onmessage = (ev:any)=>{
    const raw = ev.data as string
    if (!raw) return
    try {
      const msg = JSON.parse(raw)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!.resolve(msg)
        pending.delete(msg.id)
      }
    } catch {}
  }

  await endpointReady
  if (!endpoint) throw new Error('No endpoint')

  async function rpc(method:string, params:any) {
    const id = nextId++
    const p = new Promise<any>((resolve,reject)=>{
      pending.set(id,{resolve,reject})
      setTimeout(()=>{ if (pending.has(id)) { pending.get(id)!.reject(new Error('timeout')); pending.delete(id) } }, 15000)
    })
    await fetch(endpoint!, { method:'POST', headers:{'Content-Type':'application/json','mcp-protocol-version':'2024-11-05'}, body: JSON.stringify({ jsonrpc:'2.0', id, method, params }) })
    return p
  }

  await rpc('initialize', { protocolVersion:'2024-11-05', capabilities:{ tools:{} }, clientInfo:{ name:'variant-test', version:'0.1.0' } })

  // Base payload to send in different shapes
  const baseArgs = { table: args.table, row: { variant_probe: true, ts: new Date().toISOString() } }

  type Variant = { label: string; params: any }
  const variants: Variant[] = [
    { label: 'standard_arguments', params: { name: 'add_row', arguments: baseArgs } },
    { label: 'args_key', params: { name: 'add_row', args: baseArgs } },
    { label: 'flattened', params: { name: 'add_row', ...baseArgs } },
    { label: 'both_arguments_and_flat', params: { name: 'add_row', arguments: baseArgs, ...baseArgs } },
    { label: 'nested_payload', params: { name: 'add_row', arguments: { payload: baseArgs } } },
  ]

  const results: Record<string, any> = {}
  for (const v of variants) {
    try {
      const resp = await rpc('tools/call', v.params)
      const content = resp.result?.content?.[0]?.text
      let parsed: any = content
      try { parsed = content ? JSON.parse(content) : content } catch {}
      results[v.label] = parsed
    } catch (e:any) {
      results[v.label] = { error: e.message }
    }
  }

  es.close()
  console.log('Variant Results:')
  for (const [k,v] of Object.entries(results)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    console.log(k+':', s.length>300? s.slice(0,300)+'…': s)
  }
}

main().catch(err => { console.error('variant-payload-test failed', err); process.exitCode = 1 })
