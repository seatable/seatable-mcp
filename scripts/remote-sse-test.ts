import { EventSource } from 'eventsource'

// Simple SSE transport test script for the deployed Cloudflare Worker MCP server
// Usage: tsx scripts/remote-sse-test.ts

const BASE = process.env.MCP_BASE_URL || 'https://mcp-seatable.brian-money.workers.dev'
const SSE_URL = BASE.replace(/\/$/, '') + '/sse'

interface Pending {
  resolve: (v: any) => void
  reject: (e: any) => void
}

const pending = new Map<number, Pending>()
let nextId = 1

function rpc(method: string, params: any): Promise<any> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    fetch(SSE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-protocol-version': '2024-11-05'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    }).catch(reject)
  })
}

async function main() {
  console.log('Connecting to', SSE_URL)
  // eventsource lib doesn't support custom headers; append protocol version as query (server ignores extra param harmlessly)
  const es = new EventSource(SSE_URL + '?pv=2024-11-05')
  es.onmessage = (ev: MessageEvent) => {
    if (!ev.data) return
    try {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(msg.error)
        else p.resolve(msg.result)
      } else if (msg.method === 'notifications/ready') {
        console.log('[ready]', msg.params)
      } else if (msg.method === 'notifications/message') {
        console.log('[message]', JSON.stringify(msg.params?.content))
      } else {
        console.log('[event]', msg)
      }
    } catch (e) {
      console.error('Parse error', e)
    }
  }
  es.onerror = (e: any) => {
    console.error('SSE error', e)
  }

  // Wait briefly for connection
  await new Promise(r => setTimeout(r, 400))

  console.log('Requesting tools list...')
  const toolsList = await rpc('tools/list', {})
  console.log('tools/list result toolCount=', toolsList?.tools?.length)
  const hasAddRow = toolsList?.tools?.some((t: any) => t.name === 'add_row')
  console.log('add_row present?', hasAddRow)

  console.log('Calling add_row...')
  const addRowRes = await rpc('tools/call', { name: 'add_row', arguments: { table: 'Test', row: { Name: 'FromSSE', status: '1' } } })
  console.log('add_row result:', JSON.stringify(addRowRes).slice(0, 400))

  console.log('Calling list_rows...')
  const listRowsRes = await rpc('tools/call', { name: 'list_rows', arguments: { table: 'Test', page: 1, page_size: 5 } })
  console.log('list_rows rows sample:', JSON.stringify(listRowsRes).slice(0, 400))

  es.close()
  console.log('Done.')
}

main().catch(err => {
  console.error('Script failed', err)
  process.exit(1)
})
