# Disc Project State — March 17, 2026

## Project Overview

Disc is a TypeScript-native database fork of Gel (EdgeDB), replacing the Python/Rust core with Deno/TypeScript while preserving EdgeQL and schema-first philosophy. PostgreSQL is bundled and managed automatically.

## Current Implementation Status

**724 tests passing, 0 failed, 1 ignored** (shell mock needed)

### ✅ Completed Modules

#### P0 — Core Foundation

- **Schema Layer** (100%)
  - SDL lexer, parser, AST, validator
  - Full support for types, constraints, links, modules

- **EdgeQL Parser** (100%)
  - Complete lexer, parser, AST
  - Supports SELECT, INSERT, UPDATE, DELETE, complex expressions

- **EdgeQL Compiler** (100%)
  - EdgeQL AST → PostgreSQL SQL generation
  - Built-in functions registry (12 EdgeQL→SQL function mappings)
  - Backlink resolution, complex join handling, subquery optimization
  - Two-layer caching: parse cache + compilation cache (query+access-context-keyed)
  - Per-query timing metrics (parse_ms, compile_ms, execute_ms)
  - Schema compilation tests, PG end-to-end tests

- **PostgreSQL Management** (100%)
  - Bundled PostgreSQL with automatic download
  - Platform-specific binary handling (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
  - Instance lifecycle management (create, start, stop, monitor, destroy)
  - Health monitoring with automatic restart
  - Multi-instance support
  - Unix socket configuration by default

#### P1 — Essential Features

- **CLI Tools** (100%)
  - Commands: init, start, stop, restart, status, migrate, shell, codegen, serve, ui, watch
  - Auto-migration in development
  - PostgreSQL lifecycle control
  - TLS cert/key flags, auth flags, access policy flags
  - 57+ test cases across all commands

- **Migration Engine** (100%)
  - Schema diffing with complex change detection
  - DDL generation for PostgreSQL
  - Migration tracking with rollback support
  - Real PG execution via ConnectionPool with transaction wrapping
  - SchemaManager: SDL → Module[] → Schema (compiler context)
  - Runtime schema reload with onSchemaChange callback

- **HTTP Server** (100%)
  - HTTP/JSON API with WebSocket support for real-time queries
  - Real PostgreSQL query execution via ConnectionPool
  - Real transaction management (BEGIN/COMMIT/ROLLBACK)
  - Connection pooling with lifecycle management
  - Rate limiting (token bucket per client IP)
  - TLS/HTTPS support with HTTP→HTTPS redirect
  - Prometheus metrics endpoint (`/metrics`)
  - Health endpoints and server statistics
  - Request timeouts, graceful shutdown, CORS
  - Structured logging (JSON/text formats, level filtering, child contexts)

#### P2 — Developer Tools

- **Code Generation** (90%)
  - TypeScript type generation from schema
  - Client library scaffolding
  - Missing: Query builders

- **Admin UI** (100%)
  - SvelteKit with TRON-inspired dark theme
  - Schema browser with visual type representation
  - EdgeQL query editor with syntax highlighting (CodeMirror)
  - Interactive REPL interface
  - Data viewer/editor for database objects
  - Migration history tracking
  - Health monitoring dashboard
  - Built as static site, served by main server at `/ui`

#### P3 — Advanced Features

- **Authentication Module** (100%)
  - Full auth provider with JWT tokens
  - PgDatabaseAdapter bridging auth `?` placeholders to PG `$1, $2`
  - Register, login, logout, refresh, profile, password reset, verify
  - Server lifecycle integration (opt-in via jwt_secret)
  - CLI flags: `--jwt-secret`, `--enable-auth`
  - Missing: OAuth, WebAuthn

- **Access Control Module** (100%)
  - Policy parser, evaluation engine, SQL injection
  - Policy adapter: SDL AccessPolicy → runtime AccessPolicy
  - Auth→Access context bridge
  - PostgreSQL RLS generation and enforcement
  - Real PG-backed E2E tests (owner filtering, deny overrides, multi-type policies)
  - CLI flag: `--enable-access-policies`

- **Production Infrastructure** (100%)
  - Rate limiting (token bucket per IP, configurable RPM/burst)
  - Structured logging (JSON/text, level filtering, child contexts, stderr)
  - TLS/HTTPS with certificate support and HTTP redirect
  - Prometheus metrics export (`/metrics` endpoint)
  - TTL-based EXPLAIN plan cache
  - Query plan caching with per-query timing metrics
  - Slow query logging (configurable threshold)
  - Error propagation, graceful shutdown, request timeouts
  - Health check endpoints, pool hardening
  - Production deployment guide (706 lines)

### ❌ Not Yet Implemented

- Client SDK (TypeScript library for Disc)
- AI Extension (`ext::ai`)
- Vector search (`pgvector`)
- Full-text search
- GraphQL endpoint
- Binary protocol (Gel compatibility)
- Multi-tenancy
- OAuth / WebAuthn authentication

## File Structure

```
disc/
├── access/     ✅ Access control policies, RLS, evaluation engine
├── auth/       ✅ Authentication (JWT, sessions, PG adapter)
├── cli/        ✅ CLI commands (init, serve, migrate, shell, etc.)
├── codegen/    ✅ TypeScript generation
├── compiler/   ✅ EdgeQL → SQL compilation with caching
├── docs/       ✅ Production deployment guide
├── edgeql/     ✅ EdgeQL lexer, parser, AST
├── lib/        ✅ Shared utilities (logger, cache, connection pool, errors)
├── migration/  ✅ Schema migrations, SchemaManager, tracker
├── postgres/   ✅ Bundled PostgreSQL management
├── schema/     ✅ SDL lexer, parser, AST, validator
├── server/     ✅ HTTP/WS server with rate limiting, TLS, metrics
├── tests/      ✅ PG test harness, integration tests
└── ui/         ✅ SvelteKit admin UI (TRON theme)
```

## Development Commands

```bash
# Run tests (non-PG)
deno test --allow-all --no-check --ignore=ui/

# Run tests (with PG — requires Postgres.app or local PG binaries)
DISC_PG_AUTO=1 deno test --allow-all --no-check --ignore=ui/

# Start development server
deno task dev

# CLI
deno task cli --help

# Format and lint
deno fmt
deno lint

# Build UI
cd ui && bun run build
```

## Environment Variables

| Variable                 | Purpose                              | Default |
| ------------------------ | ------------------------------------ | ------- |
| `DISC_RATE_LIMIT_RPM`    | Requests per minute per IP           | 60      |
| `DISC_RATE_LIMIT_BURST`  | Burst allowance                      | 10      |
| `DISC_LOG_LEVEL`         | Log level (DEBUG, INFO, WARN, ERROR) | INFO    |
| `DISC_LOG_FORMAT`        | Log format (json, text)              | json    |
| `DISC_TLS_CERT`          | TLS certificate file path            | —       |
| `DISC_TLS_KEY`           | TLS private key file path            | —       |
| `DISC_TLS_REDIRECT`      | Enable HTTP→HTTPS redirect           | false   |
| `DISC_TLS_REDIRECT_PORT` | HTTP redirect port                   | 80      |
| `DISC_ENABLE_METRICS`    | Enable /metrics endpoint             | false   |
| `DISC_EXPLAIN_CACHE_TTL` | EXPLAIN plan cache TTL (ms)          | 300000  |
| `DISC_CACHE_MAX_SIZE`    | Query cache max entries              | 1000    |
| `DISC_SLOW_QUERY_MS`     | Slow query log threshold (ms)        | 1000    |
| `DISC_PG_AUTO`           | Auto-start PG for tests              | —       |
| `DISC_PG_TEST_URL`       | External PG URL for tests            | —       |
| `DISC_PG_DEBUG`          | Verbose PG harness logging           | —       |

## Known Issues

1. 1 ignored test (`cli/workflow.test.ts`) — shell command needs mock support for remote connections
2. Pre-existing `camelCase` lint warnings on 100+ snake_case interface fields (cosmetic)

## Success Metrics

- ✅ Can parse any valid SDL schema
- ✅ Can parse any valid EdgeQL query
- ✅ Can compile EdgeQL to PostgreSQL SQL
- ✅ Can execute queries against real PostgreSQL
- ✅ Can manage PostgreSQL lifecycle (bundled)
- ✅ Can run and track schema migrations
- ✅ Can generate TypeScript types from schema
- ✅ Can serve HTTP/WebSocket API with auth and access policies
- ✅ Can run 724 tests (including PG integration tests)
- ✅ Production-ready infrastructure (TLS, rate limiting, metrics, logging)

## Repository Information

- **Location**: `/Users/netopwibby/Projects/systemSOFT/disc`
- **Git Branch**: primary
- **Last Commit**: `9808a18` — Fix duplicate column names in auth refresh query
- **License**: AGPL-3.0

---

_Updated March 17, 2026. All core database integration phases (1-9) are complete. The primary blocker from February (EdgeQL compiler type errors) was resolved across phases 1-4. The project is production-ready for core functionality._
