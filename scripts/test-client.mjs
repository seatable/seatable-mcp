#!/usr/bin/env node

/**
 * MCP SeaTable Interactive Test Client
 * 
 * A comprehensive testing client that can connect to the MCP server
 * via multiple transports and test all available tools interactively.
 */

import { EventSource } from 'eventsource';
import readline from 'readline';

const WORKER_BASE_URL = process.env.WORKER_URL || 'https://mcp-seatable.brian-money.workers.dev';
const SSE_ENDPOINT = `${WORKER_BASE_URL}/sse`;
const HTTP_ENDPOINT = `${WORKER_BASE_URL}/mcp`;

class MCPTestClient {
    constructor() {
        this.sessionId = null;
        this.eventSource = null;
        this.currentId = 1;
        this.pendingRequests = new Map();
        this.availableTools = [];
        this.availableResources = [];
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    async start() {
        console.log('🧪 MCP SeaTable Interactive Test Client');
        console.log('=====================================\n');

        try {
            await this.connectSSE();
            await this.initialize();
            await this.loadCapabilities();
            await this.interactiveLoop();
        } catch (error) {
            console.error('❌ Test client error:', error.message);
        } finally {
            this.cleanup();
        }
    }

    async connectSSE() {
        console.log('📡 Connecting to SSE endpoint...');
        
        return new Promise((resolve, reject) => {
            this.eventSource = new EventSource(SSE_ENDPOINT);
            let connected = false;
            
            this.eventSource.onopen = () => {
                console.log('✅ Connected to SSE endpoint');
                connected = true;
            };
            
            this.eventSource.onerror = (error) => {
                console.error('❌ SSE connection error:', error);
                if (!connected) {
                    reject(new Error('Failed to connect to SSE endpoint'));
                }
            };
            
            this.eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                } catch (error) {
                    console.error('Failed to parse SSE message:', error);
                }
            };

            // Handle endpoint event to get session ID
            this.eventSource.addEventListener('endpoint', (event) => {
                try {
                    // The endpoint data is a path like "/sse/message?sessionId=..."
                    const endpointPath = event.data;
                    console.log(`📍 Endpoint path: ${endpointPath}`);
                    
                    // Extract session ID from the path
                    const match = endpointPath.match(/sessionId=([a-f0-9]+)/);
                    if (match) {
                        this.sessionId = match[1];
                        console.log(`🔑 Session ID: ${this.sessionId}`);
                        // Resolve once we have the session ID
                        if (connected) {
                            resolve();
                        }
                    }
                } catch (error) {
                    console.error('Failed to parse endpoint event:', error);
                }
            });
        });
    }

    handleMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(JSON.stringify(message.error)));
            } else {
                resolve(message.result);
            }
        } else {
            console.log('📨 Received message:', JSON.stringify(message, null, 2));
        }
    }

    async sendRequest(method, params = {}) {
        if (!this.sessionId) {
            throw new Error('No session ID available');
        }

        const id = this.currentId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        console.log(`📤 Sending: ${method}`);
        
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            
            // Send via HTTP POST to SSE message endpoint
            fetch(`${SSE_ENDPOINT}/message?sessionId=${this.sessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request)
            }).catch(reject);
            
            // Timeout after 10 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 10000);
        });
    }

    async initialize() {
        console.log('\n🔄 Initializing MCP session...');
        
        const result = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {
                roots: { listChanged: true },
                sampling: {}
            },
            clientInfo: {
                name: 'mcp-seatable-test-client',
                version: '1.0.0'
            }
        });

        console.log('✅ Initialized successfully');
        console.log('Server info:', result.serverInfo);
        console.log('Server capabilities:', result.capabilities);
    }

    async loadCapabilities() {
        console.log('\n🔍 Loading server capabilities...');

        try {
            // Get available tools
            const toolsResult = await this.sendRequest('tools/list');
            this.availableTools = toolsResult.tools || [];
            console.log(`📦 Found ${this.availableTools.length} tools`);
        } catch (error) {
            console.log('⚠️  Could not load tools:', error.message);
        }

        try {
            // Get available resources
            const resourcesResult = await this.sendRequest('resources/list');
            this.availableResources = resourcesResult.resources || [];
            console.log(`📋 Found ${this.availableResources.length} resources`);
        } catch (error) {
            console.log('⚠️  Could not load resources:', error.message);
        }
    }

    async interactiveLoop() {
        console.log('\n🎮 Interactive Mode - Available commands:');
        console.log('  tools    - List all available tools');
        console.log('  call     - Call a tool');
        console.log('  ping     - Quick ping test');
        console.log('  schema   - Get SeaTable schema');
        console.log('  tables   - List tables');
        console.log('  rows     - List rows from a table');
        console.log('  help     - Show this help');
        console.log('  quit     - Exit');
        console.log('');

        while (true) {
            const command = await this.question('> ');
            
            if (command === 'quit' || command === 'exit') {
                break;
            }
            
            await this.handleCommand(command.trim());
        }
    }

    async handleCommand(command) {
        try {
            switch (command) {
                case 'tools':
                    await this.listTools();
                    break;
                
                case 'call':
                    await this.callTool();
                    break;
                
                case 'ping':
                    await this.quickPing();
                    break;
                
                case 'schema':
                    await this.getSchema();
                    break;
                
                case 'tables':
                    await this.listTables();
                    break;
                
                case 'rows':
                    await this.listRows();
                    break;
                
                case 'help':
                    await this.showHelp();
                    break;
                
                default:
                    if (command) {
                        console.log('❓ Unknown command. Type "help" for available commands.');
                    }
            }
        } catch (error) {
            console.error('❌ Command error:', error.message);
        }
    }

    async listTools() {
        console.log('\n📦 Available Tools:');
        this.availableTools.forEach((tool, i) => {
            console.log(`  ${i + 1}. ${tool.name} - ${tool.description}`);
        });
    }

    async callTool() {
        if (this.availableTools.length === 0) {
            console.log('❌ No tools available');
            return;
        }

        console.log('\nSelect a tool to call:');
        this.availableTools.forEach((tool, i) => {
            console.log(`  ${i + 1}. ${tool.name} - ${tool.description}`);
        });

        const selection = await this.question('Tool number (or name): ');
        let tool;
        
        if (/^\d+$/.test(selection)) {
            const index = parseInt(selection) - 1;
            tool = this.availableTools[index];
        } else {
            tool = this.availableTools.find(t => t.name === selection);
        }

        if (!tool) {
            console.log('❌ Tool not found');
            return;
        }

        console.log(`\nCalling tool: ${tool.name}`);
        
        // For simplicity, call with empty arguments
        // In a real implementation, you'd prompt for parameters
        const result = await this.sendRequest('tools/call', {
            name: tool.name,
            arguments: {}
        });

        console.log('✅ Tool result:');
        console.log(JSON.stringify(result, null, 2));
    }

    async quickPing() {
        console.log('\n🏓 Pinging SeaTable...');
        
        const result = await this.sendRequest('tools/call', {
            name: 'ping_seatable',
            arguments: {}
        });

        console.log('✅ Ping result:');
        result.content.forEach(item => {
            if (item.type === 'text') {
                console.log(item.text);
            }
        });
    }

    async getSchema() {
        console.log('\n📋 Getting SeaTable schema...');
        
        const result = await this.sendRequest('tools/call', {
            name: 'get_schema',
            arguments: {}
        });

        console.log('✅ Schema result:');
        result.content.forEach(item => {
            if (item.type === 'text') {
                console.log(item.text);
            }
        });
    }

    async listTables() {
        console.log('\n📊 Listing tables...');
        
        const result = await this.sendRequest('tools/call', {
            name: 'list_tables',
            arguments: {}
        });

        console.log('✅ Tables result:');
        result.content.forEach(item => {
            if (item.type === 'text') {
                console.log(item.text);
            }
        });
    }

    async listRows() {
        const tableName = await this.question('Table name (or press enter for default): ');
        
        console.log(`\n📝 Listing rows from table: ${tableName || 'default table'}...`);
        
        const args = tableName ? { table_name: tableName } : {};
        
        const result = await this.sendRequest('tools/call', {
            name: 'list_rows',
            arguments: args
        });

        console.log('✅ Rows result:');
        result.content.forEach(item => {
            if (item.type === 'text') {
                console.log(item.text);
            }
        });
    }

    async showHelp() {
        console.log('\n📖 Available Commands:');
        console.log('  tools    - List all available MCP tools');
        console.log('  call     - Interactively call any tool');
        console.log('  ping     - Quick health check (ping_seatable)');
        console.log('  schema   - Get SeaTable base schema');
        console.log('  tables   - List all tables in the base');
        console.log('  rows     - List rows from a specific table');
        console.log('  help     - Show this help message');
        console.log('  quit     - Exit the test client');
        console.log('');
        console.log('💡 Tips:');
        console.log('  • Start with "ping" to verify SeaTable connectivity');
        console.log('  • Use "tables" to see available tables');
        console.log('  • Use "schema" to understand the data structure');
        console.log('  • Most commands work without parameters for quick testing');
    }

    question(prompt) {
        return new Promise((resolve) => {
            this.rl.question(prompt, resolve);
        });
    }

    cleanup() {
        if (this.eventSource) {
            this.eventSource.close();
        }
        if (this.rl) {
            this.rl.close();
        }
    }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const client = new MCPTestClient();
    client.start().catch(console.error);
}

export default MCPTestClient;