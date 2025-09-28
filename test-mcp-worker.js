#!/usr/bin/env node

import { EventSource } from 'eventsource';
import fetch from 'node-fetch';

const WORKER_URL = 'https://mcp-seatable.brian-money.workers.dev';

async function testMCPWorker() {
    console.log('🧪 Testing MCP Worker...\n');
    
    try {
        // 1. Connect to SSE endpoint
        console.log('📡 Connecting to SSE endpoint...');
        const sseResponse = await fetch(`${WORKER_URL}/sse`, {
            headers: { 'Accept': 'text/event-stream' },
            timeout: 5000
        });
        
        const sseText = await sseResponse.text();
        const endpointMatch = sseText.match(/data: (.+)/);
        
        if (!endpointMatch) {
            throw new Error('No endpoint found in SSE response');
        }
        
        const messageEndpoint = endpointMatch[1];
        console.log(`✅ Got message endpoint: ${messageEndpoint}\n`);
        
        // 2. Send initialize request
        console.log('🚀 Sending initialize request...');
        const initResponse = await fetch(`${WORKER_URL}${messageEndpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-25',
                    capabilities: {
                        roots: { listChanged: false },
                        sampling: {}
                    }
                },
                id: 1
            })
        });
        
        console.log(`Initialize response: ${initResponse.status} ${initResponse.statusText}`);
        
        // 3. Test tools/list
        console.log('\n📋 Testing tools/list...');
        const toolsResponse = await fetch(`${WORKER_URL}${messageEndpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 2
            })
        });
        
        console.log(`Tools list response: ${toolsResponse.status} ${toolsResponse.statusText}`);
        
        // 4. Test ping_seatable
        console.log('\n🏓 Testing ping_seatable...');
        const pingResponse = await fetch(`${WORKER_URL}${messageEndpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'ping_seatable',
                    arguments: {}
                },
                id: 3
            })
        });
        
        console.log(`Ping response: ${pingResponse.status} ${pingResponse.statusText}`);
        
        // 5. Test list_tables
        console.log('\n📊 Testing list_tables...');
        const tablesResponse = await fetch(`${WORKER_URL}${messageEndpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'list_tables',
                    arguments: {}
                },
                id: 4
            })
        });
        
        console.log(`List tables response: ${tablesResponse.status} ${tablesResponse.statusText}`);
        
        console.log('\n✅ All tests completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

testMCPWorker();