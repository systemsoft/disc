# Disc Project State — March 20, 2026

## Project Overview

Disc is a TypeScript-native database fork of Gel (EdgeDB), replacing the Python/Rust core with Deno/TypeScript while preserving EdgeQL and schema-first philosophy. PostgreSQL is bundled and managed automatically.

## Current Implementation Status

**2056 tests passing, 0 failed, 291 ignored** — All Gel parity tiers (1-4) complete.

### Completed Modules

#### P0 — Core Foundation

- **Schema Layer** (100%)
  - SDL lexer, parser, AST, validator
  - Full support for types, constraints, links, modules, annotations, globals
  - Abstract annotation validation (built-in: description, title, deprecated)
  - Collection types (array, tuple), deletion policies, link inheritance
  - Polymorphic types, range/multirange types

- **EdgeQL Parser** (100%)
  - Complete lexer, parser, AST
  - Supports SELECT, INSERT, UPDATE, DELETE, FOR, GROUP BY, WITH/CTE, EXPLAIN, CONFIGURE, DESCRIBE
  - Bitwise operators (&, |, ^, <<, >>), regex operators (~, !~, ~*, !~*)
  - Window functions (OVER, PARTITION BY, frame clauses)
  - Subquery expressions (IN, EXISTS, scalar), INTERSECT/EXCEPT, HAVING
  - IF/ELSE expressions, indexing/slicing, type casts

- **EdgeQL Compiler** (100%)
  - EdgeQL AST → PostgreSQL SQL generation
  - 90+ built-in functions (string, math, datetime, json, bytes, regex, FTS, sequences)
  - Backlink resolution, junction table JOINs (many-to-many)
  - Expression aliases, globals (session-scoped via `current_setting()`)
  - Two-layer caching: parse cache + compilation cache (query+access-context-keyed)
  - Per-query timing metrics (parse_ms, compile_ms, execute_ms)
  - Polymorphic query compilation (IS type checks, discriminator columns)
  - CONFIGURE key mapping (10 Gel-to-PG mappings)
  - Schema introspection (DESCRIBE TYPE/SCHEMA)

- **PostgreSQL Management** (100%)
  - Bundled PostgreSQL with automatic download
  - Platform-specific binary handling (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
  - Instance lifecycle management (create, start, stop, monitor, destroy)
  - Health monitoring with automatic restart
  - Multi-instance support, Unix socket configuration

#### P1 — Essential Features

- **CLI Tools** (100%)
  - Commands: init, start, stop, restart, status, migrate, shell, codegen, serve, ui, watch, build, deploy, pg log, pg upgrade, db create/list/drop
  - `--binary-port` for binary protocol listener
  - `--enable-auth`, `--jwt-secret`, `--enable-access-policies` flags
  - `--rollback`, `--rollback-to`, `--status`, `--squash` migration flags
  - Auto-migration in development

- **Migration Engine** (100%)
  - Schema diffing with complex change detection (constraints, triggers, rewrites, annotations, globals)
  - DDL generation: CHECK constraints, junction tables, type hierarchy, triggers, rewrite rules
  - Migration tracking with rollback support (rollback-to-point, squashing)
  - Data migrations with discover/run/rollback
  - Real PG execution via ConnectionPool with transaction wrapping
  - SchemaManager: SDL → Module[] → Schema (compiler context)
  - Runtime schema reload with onSchemaChange callback

- **HTTP Server** (100%)
  - HTTP/JSON API with WebSocket support for real-time queries
  - Real PostgreSQL query execution via ConnectionPool
  - Real transaction management (BEGIN/COMMIT/ROLLBACK)
  - Multi-database routing (X-Database header, ?database= param)
  - Rate limiting (token bucket per client IP)
  - TLS/HTTPS support with HTTP→HTTPS redirect
  - Prometheus metrics endpoint (`/metrics`)
  - Schema introspection REST endpoints (`/schema`, `/schema/types`, `/schema/types/:name`)
  - Health endpoints, graceful shutdown, CORS, request timeouts
  - Structured logging (JSON/text formats, level filtering, child contexts)
  - Extension route dispatch (`/ext/*`)

#### P2 — Developer Tools

- **Code Generation** (100%)
  - TypeScript type generation from schema with smart Insert/Update types
  - Enum union types, filter variable interfaces
  - JSDoc with constraint documentation and @description from annotations
  - Client query builders extending SDK DiscClient

- **Admin UI** (100%)
  - SvelteKit with TRON-inspired dark theme
  - Schema browser, query editor (CodeMirror), REPL, data viewer
  - Migration history, health monitoring dashboard
  - Built as static site, served at `/ui`

- **TypeScript Client SDK** (100%)
  - DiscClient with query/queryRaw/health/stats
  - AuthManager with auto-refresh JWT tokens
  - Transaction support (callback pattern)
  - WebSocket subscriptions with auto-reconnect

#### P3 — Advanced Features

- **Authentication Module** (100%)
  - Full auth provider with JWT tokens, PgDatabaseAdapter
  - Register, login, logout, refresh, profile, password, reset, verify
  - Server lifecycle integration (opt-in via jwt_secret)

- **Access Control Module** (100%)
  - Policy parser, evaluation engine, SQL injection
  - Policy adapter: SDL AccessPolicy → runtime AccessPolicy
  - Auth→Access context bridge with session globals
  - PostgreSQL RLS generation and enforcement

- **Extension System** (100%)
  - Extension interface, BaseExtension, ExtensionRegistry
  - **Custom Functions** (ext-custom-functions): PL/pgSQL DDL, EdgeQL-to-SQL mapping
  - **Vector Search** (ext-vector): pgvector operators, index builder
  - **OAuth** (ext-oauth): Google/GitHub/Apple provider factories
  - **Full-Text Search** (ext-fts): GIN index on tsvector, fts::search/fts::rank
  - **GraphQL** (ext-graphql): schema generation, query translation, playground
  - Auth/Access extension adapters

- **Binary Wire Protocol** (100%)
  - Complete Gel protocol: 21 message types, buffer reader/writer
  - SCRAM-SHA-256 authentication via Web Crypto API
  - TCP BinaryProtocolServer with connection lifecycle
  - Type descriptors (21 well-known types, 11 descriptor tags)
  - Scalar value codecs (17 types including Gel epoch datetime)
  - Prepared statement cache, output format handling (JSON/BINARY)
  - Gel error code mapping (22 codes)
  - Integrated into DiscServer with `--binary-port` CLI flag

- **Production Infrastructure** (100%)
  - Rate limiting, structured logging, TLS/HTTPS
  - Prometheus metrics, query plan caching
  - Deployment tooling: `disc build` (native binary), `disc deploy` (Docker/compose/systemd)
  - Docker files (multi-stage, bundled PG variant)

## File Structure

```
disc/
├── access/       Access control policies, RLS, evaluation engine
├── auth/         Authentication (JWT, sessions, PG adapter)
├── cli/          CLI commands (init, serve, migrate, shell, build, deploy, etc.)
├── codegen/      TypeScript generation with SDK integration
├── compiler/     EdgeQL → SQL compilation (90+ built-in functions)
├── docs/         Production deployment guide
├── edgeql/       EdgeQL lexer, parser, AST
├── ext-fts/      Full-text search extension (tsvector/tsquery)
├── ext-graphql/  GraphQL extension (schema gen, query translation)
├── extensions/   Extension system (base, registry, custom-functions, vector, oauth)
├── lib/          Shared utilities (logger, cache, connection pool, errors)
├── migration/    Schema migrations, SchemaManager, tracker, rollback, squash
├── postgres/     Bundled PostgreSQL management
├── protocol/     Binary wire protocol (buffer, messages, SCRAM, TCP server)
├── schema/       SDL lexer, parser, AST, validator
├── sdk/          TypeScript client SDK (client, auth, transactions, subscriptions)
├── server/       HTTP/WS server with rate limiting, TLS, metrics, multi-DB
├── tests/        PG test harness, production E2E tests
└── ui/           SvelteKit admin UI (TRON theme)
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

# Build native binary
deno task build

# Build UI
cd ui && bun run build
```

## Environment Variables

| Variable                      | Purpose                              | Default |
| ----------------------------- | ------------------------------------ | ------- |
| `DISC_RATE_LIMIT_RPM`        | Requests per minute per IP           | 60      |
| `DISC_RATE_LIMIT_BURST`      | Burst allowance                      | 10      |
| `DISC_LOG_LEVEL`             | Log level (DEBUG, INFO, WARN, ERROR) | INFO    |
| `DISC_LOG_FORMAT`            | Log format (json, text)              | json    |
| `DISC_TLS_CERT`             | TLS certificate file path            | —       |
| `DISC_TLS_KEY`              | TLS private key file path            | —       |
| `DISC_TLS_REDIRECT`         | Enable HTTP→HTTPS redirect           | false   |
| `DISC_ENABLE_METRICS`       | Enable /metrics endpoint             | false   |
| `DISC_CACHE_MAX_SIZE`       | Query cache max entries              | 1000    |
| `DISC_SLOW_QUERY_MS`        | Slow query log threshold (ms)        | 1000    |
| `DISC_ENABLE_ACCESS_POLICIES`| Enable object-level access policies  | false   |
| `DISC_PG_AUTO`              | Auto-start PG for tests              | —       |
| `DISC_PG_TEST_URL`          | External PG URL for tests            | —       |

## Success Metrics

- Can parse any valid SDL schema (types, constraints, links, triggers, rewrites, annotations, globals)
- Can parse any valid EdgeQL query (SELECT, INSERT, UPDATE, DELETE, FOR, GROUP BY, WITH, EXPLAIN, CONFIGURE, DESCRIBE)
- Can compile EdgeQL to PostgreSQL SQL (90+ built-in functions, polymorphic queries, window functions)
- Can execute queries against real PostgreSQL via HTTP/JSON or binary wire protocol
- Can manage PostgreSQL lifecycle (bundled, multi-instance)
- Can run and track schema migrations with rollback and squashing
- Can generate TypeScript types and client SDK from schema
- Can serve HTTP/WebSocket API with auth, access policies, and extensions
- Can serve binary wire protocol with SCRAM-SHA-256 authentication
- Can run 2056 tests (including PG integration tests)
- Production-ready infrastructure (TLS, rate limiting, metrics, logging, deployment tooling)

## Repository Information

- **Location**: `/Users/netopwibby/Projects/systemSOFT/disc`
- **Git Branch**: primary
- **Last Commit**: `712df45` — Add full-text search and GraphQL extensions
- **License**: AGPL-3.0

---

_Updated March 20, 2026. All Gel parity tiers (1-4) complete. Implementation plan stages 25-44 finished. The project has full schema, query, migration, protocol, and extension support._
