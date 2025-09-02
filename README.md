# mcp-seatable

A comprehensive MCP (Model Context Protocol) server that provides full SeaTable database access through 11 powerful tools.

## Quick Start

1. Configure your MCP client (Claude, Cursor, or VSCode) to use:

```
command: npx
args: ["-y", "@aspereo/mcp-seatable"]
```

2. Set your environment variables:
   - `SEATABLE_SERVER_URL`: Your SeaTable server URL
   - `SEATABLE_API_TOKEN`: Your SeaTable API token
   - `SEATABLE_BASE_UUID`: Your SeaTable base UUID

3. Restart your MCP client and start using SeaTable tools!

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

## MCP Tools

Our server provides 11 comprehensive tools for complete SeaTable database management:

### Core Data Operations

- **`list_tables`** - Get all tables with metadata
- **`list_rows`** - Paginated row listing with filtering and sorting
- **`get_row`** - Retrieve specific row by ID
- **`append_rows`** - Add new rows (supports bulk operations)
- **`update_rows`** - Modify existing rows (supports bulk operations)
- **`delete_rows`** - Remove rows by ID (supports bulk operations)

### Advanced Querying

- **`find_rows`** - Client-side filtering with powerful DSL (supports and/or/not, eq, ne, in, gt/gte/lt/lte, contains, starts_with, ends_with, is_null)
- **`query_sql`** - Execute raw SQL queries (SELECT, INSERT, UPDATE, DELETE) with parameterization
  - Supports complex JOINs, aggregations, and advanced SQL features
  - Safe parameterized queries prevent SQL injection
  - Returns rich metadata including column schemas and types
  - Maximum 10,000 rows per query (default 100 if no LIMIT specified)

### Schema Management

- **`get_schema`** - Get complete database structure and metadata
- **`manage_tables`** - Create, rename, and delete tables

### System Operations

- **`ping_seatable`** - Health check with connection status and latency monitoring

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

## Testing Tools

You can test individual tools using the included test script:

```bash
# Test basic operations
node scripts/mcp-call.cjs list_tables '{}'
node scripts/mcp-call.cjs list_rows '{"table": "Tasks", "page_size": 5}'
node scripts/mcp-call.cjs ping_seatable '{}'

# Test advanced queries
node scripts/mcp-call.cjs find_rows '{"table": "Tasks", "filter": {"Status": "Todo"}}'
node scripts/mcp-call.cjs query_sql '{"sql": "SELECT * FROM Tasks LIMIT 3"}'

# Test schema operations
node scripts/mcp-call.cjs get_schema '{}'
node scripts/mcp-call.cjs manage_tables '{"operation": "create", "table_name": "TestTable"}'
```

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
