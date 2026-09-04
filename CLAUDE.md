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
```

Test files live in `tests/` and use the `.spec.ts` suffix with Vitest. `vitest.config.ts` sets `LOG_LEVEL=warn` to suppress info-level noise. Tests use `SEATABLE_MOCK=true` to run against the in-memory `MockSeaTableClient` without a real SeaTable server.

## Environment Variables

Required: `SEATABLE_SERVER_URL`

Auth (one required in selfhosted): `SEATABLE_API_TOKEN` (single-base) or `SEATABLE_BASES` (multi-base, JSON array `'[{"base_name":"CRM","api_token":"..."}]'`)

Required in managed mode: `SEATABLE_TOKEN_SECRET` (min. 32 chars, stable across restarts) — seals issued OAuth tokens and client registrations.

Optional: `SEATABLE_MODE` (`selfhosted`|`managed`, default `selfhosted`), `SEATABLE_MOCK=true` (offline mock), `SEATABLE_ENABLE_DEBUG_TOOLS=1` (enables `echo_args` tool)

Copy `.env.example` to `.env` for local development.

## Architecture

### Server

`src/index.ts` → `src/mcp/server.ts`: Uses `@modelcontextprotocol/sdk` `Server` class. Supports stdio (default) and Streamable HTTP (`--sse` / `--http`) transports. 21 data-focused tools registered via shared registrars from `src/mcp/tools/`.

### Modes

- **Selfhosted** (default): Single API token from env, one client per process. Supports multi-base via `SEATABLE_BASES`.
- **Managed** (`SEATABLE_MODE=managed`): HTTP-only, each client authenticates with their own Bearer token **on every request** — the `mcp-session-id` header is a routing value, never a credential, and a request must resolve to the identity that created the session. Token validated against SeaTable (`src/auth/tokenValidator.ts`) with positive (1 min) / negative (1 min) cache. Rate limiting via `src/ratelimit/` (per-token, per-IP, global, concurrent connections).

### Connection slots and session lifetime

The concurrent-connection limit (20, per API token, `src/ratelimit/index.ts`) is acquired on session creation and released on `DELETE`, transport close, or by the idle sweeper. Two rules keep the pool from silting up, both covered by `tests/connectionSlots.spec.ts`:

- An initialize request that never produces a session (malformed body, aborted client) releases its slot from `res.on('close')`. Without that the slot is unreachable — the transport never opened, so `onclose` never fires, and the sweeper never sees a session that was never registered.
- A session that initialized but never made a call is reclaimed after **30 s** (`unusedSessionTimeoutMs`) instead of the ordinary 10-minute idle timeout. Reconnect-happy clients leave these behind by the dozen; each one holds a slot.

Client IP for rate limiting comes from the **rightmost** `X-Forwarded-For` entry — the hop our own proxy appended. The leftmost entry is client-supplied and would let a caller pick its own rate-limit bucket. `docker-compose.yml` additionally has Caddy overwrite the header rather than append to it.

### OAuth (managed mode)

`src/auth/oauthProvider.ts` bridges SeaTable API tokens into an OAuth 2.0 authorization code flow. Client registrations and issued tokens are **stateless sealed envelopes** (`src/auth/tokenCipher.ts`, AES-256-GCM keyed from `SEATABLE_TOKEN_SECRET`), so no server-side store is needed and they survive restarts. The `client_id` carries the client's registered `redirect_uris`; `/authorize` rejects anything it cannot open. PKCE `S256` is mandatory and every code is bound to client + exact callback + challenge. The raw SeaTable API token is never returned — `resolveAccessToken()` unseals it server-side.

Callback policy is in `isPermittedRedirectUri()` (may it be used at all) and `isTrustedRedirectUri()` (may it skip the confirmation step). Unknown remote https destinations are allowed but meet an acknowledgement page; the acknowledgement is read from the form body only and requires `Sec-Fetch-Site: same-origin`, so neither the entry link nor a foreign auto-submit can skip it. `SEATABLE_OAUTH_TRUSTED_REDIRECT_HOSTS` only removes that friction.

Adversarial coverage lives in `tests/oauthProvider.security.spec.ts`, `tests/oauthRedirectPolicy.spec.ts`, `tests/oauthRateLimit.spec.ts` and `tests/managedSessionAuth.spec.ts`; they encode attacker behaviour, not honest-client mistakes. `tests/oauthObservability.spec.ts` pins the audit fields (`flow`, `ip`, `callback`, `clientName`) that the July–August 2026 log analysis found missing.

### Tool Registration Pattern

Each tool in `src/mcp/tools/<toolName>.ts` exports a `register*` function accepting a `ToolRegistrar`:

```typescript
export type ToolRegistrar = (
  server: McpServerLike,
  deps: { client: ClientLike; env: Env; getInputSchema: (schema: any) => any; baseNames?: string[] }
) => void
```

The server adapter in `server.ts` collects these registrations into an internal `Map<string, RegisteredTool>`.

### SeaTable Client

`src/seatable/client.ts` (`SeaTableClient`) takes an explicit `SeaTableClientConfig` and uses a single Axios instance targeting `/api-gateway/api/v2/dtables/{base_uuid}/`. Lazy initialization: on first API call, performs token exchange and derives `base_uuid` (from config or token response). Rate limiting (5 RPS via `bottleneck`) and retry with exponential backoff (`axios-retry`). Factory functions: `createClientFromEnv()` (selfhosted), `createClientFromToken()` (managed).

### Multi-Base

`ClientRegistry` (`src/seatable/clientRegistry.ts`) manages multiple `SeaTableClient` instances keyed by base name. `ContextualClient` (`src/seatable/contextualClient.ts`) implements `ClientLike` and proxies calls to the right client based on a `base` parameter. In multi-base mode, `handleCallTool()` extracts the `base` arg and `handleListTools()` injects it into every tool schema dynamically — no changes needed in individual tool files.

### Schema Utilities

- `src/schema/map.ts` — converts SeaTable metadata to `GenericSchema` format
- `src/schema/validate.ts` — validates row data against schema before writes

## Known Limitations

- HTTP sessions are in-memory and do not survive restarts.
