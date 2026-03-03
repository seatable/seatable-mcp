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

Required: `SEATABLE_SERVER_URL`, `SEATABLE_API_TOKEN`

Optional: `SEATABLE_BASE_UUID` (auto-detected from token exchange), `SEATABLE_TABLE_NAME`, `SEATABLE_MOCK=true` (offline mock), `SEATABLE_ENABLE_DEBUG_TOOLS=1` (enables `echo_args` tool), `SEATABLE_ACCESS_TOKEN_EXP`, `SEATABLE_TOKEN_ENDPOINT_PATH`

Copy `.env.example` to `.env` for local development.

## Architecture

### Server

`src/index.ts` → `src/mcp/server.ts`: Uses `@modelcontextprotocol/sdk` `Server` class. Supports stdio (default) and Streamable HTTP (`--sse` / `--http`) transports. 19 tools registered via shared registrars from `src/mcp/tools/`.

### Tool Registration Pattern

Each tool in `src/mcp/tools/<toolName>.ts` exports a `register*` function accepting a `ToolRegistrar`:

```typescript
export type ToolRegistrar = (
  server: McpServerLike,
  deps: { client: ClientLike; env: Env; getInputSchema: (schema: any) => any }
) => void
```

The server adapter in `server.ts` collects these registrations into an internal `Map<string, RegisteredTool>`.

### SeaTable Client

`src/seatable/client.ts` (`SeaTableClient`) uses a single Axios instance targeting `/api-gateway/api/v2/dtables/{base_uuid}/`. Lazy initialization: on first API call, performs token exchange and derives `base_uuid` (from env or token response). Rate limiting (5 RPS via `bottleneck`) and retry with exponential backoff (`axios-retry`).

### Schema Utilities

- `src/schema/map.ts` — converts SeaTable metadata to `GenericSchema` format
- `src/schema/validate.ts` — validates row data against schema before writes

## Known Limitations

- `attach_file_to_row` is a stub — does not upload files.
- HTTP sessions are in-memory and do not survive restarts.
