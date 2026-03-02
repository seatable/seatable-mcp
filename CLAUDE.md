# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # TypeScript watch mode (tsx)
npm run build            # Compile TypeScript → dist/
npm run start            # Run compiled dist/index.js (stdio)

# Testing
npm test                 # Run all tests (vitest run)
npm run test:watch       # Watch mode
npx vitest tests/find_rows_dsl.spec.ts   # Run a single test file

# Code quality
npm run lint             # ESLint
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier check
npm run typecheck        # tsc --noEmit

# Manual tool testing (requires .env configured)
node scripts/mcp-call.cjs <tool_name> '<json_args>'
SEATABLE_MOCK=true node scripts/test-client.mjs
```

Test files live in `tests/` and use the `.spec.ts` suffix with Vitest.

## Environment Variables

Required: `SEATABLE_SERVER_URL`, `SEATABLE_API_TOKEN`, `SEATABLE_BASE_UUID`

Optional: `SEATABLE_TABLE_NAME`, `SEATABLE_MOCK=true` (offline mock), `SEATABLE_ENABLE_DEBUG_TOOLS=1` (enables `echo_args` tool), `SEATABLE_ACCESS_TOKEN_EXP`, `SEATABLE_TOKEN_ENDPOINT_PATH`

Copy `.env.example` to `.env` for local development.

## Architecture

### Server Paths

The codebase currently has two separate server implementations:

1. **stdio / SSE path** (`src/index.ts` → `src/mcp/server.ts`): Uses `@modelcontextprotocol/sdk` `Server` class. 11 tools implemented inline.
2. **Cloudflare Worker path** (`src/cloudflare/`): Uses `McpAgent` + Durable Objects. 19+ tools via `ToolRegistrar` from `src/mcp/tools/`.

The `src/mcp/tools/*.ts` registrar files are only used by the Cloudflare path, not by the stdio/SSE path.

### Tool Registration Pattern

Each tool in `src/mcp/tools/<toolName>.ts` exports a `register*` function accepting a `ToolRegistrar`:

```typescript
export interface ToolRegistrar {
  register(name: string, description: string, schema: z.ZodType<object>, handler: ToolHandler): void
}
```

The handler receives `(args, client)` and returns `CallToolResult` via `formatToolResponse(data, isError)`.

### SeaTable Client

`src/seatable/client.ts` (`SeaTableClient`) maintains three Axios instances (`http`, `gatewayHttp`, `externalHttp`) and auto-detects which API surface to use at runtime. Rate limiting (5 RPS via `bottleneck`) and retry with exponential backoff (`axios-retry`) are applied globally.

### Schema Utilities

- `src/schema/map.ts` — converts SeaTable metadata to `GenericSchema` format
- `src/schema/validate.ts` — validates row data against schema before writes

## Known Limitations

- `attach_file_to_row` is a stub — does not upload files.
- `append_rows` does not validate columns against schema (unlike `upsertRows`).
- SSE sessions are in-memory and do not survive restarts.
- Mock-Client missing `querySql`/`linkRows` methods.
