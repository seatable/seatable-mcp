#!/usr/bin/env node
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const cmd = "set -a; [ -f .env ] && . .env; set +a; node ./bin/seatable-mcp";

const child = spawn('bash', ['-lc', cmd], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  cwd: process.cwd(),
});

const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  } catch {
    // ignore non-JSON
  }
});

(async () => {
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'mcp-probe', version: '0.1.0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    const res = await request('tools/call', { name: 'ping_seatable', arguments: {} });
    const out = res.result || res.error || {};
    // Print only the tool content text for clarity
    if (out.content && out.content[0] && out.content[0].text) {
      console.log(out.content[0].text);
    } else {
      console.log(JSON.stringify(out));
    }
  } catch (err) {
    console.error('Probe error:', err.message || err);
    process.exitCode = 1;
  } finally {
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, 250);
  }
})();
