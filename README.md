# mcp-seatable

> **Beta** — This project is under active development. APIs and configuration may change between releases.

A Model Context Protocol (MCP) server for SeaTable that exposes database capabilities (schema introspection, CRUD, querying, linking, select option management) through 20 tools. You can run it:

- As a local CLI (stdio) MCP server for direct IDE integration
- As an HTTP server (Streamable HTTP transport) for network-accessible MCP
- As a Docker container for self-hosted deployment

## Quick Start

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@seatable/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://cloud.seatable.io",
        "SEATABLE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Cursor

Add to Cursor settings (JSON):

```json
{
  "mcp.servers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@seatable/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### VSCode with GitHub Copilot

Add to your VSCode `settings.json`:

```json
{
  "mcp.servers": {
    "seatable": {
      "command": "npx",
      "args": ["-y", "@seatable/mcp-seatable"],
      "env": {
        "SEATABLE_SERVER_URL": "https://your-seatable-server.com",
        "SEATABLE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### HTTP Server (Network Access)

Run a local HTTP server with Streamable HTTP transport:

```bash
PORT=3001 npx -y @seatable/mcp-seatable --sse

# Health check
curl http://localhost:3001/health

# MCP endpoint: POST/GET/DELETE http://localhost:3001/mcp
```

### Multi-Base (Selfhosted)

Serve multiple bases from a single process:

```bash
SEATABLE_SERVER_URL=https://your-seatable-server.com \
SEATABLE_BASES='[{"base_name":"CRM","api_token":"token_abc"},{"base_name":"Projects","api_token":"token_def"}]' \
npx -y @seatable/mcp-seatable
```

Each tool automatically gets a `base` parameter. Use `list_bases` to see available bases.

### Managed Mode (Multi-Tenant HTTP)

For hosting an MCP endpoint where each client authenticates with their own SeaTable API token:

```bash
SEATABLE_MODE=managed \
SEATABLE_SERVER_URL=https://your-seatable-server.com \
PORT=3000 npx -y @seatable/mcp-seatable --sse
```

Clients pass their API token via `Authorization: Bearer <token>` on session initialization. The server validates the token against SeaTable and applies rate limits (60 req/min per token, 120/min per IP, 5 concurrent connections per token).

### Docker

```bash
docker build -t seatable-mcp .
docker run -d --name seatable-mcp \
  -p 3000:3000 \
  -e SEATABLE_SERVER_URL=https://your-seatable-server.com \
  -e SEATABLE_API_TOKEN=your-api-token \
  seatable-mcp

# Health check
curl http://localhost:3000/health
```

## Environment Variables

Required:

- `SEATABLE_SERVER_URL` — Your SeaTable server URL

Authentication (one of these is required in selfhosted mode):

- `SEATABLE_API_TOKEN` — Single-base API token
- `SEATABLE_BASES` — Multi-base: JSON array (e.g. `'[{"base_name":"CRM","api_token":"..."}]'`)

Optional:

- `SEATABLE_MODE` — `selfhosted` (default) or `managed` (multi-tenant HTTP with per-client auth)
- `SEATABLE_MOCK=true` — Enable mock mode for offline testing

## MCP Tools

### Core Data Operations

- **`list_tables`** — Get all tables with metadata
- **`get_schema`** — Get complete database structure
- **`list_rows`** — Paginated row listing with sorting
- **`find_rows`** — Client-side filtering with DSL
- **`search_rows`** — Search via SQL WHERE clauses
- **`get_row`** — Retrieve specific row by ID
- **`add_row`** — Add single new row
- **`append_rows`** — Batch insert rows
- **`update_rows`** — Batch update rows
- **`upsert_rows`** — Insert or update rows by key columns
- **`delete_rows`** — Remove rows by ID
- **`link_rows`** — Create relationships between rows
- **`unlink_rows`** — Remove relationships between rows
- **`query_sql`** — Execute SQL queries with parameterized inputs

### Schema Management

- **`manage_tables`** — Create, rename, and delete tables
- **`manage_columns`** — Add, modify, and delete columns
- **`bulk_set_select_options`** — Manage dropdown/multi-select options

### Utilities

- **`list_bases`** — List available bases (multi-base mode only)
- **`ping_seatable`** — Health check with latency monitoring
- **`attach_file_to_row`** — File attachment (stub)

## Tool Examples

```json
// List all tables
{ "tool": "list_tables", "args": {} }

// Get rows with pagination
{ "tool": "list_rows", "args": { "table": "Tasks", "page_size": 10, "order_by": "_ctime", "direction": "desc" } }

// Add rows
{ "tool": "append_rows", "args": { "table": "Tasks", "rows": [{ "Title": "New Task", "Status": "Todo" }] } }

// SQL query
{ "tool": "query_sql", "args": { "sql": "SELECT Status, COUNT(*) as count FROM Tasks GROUP BY Status" } }
```

## Programmatic Usage

```typescript
import { createMcpServer } from '@seatable/mcp-seatable'

const server = await createMcpServer({
  serverUrl: 'https://your-seatable-server.com',
  apiToken: 'your-api-token',
})
```

## Mock Mode

```bash
SEATABLE_MOCK=true npm run dev
```

In-memory tables and rows for demos and tests without a live SeaTable instance.

## Development

### Prerequisites

- Node.js >= 18

### Setup

```bash
git clone https://github.com/seatable/seatable-mcp
cd seatable-mcp
npm install
cp .env.example .env   # Configure your SeaTable settings
npm run dev             # Start in watch mode
```

### Scripts

- `npm run dev` — Start server in watch mode (tsx)
- `npm run build` — Compile TypeScript
- `npm run start` — Run compiled server
- `npm test` — Run tests (vitest)
- `npm run lint` — Lint code
- `npm run typecheck` — TypeScript type check

### Testing Tools

```bash
node scripts/mcp-call.cjs ping_seatable '{}'
node scripts/mcp-call.cjs list_tables '{}'
node scripts/mcp-call.cjs list_rows '{"table": "Tasks", "page_size": 5}'
```

## Troubleshooting

| Issue | Solution |
|---|---|
| `Invalid API token` | Check `SEATABLE_API_TOKEN` |
| `Base not found` | Check API token permissions |
| `Connection timeout` | Check `SEATABLE_SERVER_URL` and network access |
| `Permission denied` | Ensure API token has required base permissions |

## License

MIT
