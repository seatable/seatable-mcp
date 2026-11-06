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

`src/index.ts` → `src/mcp/server.ts`: Uses `@modelcontextprotocol/sdk` `Server` class. Supports stdio (default) and Streamable HTTP (`--sse` / `--http`) transports. 22 data-focused tools registered via shared registrars from `src/mcp/tools/`.

### Modes

- **Selfhosted** (default): Single API token from env, one client per process. Supports multi-base via `SEATABLE_BASES`.
- **Managed** (`SEATABLE_MODE=managed`): HTTP-only, each client authenticates with their own Bearer token **on every request** — the `mcp-session-id` header is a routing value, never a credential, and a request must resolve to the identity that created the session. The request body is read only after that check (`tests/authBeforeBody.spec.ts`), because parsing it costs far more memory than its size. Token validated against SeaTable (`src/auth/tokenValidator.ts`) with positive (1 min) / negative (1 min) cache. Rate limiting via `src/ratelimit/` (per-token, per-IP, global, concurrent connections).

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

### Multi-base and the base context

`ContextualClient` binds the target base to an `AsyncLocalStorage` scope opened by `runWithBase()`, which `handleCallTool()` wraps around the tool handler. **Everything that needs the client must read it inside that scope.** Reading after it returns throws `ContextualClient was used outside runWithBase()` — deliberately, and identically whether one base or ten are configured.

That guard exists because the opposite behaviour hid a bug for five months (fixed in #5): the post-handler log line called `getBaseInfo()` after the scope had closed. With a single base it silently succeeded via the registry default; with two or more `resolve(undefined)` threw `Multiple bases available … Specify "base" parameter`, which reads like a caller mistake and discarded a result the handler had already produced correctly. Coverage is in `tests/contextualClient.spec.ts` and `tests/server.spec.ts`.

### SQL tools

`query_sql` (SELECT, read-only) and `execute_sql` (UPDATE/DELETE/INSERT, destructive) are separate because Anthropic's connector directory rejects tools that mix safe and unsafe operations. Both go through `runSql()` in `src/mcp/tools/sqlCheck.ts`, which rejects constructs SeaTable SQL never accepts (subqueries, WITH, UNION, JOIN keyword, window functions, multiple statements) before the request and appends SeaTable function names to errors caused by MySQL functions. Function names only produce hints after a failure, never a rejection, so a function SeaTable adds later can't be blocked.

Every failure is logged as `SQL statement failed` with `reasons` and `sql_shape` and counted in `mcp_sql_failures_total`. `sqlShape()` removes all customer content — literals become `?`/`0`, table and column names become `x` — so the log shows which constructs models get wrong without storing data. Never log the raw statement or its parameters. How to read and act on the log: README, "SQL failure log".

`runSql()` also adds hints to SeaTable's errors, in `ERROR_HINTS`: `no such column/table` points to `get_schema` (reason `unknown_name`), `failed to convert value` and `type mismatch` explain select options and the date format (reason `invalid_value`). In production the failures were guessed names, not dialect problems, and models repeated them.

`truncationNotice()` adds a `notice` field to `query_sql` results that may be cut, and `list_rows` does the same when `has_more` is set. A `LIMIT` below 100 is treated as a deliberate top-N and stays quiet.

SeaTable SQL behaviour verified against 7.0, which the tool texts rely on:

- A `SELECT` without `LIMIT` returns 100 rows, also with `GROUP BY`, and does not say it cut. `LIMIT` goes up to 10,000 and `OFFSET` works (`LIMIT n OFFSET m` and `LIMIT m, n`).
- A link column can't be a join condition: `= other.col` and `= other._id` return nothing, `HAS ANY OF (other.col)` is an error. `GROUP BY` on it works, `` `Link` = 'display value' `` filters, and the link column on the other table supports `IS NULL`.
- `ORDER BY` accepts columns outside the `SELECT` list.
- A deleted API token answers 403 on a self-hosted 7.0 and 404 on SeaTable Cloud. `TokenValidator.check()` treats both, and 401, as revoked.

To see how real models use the tools, run the series in `docs/testing-with-models.md`.

### Row IDs and `find_rows` filters

An answer of "0 rows" reads like a fact, so a request the server can't apply must not end in one. `normalizeWhere()` in `src/mcp/tools/findRows.ts` repairs a filter whose meaning is clear (a JSON string, `{Name: {eq: "x"}}`, `{eq: {column: "Name", value: "x"}}`, aliases such as `=` or `not_in`), and `checkCondition()` reports the rest. `resolveColumns()` corrects the case of a column if only one fits and says so in a `notice`; a typo stays an error. `evalWhere()` compares across types (`"10"` against a number cell as a number) and orders empty cells like SQL, matching none of them. Coverage is in `tests/rowLookup.spec.ts`.

SeaTable's answers for a row ID it doesn't know, verified on SeaTable Cloud. Models tend to pass a visible value such as an auto-number, so `ROW_ID_NOTE` is in every tool description and `withRowIdNote()` adds it to these errors:

- `get_row`, `download_file`, `upload_file`: `row _id not exits`. `update_rows`: `row not found`. `link_rows`: `Row does not exist`.
- `delete_rows`: `param row_ids invalid` for an ID of another form like `D-0008`, otherwise success with `deleted_rows: 0`. The tool reports that count, not the number of IDs it was given.
- `unlink_rows`: success with `deleted_links_count: 0`. The tool reports `success: false` with a notice.
- `get_row_activities`: an empty list, the same as for an existing row whose activities are past the retention period, which varies. The tool looks up the row on an empty result to tell them apart, and its notice names no period.

### Server instructions and tool annotations

The `instructions` in `src/mcp/server.ts` reach every client, and the SeaTable AI chat plugin (`seatable-plugin-ai-chat`) embeds them in its system prompt instead of keeping its own SQL rules. A change there takes effect for all clients on the next deployment, without a plugin release. If a rule moves here from a client, deploy the server first.

`tests/server.spec.ts` pins every tool as read-only, additive or destructive. A tool that can overwrite or remove existing data must be destructive; directory reviewers call the tools and compare against the hints.

### Container

The image's `CMD` runs `node --permission --allow-fs-read=/app`. Writing files, reading outside `/app`, child processes, worker threads and native addons fail with `ERR_ACCESS_DENIED`, so a new feature that needs one of these has to change the flags deliberately. The image has no `wget`, `nc`, npm or apk; health checks use `node`. See README, "Container hardening".

### Schema Utilities

- `src/schema/map.ts` — converts SeaTable metadata to `GenericSchema` format
- `src/schema/validate.ts` — validates row data against schema before writes

## Releases

The workflow runs on tags. `testing-vX.Y.Z` only builds the image `testing-X.Y.Z`. `release-vX.Y.Z` also publishes `:latest`, npm (irreversible) and the MCP Registry.

1. Bump the version in the PR (`npm version X.Y.Z --no-git-tag-version`). The npm job fails if the tag and `package.json` differ.
2. After the merge, build the image and scan it locally with the workflow's Trivy parameters. The workflow pushes the image **before** it scans, so a red scan has already published.
3. Set an annotated tag `release-vX.Y.Z` on `main`. Its message is the changelog: name breaking changes and what deployments with their own compose file have to do.

The commit messages of this public repo should not contain table or column names from customer logs.

## Known Limitations

- HTTP sessions are in-memory and do not survive restarts.
