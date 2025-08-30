# mcp-seatable

A comprehensive MCP (Model Context Protocol) server that provides full SeaTable database access through 11 powerful tools.

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

## Prerequisites

- Node.js >= 18
- npm
- A SeaTable server URL and API token with access to your base

## Setup

1. Clone/open this repo.
2. Copy `.env.example` to `.env` and set values.
3. Install dependencies:
   ```bash
   npm install
   ```

## Configuration (.env)

See `.env.example` for required variables:

- `SEATABLE_SERVER_URL`
- `SEATABLE_API_TOKEN`
- `SEATABLE_BASE_UUID`
- `SEATABLE_TABLE_NAME` (optional default table)
- `SEATABLE_MOCK` (optional; set to `true` or `1` to use in-memory mock client for local testing)
- `SEATABLE_ACCESS_TOKEN_EXP` (optional; expiry passed to app-access-token endpoint, e.g., `3d` or `1h`; default `1h`)
- `SEATABLE_TOKEN_ENDPOINT_PATH` (optional; override token exchange path. Use either the full app-access-token path like `/api/v2.1/dtable/app-access-token/` or a base like `/api/v2.1` or `/dtable-server/api/v1`)

## Scripts

- `npm run dev` – Start server in watch mode (tsx)
- `npm run build` – Compile TypeScript
- `npm start` – Run compiled server
- `npm run test` – Run tests (vitest)
- `npm run test:watch` – Watch tests
- `npm run lint` – Lint
- `npm run lint:fix` – Lint and fix
- `npm run format` – Prettier check
- `npm run typecheck` – TypeScript type check

## Running in Development

```bash
npm run dev
```

The server will validate your environment variables on startup and log a clear error if something is missing or invalid.

## Running in Production

```bash
npm run build
npm start
```

## CLI

- Dev: `tsx src/index.ts`
- Built: `node dist/index.js`
- NPM bin: `seatable-mcp` (after build)

## Mock Mode

Enable a fast, offline mock:

```bash
SEATABLE_MOCK=true npm run dev
```

The mock implements in-memory tables and rows and returns synthetic metadata. Useful for demos and tests without a live SeaTable.

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

## License

MIT
