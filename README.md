# mcp-seatable

A comprehensive MCP (Model Context Protocol) server that provides full SeaTable dat```javascript
// Connect to your deployed Worker instance
const mcpClient = new MCPClient('https://your-worker-name.your-account.workers.dev/mcp');se access through 18+ powerful tools. Deploy anywhere: traditional CLI, local SSE server, or scalable Cloudflare Workers.

## 🚀 Deployment Options

### Option 1: Cloudflare Workers (Recommended for Production)

Deploy your own scalable MCP server on Cloudflare Workers with session persistence and dual transport support:

```bash
# Clone and deploy
git clone https://github.com/brianmoney/mcp-seatable
cd mcp-seatable
npm install
npx wrangler deploy

# After deployment, use your worker URL
npx mcp-remote https://your-worker-name.your-account.workers.dev/sse
```

**Features:**

- ✅ Persistent sessions with Durable Objects
- ✅ Both SSE (`/sse`) and Streamable HTTP (`/mcp`) transports
- ✅ Automatic scaling and global distribution
- ✅ Zero cold start issues
- ✅ Built-in health monitoring

### Option 2: Local SSE Server (Best for Development)

Run a local HTTP server with SSE transport for network-accessible MCP:

```bash
# Install and run locally
npm install -g @aspereo/mcp-seatable
PORT=3001 MCP_SEATABLE_TRANSPORT=sse mcp-seatable

# Or with npx
PORT=3001 npx -y @aspereo/mcp-seatable --sse

# Test endpoints
curl http://localhost:3001/health
curl -H "Accept: text/event-stream" http://localhost:3001/mcp
```

**Features:**

- ✅ Network accessible over HTTP
- ✅ Real-time SSE communication
- ✅ Perfect for development and testing
- ✅ MCP Inspector compatible

### Option 3: Traditional CLI (MCP Clients)

Direct integration with MCP clients like Claude Desktop, Cursor, and VS Code:

```json
{
  "mcpServers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

## ⚡ Quick Start Examples

### For Claude Desktop (Traditional CLI)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable@1.0.2"],
      "env": {
        "SEATABLE_SERVER_URL": "https://cloud.seatable.io",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

### For Web Applications (Cloudflare Worker)

```javascript
// Connect to the live Worker instance
const mcpClient = new MCPClient('https://mcp-seatable.brian-money.workers.dev/mcp')
await mcpClient.initialize()
const tables = await mcpClient.callTool('list_tables', {})
```

### For Development (Local SSE Server)

```bash
# Terminal 1: Start server
PORT=3001 npx -y @aspereo/mcp-seatable --sse

# Terminal 2: Test with MCP Inspector
npx @modelcontextprotocol/inspector@latest
# Connect to: http://localhost:3001/mcp
```

### Required Environment Variables

All deployment methods need these environment variables:

- `SEATABLE_SERVER_URL` - Your SeaTable server (e.g., `https://cloud.seatable.io`)
- `SEATABLE_API_TOKEN` - Your SeaTable API token
- `SEATABLE_BASE_UUID` - Your SeaTable base UUID

Optional:

- `SEATABLE_TABLE_NAME` - Default table name
- `SEATABLE_MOCK=true` - Enable mock mode for testing

## 🔧 Troubleshooting

### Common Issues

| Issue                    | Solution                                       |
| ------------------------ | ---------------------------------------------- |
| `command not found: npx` | Install Node.js 18+                            |
| `Invalid API token`      | Check `SEATABLE_API_TOKEN` in environment      |
| `Base not found`         | Verify `SEATABLE_BASE_UUID` is correct         |
| `Connection timeout`     | Check `SEATABLE_SERVER_URL` and network access |
| `Permission denied`      | Ensure API token has required base permissions |

### Testing Your Setup

```bash
# Test basic connectivity
node scripts/test-client.mjs

# Test specific tool
node scripts/mcp-call.cjs list_tables

# Test with mock data
SEATABLE_MOCK=true node scripts/test-client.mjs
```

### Debug Mode

Enable verbose logging:

```bash
# For CLI mode
DEBUG=mcp-seatable:* npx -y @aspereo/mcp-seatable

# For SSE mode
DEBUG=mcp-seatable:* PORT=3001 npx -y @aspereo/mcp-seatable --sse
```

## What is this?

This project implements a production-ready MCP server using the `@modelcontextprotocol/sdk` that integrates with SeaTable's REST API. It provides a complete toolkit for database operations including CRUD operations, advanced querying, schema management, and raw SQL execution. All tools use Zod validation and return structured JSON responses.

## Key Features

- **Complete CRUD Operations**: Create, read, update, delete rows and tables
- **Advanced Querying**: Client-side filtering with DSL and raw SQL support
- **Schema Management**: Create, modify, and delete tables and columns
- **Safe SQL Execution**: Parameterized queries with injection protection
- **Real-time Health Monitoring**: Connection status and latency tracking
- **Production Ready**: Comprehensive error handling and logging
- **Mock Mode**: In-memory testing without live SeaTable connection

## Architecture

Built with a modern, proven architecture pattern:

- **Server + setRequestHandler pattern**: Reliable MCP implementation following best practices from airtable-mcp-server
- **Centralized tool management**: All tools managed in a single `handleListTools`/`handleCallTool` pattern
- **Comprehensive validation**: Zod schemas for all inputs with detailed error messages
- **Type-safe client**: Full TypeScript support with proper error handling
- **Flexible deployment**: Supports both API Gateway and direct SeaTable API endpoints

## Installation

No installation required! This MCP server can be used directly with `npx -y @aspereo/mcp-seatable`.

Alternatively, you can install globally:

```bash
npm install -g @aspereo/mcp-seatable
```

## Usage

### Claude Desktop

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

### Cursor

Add to your Cursor settings by opening the command palette (`Cmd/Ctrl+Shift+P`) and selecting "Preferences: Open Settings (JSON)":

```json
{
  "mcp.servers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

### VSCode with GitHub Copilot

Install the MCP extension for VSCode, then add to your VSCode settings.json:

```json
{
  "mcp.servers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

### Environment Variables

All configuration is done through environment variables:

- `SEATABLE_SERVER_URL` - Your SeaTable server URL
- `SEATABLE_API_TOKEN` - Your SeaTable API token
- `SEATABLE_BASE_UUID` - Your SeaTable base UUID
- `SEATABLE_TABLE_NAME` - Optional default table name
- `SEATABLE_MOCK` - Set to `true` for offline testing with mock data
- `SEATABLE_ACCESS_TOKEN_EXP` - Token expiry (default: `1h`)
- `SEATABLE_TOKEN_ENDPOINT_PATH` - Custom token endpoint path if needed

## Programmatic Usage

You can also use mcp-seatable as a library in your Node.js applications:

```bash
npm install @aspereo/mcp-seatable
```

```typescript
import { createMcpServer } from '@aspereo/mcp-seatable'

// Create and start the MCP server
const server = await createMcpServer({
  serverUrl: 'https://your-seatable-server.com',
  apiToken: 'your-api-token',
  baseUuid: 'your-base-uuid',
})

// The server will handle MCP protocol communications
```

## Mock Mode

Enable a fast, offline mock:

```bash
SEATABLE_MOCK=true npm run dev
```

The mock implements in-memory tables and rows and returns synthetic metadata. Useful for demos and tests without a live SeaTable.

## 🏗️ Architecture & Transport Details

### Deployment Architecture Comparison

| Feature                | **Cloudflare Worker**              | **Local SSE Server**        | **Traditional CLI**           |
| ---------------------- | ---------------------------------- | --------------------------- | ----------------------------- |
| **Scalability**        | ✅ Auto-scaling, global            | 📍 Single instance          | 📍 Per-client process         |
| **Session Management** | ✅ Durable Objects (persistent)    | ⚠️ In-memory (may timeout)  | ✅ Direct stdio               |
| **Network Access**     | ✅ HTTPS endpoints                 | ✅ HTTP endpoints           | ❌ Local only                 |
| **Cold Starts**        | ✅ Eliminated with Durable Objects | ✅ Always warm              | ❌ Process startup            |
| **Transport Support**  | ✅ Both SSE + Streamable HTTP      | ✅ SSE only                 | ✅ stdio only                 |
| **Use Cases**          | Production, multi-user, web apps   | Development, testing, demos | IDE integration, personal use |

### Transport Protocol Details

#### Cloudflare Worker Endpoints

**SSE Transport** (Recommended for compatibility):

```bash
# Connection flow
GET /sse                              # Establish SSE connection
POST /sse/message?sessionId=xxx      # Send MCP messages
```

**Streamable HTTP Transport** (Modern, single-endpoint):

```bash
# All communication through one endpoint
POST /mcp                            # Initialize + all subsequent messages
# Session managed via Mcp-Session-Id headers
```

#### Local SSE Server Endpoints

```bash
GET /mcp                             # SSE connection (different path!)
POST /messages?sessionId=xxx         # Message handling
GET /health                          # Health probe
```

#### Traditional CLI (stdio)

```bash
# Direct stdin/stdout communication
node dist/index.js                   # Starts MCP server on stdio
./bin/seatable-mcp.cjs              # Binary wrapper
```

### Development & Deployment Commands

```bash
# Local development
npm run dev                          # TypeScript watch mode
PORT=3001 npm start -- --sse        # Local SSE server
npm run cf:dev                       # Local Worker with Wrangler

# Deployment
npx wrangler deploy                  # Deploy to Cloudflare Workers
npm run cf:secrets:sync             # Sync environment to Worker

# Testing
./scripts/test-worker.sh             # Test deployed Worker
node scripts/test-client.mjs        # Interactive testing
```

## Version Pinning (recommended)

To avoid unexpected changes when new versions are released, pin the package version in your MCP client configuration. Replace `1.0.2` with the version you want to lock to.

### Claude Desktop

```json
{
  "mcpServers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable@1.0.2"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

### Cursor

```json
{
  "mcp.servers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable@1.0.2"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

### VSCode with GitHub Copilot

```json
{
  "mcp.servers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@aspereo/mcp-seatable@1.0.2"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token",
        "SEATABLE_BASE_UUID": "your-base-uuid"
      }
    }
  }
}
```

## 🛠️ MCP Tools

Our server provides 18+ comprehensive tools for complete SeaTable database management:

### Core Data Operations

- **`ping_seatable`** - Health check with connection status and latency monitoring
- **`list_tables`** - Get all tables with metadata
- **`get_schema`** - Get complete database structure and metadata
- **`list_rows`** - Paginated row listing with filtering and sorting
- **`find_rows`** - Advanced client-side filtering with powerful DSL
- **`search_rows`** - Full-text search across table data
- **`get_row`** - Retrieve specific row by ID
- **`add_row`** - Add single new row
- **`append_rows`** - Add multiple rows (bulk operations)
- **`update_row`** - Update single row
- **`upsert_rows`** - Insert or update rows (bulk operations)
- **`delete_row`** - Remove single row by ID
- **`link_rows`** - Create relationships between rows
- **`unlink_rows`** - Remove relationships between rows

### Table & Schema Management

- **`manage_tables`** - Create, rename, and delete tables
- **`manage_columns`** - Add, modify, and delete table columns
- **`bulk_set_select_options`** - Bulk manage dropdown/multi-select options

### File Operations

- **`attach_file_to_row`** - Upload and attach files to table rows

All tools support comprehensive input validation with Zod schemas, structured JSON responses, and detailed error handling.

All tools include comprehensive input validation with Zod schemas and return structured JSON responses.

## Tool Examples

### Basic Operations

```json
// List all tables
{ "tool": "list_tables", "args": {} }

// Get rows with pagination and filtering
{ "tool": "list_rows", "args": { "table": "Tasks", "page_size": 10, "order_by": "_ctime", "direction": "desc" } }

// Add new rows
{ "tool": "append_rows", "args": { "table": "Tasks", "rows": [{ "Title": "New Task", "Status": "Todo" }] } }

// Update existing rows
{ "tool": "update_rows", "args": { "table": "Tasks", "rows": [{ "row_id": "abc123", "row": { "Status": "Done" } }] } }
```

### Advanced Querying

```json
// Find rows with complex filters
{
  "tool": "find_rows",
  "args": {
    "table": "Tasks",
    "filter": {
      "and": [
        { "Status": { "eq": "Todo" } },
        { "Priority": { "in": ["High", "Medium"] } },
        { "Title": { "contains": "urgent" } }
      ]
    },
    "limit": 20
  }
}

// Execute raw SQL queries
{ "tool": "query_sql", "args": { "sql": "SELECT Status, COUNT(*) as count FROM Tasks WHERE Created > ? GROUP BY Status", "parameters": ["2025-01-01"] } }
```

### Schema Management

```json
// Create new table
{ "tool": "manage_tables", "args": { "operation": "create", "table_name": "Projects" } }

// Get complete schema
{ "tool": "get_schema", "args": {} }

// Health check
{ "tool": "ping_seatable", "args": {} }
```

## 🧪 Testing & Development

### Testing Individual Tools

Test specific MCP tools using the included test script:

```bash
# Test basic operations
node scripts/mcp-call.cjs ping_seatable '{}'
node scripts/mcp-call.cjs list_tables '{}'
node scripts/mcp-call.cjs list_rows '{"table": "Tasks", "page_size": 5}'

# Test data operations
node scripts/mcp-call.cjs add_row '{"table": "Tasks", "row": {"Title": "Test Task"}}'
node scripts/mcp-call.cjs find_rows '{"table": "Tasks", "filter": {"Status": {"eq": "Todo"}}}'
node scripts/mcp-call.cjs search_rows '{"table": "Tasks", "query": "urgent"}'

# Test schema operations
node scripts/mcp-call.cjs get_schema '{}'
node scripts/mcp-call.cjs manage_tables '{"operation": "create", "table_name": "TestTable"}'
```

### Cloudflare Worker Testing

Comprehensive test suite for Worker deployment:

```bash
# Run full automated test suite
./scripts/test-worker.sh

# Interactive testing with step-by-step validation
./scripts/test-worker.sh --interactive

# Interactive MCP client for live Worker testing
node scripts/test-client.mjs
```

### Development Environment Setup

Set up complete development environment with VS Code configs and MCP Inspector:

```bash
# Install MCP Inspector, mcp-remote, and create dev configs
./scripts/setup-test-env.sh
```

### Available Scripts

- `scripts/mcp-call.cjs` - Test individual MCP tools directly
- `scripts/test-worker.sh` - Comprehensive Worker testing suite
- `scripts/test-client.mjs` - Interactive MCP client for live testing
- `scripts/setup-test-env.sh` - Complete development environment setup
- `scripts/sync-wrangler-secrets.ts` - Sync environment variables to Worker secrets
- `scripts/probe-token.ts` - SeaTable API token validation utility

## Troubleshooting

### Connection Issues

- Ensure `.env` values are correct and the API token has access to the base
- Check network connectivity to `SEATABLE_SERVER_URL`
- Use `ping_seatable` tool to verify connection and measure latency
- If token exchange fails (404 on endpoints), set `SEATABLE_TOKEN_ENDPOINT_PATH` to your deployment's path

### Query Issues

- For SQL errors, check the returned error message in the tool response
- Use parameterized queries (`?` placeholders) to avoid SQL injection
- Remember that SQL queries have a 10,000 row limit and default to 100 rows
- Column names in SQL must match exactly (case-sensitive)

### Development

- Use `SEATABLE_MOCK=true` for offline development and testing
- Check logs for detailed request information including `op`, `method`, `url`, `status`, `request_id`, and `duration_ms`
- Run individual tool tests with `node scripts/mcp-call.cjs <tool_name> '<args_json>'`

## Development

### Prerequisites

- Node.js >= 18
- npm

### Setup for Development

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and configure your SeaTable settings
4. Run in development mode:
   ```bash
   npm run dev
   ```

### Development Scripts

- `npm run dev` – Start server in watch mode (tsx)
- `npm run build` – Compile TypeScript
- `npm run start` – Run compiled server
- `npm run test` – Run tests (vitest)
- `npm run test:watch` – Watch tests
- `npm run lint` – Lint code
- `npm run lint:fix` – Lint and fix issues
- `npm run format` – Check formatting
- `npm run typecheck` – TypeScript type check

### Running from Source

```bash
# Development
npm run dev

# Production build
npm run build
npm run start

# Direct execution
npx tsx src/index.ts
```

## License

MIT
