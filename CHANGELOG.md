# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2025-09-29

### Changed

- Migrated remaining adapter-based tools (`append_rows`, `upsert_rows`, `delete_rows`, `link_rows`, `unlink_rows`, `attach_file_to_row`, `bulk_set_select_options`) to explicit Zod schema registrations directly in the Cloudflare Worker MCP agent.
- Removed dual-registration ambiguity: each tool now has a single authoritative schema (prevents host-side caching of stale permissive schemas and ensures arguments are transmitted correctly).

### Added

- Explicit handlers now return structured JSON payloads consistently across all batch & link operations.
- File attachment tool exposes explicit discriminated union (`url` | `bytes_base64`) with size guard (<= 5 MB) and structured error (`ERR_FILE_TOO_LARGE`).
- Bulk select options tool now returns updated table schema snapshot alongside per-column results.

### Fixed

- Eliminated potential silent argument stripping caused by permissive/empty derived schemas in adapter layer.

### Notes

- Diagnostic tools (`add_row_explicit`, `args_probe`) intentionally retained for short-term transport verification; will be gated or removed prior to production security hardening.
- Future hardening planned: enforce column existence & unknown column policy within `append_rows` when `allow_create_columns` is false, and narrow `row` value typing where practical.

## [1.0.0] - 2025-08-30

### Added

## [1.0.1] - 2025-09-02

### Fixed

- Add npm bin alias `mcp-seatable` so `npx mcp-seatable` works in Claude/Cursor/VSCode configurations.

#### Core Features

- Complete MCP (Model Context Protocol) server implementation with 11 comprehensive tools
- Full SeaTable database integration with REST API support
- Raw SQL query execution with parameterization and injection protection
- Advanced client-side filtering with powerful DSL
- Complete CRUD operations for rows and tables
- Schema management and introspection
- Real-time health monitoring with latency tracking

#### Tools Included

- **Data Operations**: `list_tables`, `list_rows`, `get_row`, `append_rows`, `update_rows`, `delete_rows`
- **Advanced Querying**: `find_rows` (DSL filtering), `query_sql` (raw SQL)
- **Schema Management**: `get_schema`, `manage_tables`
- **System Operations**: `ping_seatable` (health check)

#### Architecture

- Server + setRequestHandler pattern for reliable MCP implementation
- Centralized tool management with comprehensive validation
- TypeScript support with full type safety
- Zod schema validation for all inputs
- Production-ready error handling and logging
- Mock mode for development and testing

#### Developer Experience

- Comprehensive test suite with vitest
- ESLint and Prettier configuration
- Development scripts and CLI tools
- Docker support for containerized deployment
- Detailed documentation and examples

#### Package Features

- Global and local npm installation support
- Programmatic API for library usage
- Binary executable for CLI usage
- TypeScript declaration files included
- Complete environment configuration support

### Technical Details

- Built with @modelcontextprotocol/sdk ^1.17.4
- Requires Node.js >= 18
- Full ESM module support
- Comprehensive error handling with custom error types
- Rate limiting and request retry support
- Flexible token management and authentication

### Documentation

- Complete README with setup instructions
- Tool usage examples and best practices
- Troubleshooting guide
- API reference documentation
- Configuration reference
