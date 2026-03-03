# mcp-seatable

> **Beta** — This project is under active development. APIs and configuration may change between releases.

The official Model Context Protocol (MCP) server for [SeaTable](https://seatable.io), built and maintained by SeaTable GmbH. It lets AI agents interact with data in your bases — reading, writing, searching, linking, and querying rows through 19 focused tools. The server intentionally focuses on data operations, not schema management (creating/deleting tables or columns), keeping the tool set lean and safe for autonomous agent use. You can run it:

- As a local CLI (stdio) MCP server for direct IDE integration
- As an HTTP server (Streamable HTTP transport) for network-accessible MCP
- As a Docker container for self-hosted deployment

## Quick Start

### SeaTable Cloud (hosted MCP server)

If you use [SeaTable Cloud](https://cloud.seatable.io), there is a hosted MCP server ready to use — no installation required. Just point your MCP client to:

```
https://mcp.seatable.com/mcp
```

Pass your SeaTable API token as a Bearer token in the `Authorization` header. Your MCP client handles this automatically when configured as a Streamable HTTP server.

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

## Deployment Options

The Quick Start examples above run a local stdio process managed by your IDE. For more advanced setups, you can deploy the server as a standalone HTTP service.

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
docker run -d --name seatable-mcp \
  -p 3000:3000 \
  -e SEATABLE_SERVER_URL=https://your-seatable-server.com \
  -e SEATABLE_API_TOKEN=your-api-token \
  seatable/seatable-mcp:latest

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

### Schema Introspection

- **`list_tables`** — Get all tables with metadata
- **`get_schema`** — Get complete database structure
- **`list_bases`** — List available bases (multi-base mode only)
- **`list_collaborators`** — List users with access to the base (for collaborator columns)

### Reading Data

- **`list_rows`** — Paginated row listing with sorting
- **`get_row`** — Retrieve specific row by ID
- **`find_rows`** — Client-side filtering with DSL
- **`search_rows`** — Search via SQL WHERE clauses
- **`query_sql`** — Execute SQL queries with parameterized inputs

### Writing Data

- **`add_row`** — Add single new row
- **`append_rows`** — Batch insert rows
- **`update_rows`** — Batch update rows
- **`upsert_rows`** — Insert or update rows by key columns
- **`delete_rows`** — Remove rows by ID
- **`upload_file`** — Upload a file or image to a row (base64-encoded)

### Linking

- **`link_rows`** — Create relationships between rows
- **`unlink_rows`** — Remove relationships between rows

### Utilities

- **`add_select_options`** — Add new options to single-select or multi-select columns
- **`ping_seatable`** — Health check with latency monitoring

## Supported Column Types

SeaTable bases can contain many different column types. The following table shows which types can be written via the API and what format to use.

| Column Type | Writable | Value Format |
|---|---|---|
| Text | Yes | `"string"` |
| Long Text | Yes | `"Markdown string"` |
| Number (incl. percent, currency) | Yes | `123.45` |
| Checkbox | Yes | `true` / `false` |
| Date | Yes | `"YYYY-MM-DD"` or `"YYYY-MM-DD HH:mm"` |
| Duration | Yes | `"h:mm"` or `"h:mm:ss"` |
| Single Select | Yes | `"option name"` |
| Multiple Select | Yes | `["option a", "option b"]` |
| Email | Yes | `"user@example.com"` |
| URL | Yes | `"https://..."` |
| Rating | Yes | `4` (integer) |
| Geolocation | Yes | `{"lat": 52.52, "lng": 13.40}` |
| Collaborator | Yes | `["0b995819003140ed8e9efe05e817b000@auth.local"]` — use `list_collaborators` to get user IDs |
| Link | Yes | Use `link_rows` / `unlink_rows` tools |
| Image / File | Yes | Use `upload_file` tool with base64-encoded data |
| Formula / Link Formula | No | Read-only, computed by SeaTable |
| Creator / Created Time / Modified Time | No | Read-only, set automatically |
| Auto Number | No | Read-only, set automatically |
| Button / Digital Signature | No | Not accessible via API |

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
| `You don't have permission to perform this operation on this base.` | API token is read-only or row limit exceeded |
| `Asset quota exceeded.` | Storage quota reached — delete files or upgrade plan |
| `too many requests` | Rate-limited by SeaTable — requests are automatically retried with backoff (3 attempts) |

## License

MIT
