# SeaTable MCP

The official Model Context Protocol (MCP) server for [SeaTable](https://seatable.com), built and maintained by SeaTable GmbH. It lets AI agents interact with data in your bases — reading, writing, searching, linking, and querying rows through a focused set of tools. The server intentionally focuses on data operations, not schema management (creating/deleting tables or columns), keeping the tool set lean and safe for autonomous agent use.

## Quick Start

The fastest way to get started depends on your setup:

- **SeaTable Cloud** — Use the hosted MCP server at `mcp.seatable.com`, no installation needed
- **Self-hosted SeaTable** — Run the MCP server locally via `npx` in your IDE

### SeaTable Cloud (hosted MCP server)

If you use [SeaTable Cloud](https://cloud.seatable.io), there is a hosted MCP server ready to use — no installation required. Configure your MCP client with the Streamable HTTP endpoint:

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "seatable": {
      "type": "streamable-http",
      "url": "https://mcp.seatable.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-token"
      }
    }
  }
}
```

**Cursor / VSCode** — add to your MCP settings (JSON):

```json
{
  "mcp.servers": {
    "seatable": {
      "type": "streamable-http",
      "url": "https://mcp.seatable.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-token"
      }
    }
  }
}
```

**ChatGPT and other OAuth-compatible clients** — use the built-in OAuth flow. In ChatGPT's developer mode, configure:

- **Server URL:** `https://mcp.seatable.com/mcp`
- **Auth type:** OAuth
- **Authorization URL:** `https://mcp.seatable.com/authorize`
- **Token URL:** `https://mcp.seatable.com/token`

You will be prompted to enter your SeaTable API token during the authorization step.

### Self-hosted SeaTable

For self-hosted SeaTable instances, run the MCP server locally via `npx`. Your IDE starts and manages the process automatically.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
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

**Cursor / VSCode** — add to your MCP settings (JSON):

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

If you need to run your own server instance — for example on your own infrastructure, with multi-base support, or in multi-tenant mode — use one of the options below.

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
SEATABLE_TOKEN_SECRET=$(openssl rand -hex 32) \
PORT=3000 npx -y @seatable/mcp-seatable --sse
```

`SEATABLE_TOKEN_SECRET` is **required** in managed mode. It seals the OAuth tokens the server issues, so the underlying SeaTable API token never has to be handed to a client. Keep it stable across restarts — changing it invalidates every issued access and refresh token and forces all clients to re-authorize.

Clients pass their credential via `Authorization: Bearer <token>` — on session initialization **and on every subsequent request**, including `GET` and `DELETE`. The `mcp-session-id` header is a routing value only; it is never accepted on its own. Each request is re-validated and must resolve to the same identity that created the session, otherwise the server answers `401` (missing/invalid credential) or `403` (valid credential, wrong session). Rate limits apply as before (60 req/min per token, 120/min per IP, 20 concurrent connections per token).

**OAuth support:** Managed mode also exposes OAuth 2.0 endpoints (`/authorize` and `/token`), enabling OAuth-compatible clients like ChatGPT to connect — no external OAuth provider required. During the flow the user enters their SeaTable API token; the server seals it into its own short-lived access token (1 h) and a rotating refresh token (14 d). The raw SeaTable API token is never returned to a client.

Clients must register at `/register` first: the returned `client_id` carries the client's name and its `redirect_uris`, and the server accepts a callback only if it is one the client registered (loopback callbacks may vary the port, per RFC 8252). PKCE with `S256` is mandatory, and every authorization code is bound to the client, the exact callback and the challenge.

**Where a code may be delivered.** With open dynamic registration, "registered client" is not a trust statement — anyone can register. What matters is whether the code leaves the user's machine:

| Callback | Behaviour |
|---|---|
| Loopback (`http://127.0.0.1:…`, `localhost`, `[::1]`) | allowed, no extra step — the code stays on the user's machine |
| Private-use scheme (`cursor://`, `vscode://`, `com.example.app:/…`) | allowed, no extra step — handed to a local application |
| `https` on a host in `SEATABLE_OAUTH_TRUSTED_REDIRECT_HOSTS` | allowed, no extra step |
| `https` on any other host | allowed **after** the user confirms the destination on a separate page |
| Remote plaintext `http`, `javascript:`, `data:`, `file:`, `blob:` | rejected |

The confirmation cannot be skipped from the entry link: it is read from the form body only, and a POST auto-submitted by a foreign page is refused via `Sec-Fetch-Site`. The trusted-host list therefore removes friction — it is not a gate, and leaving it unset breaks nothing.

The consent screen leads with the destination the authorization will be sent to. The application's name is shown as **self-reported**, because with open registration it is chosen by whoever registered the client and cannot be verified.

The OAuth endpoints are rate limited per IP (30/min overall, 10/min for token submissions), so `/authorize` cannot be used as an unthrottled oracle for testing SeaTable API tokens.

OAuth endpoints follow the MCP specification (RFC 8414 metadata discovery, PKCE, dynamic client registration):

| Endpoint | Path |
|---|---|
| Metadata Discovery | `/.well-known/oauth-authorization-server` |
| Authorization | `/authorize` |
| Token | `/token` |
| Client Registration | `/register` |

Client ID and secret are not validated — dynamic client registration generates one automatically.

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

#### Container hardening

The image is built so that code running inside the server process — for example through a vulnerable dependency — can't change the filesystem, start other programs or escalate privileges:

- **Non-root:** the server runs as `node` (uid 1000). The code in `/app` is owned by root and read-only for that user.
- **Node permission model:** the default `CMD` starts `node --permission --allow-fs-read=/app`. The process may read its own code and nothing else; writing files, child processes (no shell), worker threads and native addons are denied. Outbound network access is not affected. The server needs none of the denied operations, including `download_file`, which extracts PDF text in memory.
- **No tools for an attacker:** npm, npx, yarn, corepack and apk are removed, and so are busybox `wget`, `nc` and `su`. The health check uses `node`. There are no setuid binaries.
- **Pinned base image:** `node:22.23.4-alpine3.24` (build argument `NODE_IMAGE`), with `apk upgrade` at build time.

At runtime, add the restrictions the image can't set itself. `docker-compose.yml` contains all of them:

```bash
docker run -d --name seatable-mcp \
  -p 3000:3000 \
  --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 512m \
  -e SEATABLE_SERVER_URL=https://your-seatable-server.com \
  -e SEATABLE_API_TOKEN=your-api-token \
  seatable/seatable-mcp:latest
```

> If you override the command (e.g. `docker run … seatable/seatable-mcp node dist/index.js --sse`), keep `--permission --allow-fs-read=/app`, otherwise the permission model is off.

### OpenAI Secure MCP Tunnel

To use the server from ChatGPT without exposing it to the internet, run it next to OpenAI's `tunnel-client`. Setup and limitations: [docs/openai-tunnel.md](docs/openai-tunnel.md).

### Security Model

The security characteristics differ significantly between transport modes:

| | stdio (default) | Selfhosted HTTP | Managed HTTP |
|---|---|---|---|
| **Network exposure** | None (local process) | TCP port, **no auth** | TCP port, Bearer auth |
| **Authentication** | Not needed (local) | None | Bearer token or OAuth 2.0, validated against SeaTable |
| **Rate limiting** | None | None | Per-token, per-IP, global |
| **Connection limits** | N/A | None | 20 concurrent sessions per token |
| **Data scope** | All configured bases | All configured bases | One base per client token |

> **⚠️ Warning:** Selfhosted HTTP mode (`--sse` / `--http`) has **no authentication**. Anyone who can reach the port gets full access to all configured bases, including write and delete operations. Only run it in trusted networks (localhost, Docker-internal) or behind a reverse proxy that handles authentication. For untrusted networks, use **managed mode** instead.

### Rate Limiting

SeaTable's own API gateway enforces rate limits **per base** (default: 500 requests/minute per `base_uuid`) and **per organization** (monthly quota). These limits apply regardless of whether requests come from the MCP server, the web UI, or direct API calls. The MCP server does not duplicate these limits — instead, it retries automatically with exponential backoff when SeaTable returns `429 Too Many Requests`.

In **managed mode**, the MCP server adds its own rate limits to protect the server process itself (not the SeaTable backend): 60 req/min per token, 120/min per IP, 30/min for new session creation, and 20 concurrent connections per token.

### Input Validation

All tool inputs are validated with Zod schemas before execution. Write tools (`add_row`, `append_rows`, `update_rows`, `upsert_rows`) additionally validate row data against the table schema — unknown columns are rejected, and read-only columns (formula, auto-number, creator, etc.) are stripped with a note in the response.

Tool schemas are published with `additionalProperties: true` to remain compatible with MCP clients that may attach internal fields (e.g. `_meta`). Unexpected fields are ignored by the server — they do not cause errors but are not processed either. This is a deliberate trade-off: stricter validation would improve error messages for typos but risk breaking compatibility with MCP clients.

### Row Responses

Row responses include all columns and SeaTable system fields (`_id`, `_mtime`, `_ctime`, `_creator`, `_last_modifier`). System fields are not filtered — `_id` is required for updates and deletes, timestamps are useful for sorting and freshness checks, and creator/modifier fields can be resolved to display names via `list_collaborators`.

### Caching

The server caches base metadata (table/column definitions) for 60 seconds to avoid redundant API calls during write operations. Schema-reading tools (`get_schema`, `list_tables`) always bypass the cache and return fresh data. If a cached schema becomes stale (e.g. a column was renamed), the SeaTable API will reject the write and the AI agent can call `get_schema` to refresh.

## Environment Variables

Required:

- `SEATABLE_SERVER_URL` — Your SeaTable server URL

Authentication (one of these is required in selfhosted mode):

- `SEATABLE_API_TOKEN` — Single-base API token
- `SEATABLE_BASES` — Multi-base: JSON array (e.g. `'[{"base_name":"CRM","api_token":"..."}]'`)

Optional:

- `SEATABLE_MODE` — `selfhosted` (default) or `managed` (multi-tenant HTTP with per-client auth)
- `SEATABLE_TOKEN_SECRET` — **required in managed mode**, min. 32 chars. Seals issued OAuth tokens and client registrations; must be stable across restarts (`openssl rand -hex 32`)
- `SEATABLE_ACCESS_TOKEN_TTL` — lifetime of an issued access token in seconds (default `3600`, range `30`–`2592000`). Lower narrows the window after a SeaTable token is revoked; higher spares users a re-prompt if their client renews badly. The refresh token is never issued shorter-lived than the access token.
- `SEATABLE_MOCK=true` — Enable mock mode for offline testing
- `CORS_ALLOWED_ORIGINS` — Comma-separated list of allowed origins for CORS (HTTP mode only, disabled if unset)
- `OPENAI_APPS_CHALLENGE_TOKEN` — Domain verification token from the OpenAI Apps submission. If set, the server answers `GET /.well-known/openai-apps-challenge` with it (HTTP mode only, endpoint absent if unset)
- `METRICS_PORT` — Prometheus metrics port (default: `9090`, HTTP mode only)

## Monitoring

In HTTP mode, the server exposes Prometheus metrics on a separate port (default `9090`):

```bash
curl http://localhost:9090/metrics
```

Available metrics:

| Metric | Type | Description |
|---|---|---|
| `mcp_tool_calls_total{tool, status}` | Counter | Tool calls by name and result (success/error) |
| `mcp_tool_calls_by_tool_total{tool}` | Counter | Total calls per tool (regardless of outcome) |
| `mcp_tool_duration_seconds{tool}` | Histogram | Tool execution time |
| `mcp_http_requests_total{method, status}` | Counter | HTTP requests by method and status code |
| `mcp_rate_limit_exceeded_total{type}` | Counter | Rate limit rejections (global/per_ip/per_token) |
| `mcp_auth_validations_total{result}` | Counter | Auth validations (success/failure/cache_hit) |
| `mcp_sql_failures_total{tool, reason}` | Counter | Failed `query_sql`/`execute_sql` calls (e.g. `subquery`, `join`, `wrong_statement_update`, `unknown_name`, `invalid_value`, `seatable_error`) |
| `mcp_active_sessions` | Gauge | Currently active HTTP sessions |
| `mcp_active_connections` | Gauge | Currently active connections |
| `seatable_api_requests_total{operation, status}` | Counter | SeaTable API calls by operation |
| `seatable_api_duration_seconds{operation}` | Histogram | SeaTable API latency |

Plus standard Node.js metrics (memory, CPU, event loop) via `prom-client`.

The metrics server only starts in HTTP mode (not stdio) and binds to `0.0.0.0` — in Docker, expose the port only within your internal network.

### SQL failure log

AI models often write MySQL- or PostgreSQL-style SQL that SeaTable does not accept: subqueries, `JOIN`, `UNION`, `CASE WHEN`, `CONCAT()`. To see which patterns fail in practice, every failed `query_sql` or `execute_sql` call writes one log line, without storing any customer data.

**What happens on a call.** `runSql()` in `src/mcp/tools/sqlCheck.ts` runs three stages; each failure is logged and counted:

| Stage | Example | `reasons` |
|---|---|---|
| 1. Constructs SeaTable SQL never supports are rejected before the request | `IN (SELECT …)`, `JOIN`, `UNION`, `WITH`, `OVER (…)`, two statements | `subquery`, `join`, `set_operation`, `cte`, `window_function`, `multiple_statements` |
| 2. Wrong statement type for the tool | `UPDATE` sent to `query_sql`, `SELECT` sent to `execute_sql`, `DROP` | `wrong_statement_<kind>`, e.g. `wrong_statement_update`, `wrong_statement_other` |
| 3. SeaTable rejects the statement | table or column name that doesn't exist | `unknown_name`, with a hint to call `get_schema` |
| | value that doesn't fit the column, e.g. an unknown select option or `15.01.2026` as a date | `invalid_value`, with a hint on options and date format |
| | unknown function, syntax error | `seatable_error`, plus `hints` if MySQL function names were used |

In every case the model gets an error message that tells it how to restructure the query, e.g. *"Run the inner SELECT on its own first, then pass its values into the outer query"* or *"use mid(str, pos, len) instead of SUBSTRING"*.

**What is logged.** One `WARN` line with the message `SQL statement failed`:

```json
{"level":"WARN","tool":"query_sql","reasons":["subquery"],
 "sql_shape":"SELECT * FROM `x` WHERE `x` IN (SELECT `x` FROM `x` WHERE `x` = ?)",
 "msg":"SQL statement failed"}
```

`sql_shape` is the statement with all content removed by `sqlShape()`:

- string literals become `?`, numbers become `0`
- table and column names (quoted or not) become `x`
- comments are dropped, whitespace is collapsed, the result is cut at 500 characters
- only SQL keywords (uppercase), function names (lowercase) and punctuation survive

The original statement and its `parameters` are never logged; a test in `tests/sqlCheck.spec.ts` asserts that table names and values do not appear in the log. Column names are deliberately dropped as well, since names like "Salary" or "Diagnosis" already say something about the customer.

> The general `Tool call failed` line that every tool writes on error is separate and unchanged. For SeaTable errors it contains SeaTable's error message and response body, which may echo column names.

**How to analyse it.** The most frequent failing shapes:

```bash
docker logs <container> 2>&1 | grep '"SQL statement failed"' \
  | jq -r '.sql_shape' | sort | uniq -c | sort -rn | head -30
```

Failures by reason, and the function hints that were given:

```bash
docker logs <container> 2>&1 | grep '"SQL statement failed"' | jq -r '.reasons[]' | sort | uniq -c | sort -rn
docker logs <container> 2>&1 | grep '"SQL statement failed"' | jq -r '.hints[]?' | sort | uniq -c | sort -rn
```

In Prometheus, `mcp_sql_failures_total{tool, reason}` shows the same reasons over time, e.g. `sum by (reason) (increase(mcp_sql_failures_total[7d]))`. Put that next to `mcp_tool_calls_by_tool_total{tool="query_sql"}` to get a failure rate.

**What to do with the results.**

- A shape that keeps failing with `seatable_error` and is a fixed grammar limit → add it to `UNSUPPORTED_CONSTRUCTS` so it is rejected before the request, with a restructuring hint.
- A MySQL function that keeps appearing → add it to `FUNCTION_HINTS`, and to the function mapping in the server instructions (`src/mcp/server.ts`).
- Many `wrong_statement_*` → the tool descriptions are not clear enough.
- Function names only produce hints after a failure, never a rejection, so a function SeaTable adds later cannot be blocked by an outdated list.

## MCP Tools

### Schema Introspection

- **`list_tables`** — Get all tables with metadata
- **`get_schema`** — Get complete database structure
- **`list_bases`** — List available bases (multi-base mode only)
- **`list_collaborators`** — List users with access to the base (for collaborator columns)

### Reading Data

- **`list_rows`** — Paginated row listing (use query_sql for filtering/sorting)
- **`get_row`** — Retrieve specific row by ID
- **`find_rows`** — Client-side filtering with DSL
- **`search_rows`** — Search via SQL WHERE clauses
- **`query_sql`** — Read-only SELECT queries with parameterized inputs

### Writing Data

- **`add_row`** — Add single new row
- **`append_rows`** — Batch insert rows
- **`update_rows`** — Batch update rows
- **`upsert_rows`** — Insert or update rows by key columns
- **`delete_rows`** — Remove rows by ID
- **`execute_sql`** — SQL UPDATE, DELETE or INSERT with parameterized inputs

### Files

- **`upload_file`** — Upload a file or image to a row (base64-encoded)
- **`download_file`** — Read file content from a file or image column (text files and PDFs as text, binary files as download link, max 1 MB)

### Linking

- **`link_rows`** — Create relationships between rows
- **`unlink_rows`** — Remove relationships between rows

### Utilities

- **`get_row_activities`** — Get change history of a row (who changed what, when, old/new values)
- **`create_snapshot`** — Create a snapshot of the current base (10 min cooldown)
- **`add_select_options`** — Add new options to single-select or multi-select columns (existing options are skipped, no duplicates)
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
| Image / File | Yes | Use `upload_file` to upload (base64), `download_file` to read content |
| Formula / Link Formula | No | Read-only, computed by SeaTable |
| Creator / Created Time / Modified Time | No | Read-only, set automatically |
| Auto Number | No | Read-only, set automatically |
| Button / Digital Signature | No | Not accessible via API |

## Tool Examples

```json
// List all tables
{ "tool": "list_tables", "args": {} }

// Get rows with pagination
{ "tool": "list_rows", "args": { "table": "Tasks", "page_size": 10 } }

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

- Node.js >= 20

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

To check how real models use the SQL tools, see [Testing the SQL tools with a model](docs/testing-with-models.md).

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
