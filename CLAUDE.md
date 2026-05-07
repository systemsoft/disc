# CLAUDE.md — Disc

> "Your data's identity disc."

Disc is a schema-first, TypeScript-native database built on Deno. It is a fork of [Gel](https://geldata.com) (formerly EdgeDB), rewritten from the ground up to replace the Python/Rust core with a Deno/TypeScript stack while preserving Gel's query language and schema-first philosophy.

## Project Overview

### What Is Gel?

Gel is a database that sits on top of PostgreSQL and provides:

- A declarative schema definition language (SDL)
- A purpose-built query language (EdgeQL) that eliminates the need for an ORM
- Automatic migrations from schema diffs
- Built-in auth, access policies, and a rich type system

Gel's core is written in Python and Rust. The client libraries support TypeScript but the server itself does not run on a JS/TS runtime.

### What Is Disc?

Disc replaces Gel's Python/Rust server layer with a Deno/TypeScript implementation while keeping PostgreSQL as the storage engine. The goals:

1. **Single-language stack** — TypeScript from schema to query to server
2. **Deno-native** — leverage Deno's built-in TypeScript, permissions model, and standard library
3. **Bundled PostgreSQL** — `disc init` just works; users never install or manage Postgres directly
4. **Gel-compatible schemas** — existing `.esdl` schema files should work with minimal changes
5. **Preserve EdgeQL semantics** — the query language is the best part of Gel, keep it

### What Disc Is NOT

- A wrapper around Prisma, Drizzle, or any other ORM
- A new query language — EdgeQL is retained
- A ground-up database engine — PostgreSQL remains the storage layer

## Architecture

```
┌─────────────────────────────────────┐
│             Disc Server             │
│         (Deno / TypeScript)         │
├─────────────────────────────────────┤
│  Schema Parser   │  EdgeQL Parser   │
│  (SDL → AST)     │  (EQL → AST)     │
├─────────────────────────────────────┤
│      Query Planner / Compiler       │
│       (AST → SQL generation)        │
├─────────────────────────────────────┤
│          Migration Engine           │
│         (Schema diff → DDL)         │
├─────────────────────────────────────┤
│         Connection Manager          │
│      (PostgreSQL via deno-pg)       │
├─────────────────────────────────────┤
│         PostgreSQL Manager          │
│   (bundled binary lifecycle mgmt)   │
└──────────────────┬──────────────────┘
┌──────────────────▼──────────────────┐
│       Bundled PostgreSQL 16+        │
│     ~/.disc/postgres/<version>/     │
└─────────────────────────────────────┘
```

### Core Modules

| Module       | Responsibility                                                             | Priority |
| ------------ | -------------------------------------------------------------------------- | -------- |
| `schema/`    | SDL parser, AST representation, validation                                 | P0       |
| `edgeql/`    | EdgeQL parser, AST, semantic analysis                                      | P0       |
| `compiler/`  | EdgeQL AST → PostgreSQL SQL compilation                                    | P0       |
| `postgres/`  | Bundled PostgreSQL binary management, lifecycle, health checks             | P0       |
| `migration/` | Schema diffing, DDL generation, migration tracking                         | P1       |
| `server/`    | Protocol handler, connection management, session state                     | P1       |
| `cli/`       | `disc` CLI — project init, migrate, shell, codegen                         | P1       |
| `codegen/`   | TypeScript type generation from schemas                                    | P2       |
| `ui/`        | SvelteKit-based admin UI (schema browser, query editor, data viewer, REPL) | P2       |
| `auth/`      | Built-in auth module (Gel Let`ext::auth` equivalent)                       | P3       |
| `access/`    | Object-level access policies                                               | P3       |

## Tech Stack

- **Runtime**: Deno (latest stable)
- **Language**: TypeScript (strict mode, no `any` unless absolutely necessary)
- **Storage**: PostgreSQL 16+ (bundled — downloaded and managed by Disc automatically)
- **Testing**: `deno test`
- **Linting/Formatting**: `deno lint` and `deno fmt` with project config
- **Package registry**: JSR (jsr.io) preferred, npm via `npm:` specifiers when necessary

## Conventions

### Code Style

- Double quotes for strings
- Two-space indentation
- Semicolons required
- No trailing whitespace
- Object keys in alphabetical order unless logical grouping demands otherwise
- Prefer `const` over `let`; never use `var`
- Use explicit return types on all exported functions
- Prefer `interface` over `type` for object shapes

### File Organization

```
disc/
├── access/            # Access policy engine
├── auth/              # Auth extension module
├── cli/               # CLI entry point and commands
├── codegen/           # TypeScript client type generation
├── compiler/          # EdgeQL → SQL compilation
├── edgeql/            # EdgeQL lexer, parser, AST nodes
├── lib/               # Shared utilities (errors, types, logging, project context)
├── migration/         # Schema diff engine and DDL generation
├── postgres/          # Bundled PostgreSQL binary management and lifecycle
├── schema/            # SDL lexer, parser, AST nodes, validation
├── server/            # Protocol, connections, sessions
├── tests/             # Integration and end-to-end tests
├── ui/                # SvelteKit admin UI (bundled with server)
├── CLAUDE.md          # This file
└── deno.json          # Deno configuration
```

### Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/Variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Test files: `*.test.ts` colocated or in `tests/`
- **SQL/PostgreSQL identifiers: `snake_case`** — All column names, table names, and config directives inside SQL strings and PostgreSQL config must use `snake_case`. PostgreSQL lowercases all unquoted identifiers, so `schemaHash` becomes `schemahash` and breaks row access. Map PG results back to camelCase in TypeScript mapping functions (see `auth/provider.ts` `rowToUser()` and `migration/tracker.ts` row mappers).

### Error Handling

- Define specific error classes in `lib/errors.ts`
- All parser/compiler errors must include source location (line, column, context)
- Never swallow errors silently
- Use `Result<T, E>` patterns where recoverable errors are expected

## Bundled PostgreSQL

Disc ships with PostgreSQL — users never install, configure, or manage Postgres themselves. Running `disc init` downloads the correct PostgreSQL binary for the user's platform and creates a fully managed instance.

### Directory Layout

```
~/.disc/
├── instances/
│   └── my-project/
│       ├── data/                 # PostgreSQL data directory (PGDATA)
│       ├── logs/                 # PostgreSQL and Disc server logs
│       ├── socket/               # Unix domain socket
│       └── disc.toml             # Instance configuration
└── postgres/
    └── 16.4/                     # PostgreSQL version
        ├── bin/                  # pg binaries (postgres, initdb, pg_ctl, etc.)
        ├── lib/                  # shared libraries
        └── share/                # extensions, configs
```

### Lifecycle Management (`postgres/`)

The `postgres/` module handles the full lifecycle of the bundled PostgreSQL instance:

```typescript
// postgres/instance.ts
interface PostgresInstance {
  dataDir: string;
  dsn(): string;
  port: number;
  socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<"running" | "stopped">;
}
```

Key responsibilities:

- **Binary acquisition**: On first run, download the correct pre-built PostgreSQL binary for the user's OS and architecture (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`). Cache in `~/.disc/postgres/<version>/`.
- **Instance initialization**: Run `initdb` to create the data directory, configure `postgresql.conf` for Disc's needs (Unix socket only, no TCP by default, tuned memory settings).
- **Process management**: Start/stop via `pg_ctl`. Monitor health with periodic connection checks. Auto-restart on crash.
- **Version management**: Support multiple PostgreSQL versions side-by-side. Allow upgrading with `disc pg upgrade`.
- **Socket-only by default**: Bind PostgreSQL to a Unix domain socket in the instance directory. No TCP port exposed unless explicitly configured. This keeps things secure and avoids port conflicts.

### External PostgreSQL (Escape Hatch)

For production deployments or users who prefer to manage their own Postgres:

```bash
disc init --backend-dsn "postgres://user:pass@host:5432/disc"
```

When `--backend-dsn` is provided, Disc skips binary download and instance creation entirely, connecting to the external PostgreSQL instead. The user is responsible for managing that server. Disc still manages its own internal schema and migration tables.

### Platform Binary Strategy

| Platform      | Source                                                 |
| ------------- | ------------------------------------------------------ |
| macOS (arm64) | Pre-built from PostgreSQL official or Homebrew bottles |
| macOS (x64)   | Pre-built from PostgreSQL official or Homebrew bottles |
| Linux (x64)   | Pre-built static/portable binaries                     |
| Linux (arm64) | Pre-built static/portable binaries                     |
| Windows       | Pre-built from EDB installers or Docker fallback       |

Binaries are checksummed and verified on download. Disc should maintain a manifest of supported PostgreSQL versions and their download URLs.

## Project Context & Auto-Start

Every CLI command resolves the project it belongs to via `lib/project-context.ts`. This module walks up from the current directory looking for `disc.toml` (like `git` finds `.git/`), parses it, and returns a `ProjectContext` with all connection parameters derived.

### Key modules

- **`lib/project-context.ts`** — `resolveProjectContext()` (sync, walks up for `disc.toml`), `resolveDsn()` (builds socket DSN or returns `backendDsn`), `isPgRunning()` (checks `postmaster.pid`).
- **`postgres/ensure-running.ts`** — `ensurePgRunning(ctx)` (idempotent: discovers on-disk instances, starts if stopped, creates if missing).

### DSN resolution order

All CLI commands that need a database connection resolve the DSN in this order:

1. `--backend-dsn` CLI flag
2. `DATABASE_URL` environment variable
3. `disc.toml` project context (`resolveDsn(ctx)`)
4. Hardcoded fallback: `postgresql://localhost:5432/disc_dev`

### Auto-start behavior

Commands that need PostgreSQL (`serve`, `migrate`, `shell`, `start`) call `ensurePgRunning(ctx)` which:

1. Discovers existing instances from `~/.disc/instances/` on disk
2. If the instance exists and is running, returns immediately
3. If the instance exists but is stopped, starts it via `pg_ctl`
4. If no instance exists, creates one and starts it

This is idempotent — calling when PG is already running is a no-op.

## Conversion Strategy

### Phase 1: Schema Layer (P0)

The SDL parser is the foundation. Gel's SDL syntax must be fully supported.

1. **Lexer**: Tokenize `.esdl` files into a token stream
2. **Parser**: Produce an AST from the token stream
3. **Validator**: Ensure schema consistency (types exist, links resolve, constraints are valid)
4. **IR Generation**: Transform validated AST into an internal representation suitable for SQL generation

Reference: Study Gel's grammar definitions in the original repo. The SDL grammar is well-documented in their docs at https://docs.geldata.com/reference/sdl.

```
# Example Gel SDL that Disc must parse:
module default {
  type User {
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    required email: str {
      constraint exclusive;
    };
    required name: str;
    multi posts: Post;
  };

  type Post {
    required author: User;
    required body: str;
    created_at: datetime {
      default := datetime_current();
    };
    required title: str;
  };
};
```

### Phase 2: Query Layer (P0)

EdgeQL is Gel's query language. It compiles to SQL under the hood.

1. **Lexer/Parser**: Tokenize and parse EdgeQL strings into AST
2. **Semantic Analyzer**: Resolve types, validate paths, infer shapes
3. **SQL Compiler**: Transform EdgeQL AST into PostgreSQL-compatible SQL

Reference: Gel's EdgeQL syntax — https://docs.geldata.com/reference/edgeql

```
# Example EdgeQL that Disc must compile:
select User {
  email,
  name,
  posts: {
    created_at,
    title
  }
} filter .email = "user@example.com";
```

Must compile to something like:

```sql
SELECT
  jsonb_build_object(
    'email', u.email,
    'name', u.name,
    'posts', (
      SELECT jsonb_agg(jsonb_build_object(
        'created_at', p.created_at,
        'title', p.title
      ))
      FROM posts p
      WHERE p.author_id = u.id
    )
  )
FROM users u
WHERE u.email = 'user@example.com';
```

### Phase 3: Migration Engine (P1)

1. Parse current schema (from `.esdl` files)
2. Parse previous schema (from migration history)
3. Diff the two ASTs
4. Generate DDL statements (CREATE TABLE, ALTER TABLE, etc.)
5. Track applied migrations in a `disc_migrations` table

### Phase 4: Server & Protocol (P1)

Gel uses a custom binary protocol. For Disc v1, prioritize:

1. **HTTP/GraphQL interface** — fits the Neue Internet stack
2. **WebSocket support** — for subscriptions and live queries
3. **Binary protocol compatibility** — stretch goal for existing Gel client support

### Phase 5: CLI (P1)

```bash
disc init                  # Initialize a new Disc project (downloads Postgres if needed)
disc start                 # Start the Disc server and bundled PostgreSQL
disc stop                  # Stop the Disc server and bundled PostgreSQL
disc status                # Show instance status (server, Postgres, port, data dir)
disc migrate               # Generate and apply migrations
disc migrate --create      # Create migration without applying
disc shell                 # Interactive EdgeQL REPL
disc codegen               # Generate TypeScript types
disc watch                 # Watch schema files and auto-migrate in dev
disc serve                 # Start the Disc server (alias for disc start)
disc ui                    # Open admin UI in default browser
disc pg upgrade            # Upgrade bundled PostgreSQL version
disc pg log                # Tail PostgreSQL logs
```

### Phase 6: Codegen & Client (P2)

Generate TypeScript types from the schema so queries are fully typed:

```typescript
// Auto-generated by `disc codegen`
export interface User {
  created_at: Date;
  email: string;
  id: string;
  name: string;
  posts: Post[];
}

export interface Post {
  author: User;
  body: string;
  created_at: Date;
  id: string;
  title: string;
}
```

### Phase 7: Admin UI (P2)

Disc ships with a built-in admin UI, served by the Disc server and opened via `disc ui`. Unlike Gel's UI (React/yarn monorepo at [geldata/gel-ui](https://github.com/geldata/gel-ui)), Disc's UI is built with SvelteKit and Sass to keep the entire stack TypeScript-native.

#### Features

- **Schema browser**: Visual representation of object types, links, properties, constraints, and indexes
- **Data viewer/editor**: Browse, filter, insert, update, and delete objects with inline editing
- **Query editor**: Write and execute EdgeQL with syntax highlighting, autocompletion, and parameter UI
- **Visual query builder**: Point-and-click query construction for learning EdgeQL
- **REPL**: Web-based interactive shell with history and result drilling
- **Query analyzer**: Visual execution plan display (maps to PostgreSQL `EXPLAIN` under the hood)
- **Migration history**: Browse applied migrations, view diffs, and schema evolution over time

#### Design Direction

TRON-inspired aesthetic consistent with EOL's theming: dark backgrounds, luminous accent lines, grid-based layouts, and monospaced type for data. The UI should feel like a program's identity disc — everything about your data, visualized.

#### Architecture

```
ui/
├── src/
│   ├── lib/              # Shared components, stores, utilities
│   │   ├── api/          # Client for Disc server API
│   │   ├── components/   # Reusable Svelte components
│   │   └── stores/       # Svelte stores for schema, connection state, etc.
│   ├── routes/           # SvelteKit routes
│   │   ├── data/         # Data viewer/editor
│   │   ├── migrations/   # Migration history viewer
│   │   ├── query/        # Query editor and visual builder
│   │   ├── repl/         # Web REPL
│   │   ├── schema/       # Schema browser
│   │   └── +layout.svelte
│   └── app.html
├── static/
├── package.json
├── svelte.config.js
└── vite.config.ts
```

The UI is built as a static SvelteKit app (`adapter-static`) and bundled into the Disc server binary/distribution. When `disc serve` starts, it serves the UI assets on a `/ui` route. `disc ui` opens the browser to that URL.

#### CLI Integration

```bash
disc ui                    # Open admin UI in default browser
disc ui --port 3001        # Serve UI on a custom port
disc serve --no-ui         # Start server without bundling UI assets
```

## Key Decisions & Open Questions

### Decided

- **PostgreSQL remains the storage engine** — no need to reinvent storage
- **PostgreSQL is bundled** — `disc init` downloads and manages Postgres automatically; users never touch it directly. External Postgres supported via `--backend-dsn` escape hatch.
- **EdgeQL is preserved** — it's the primary differentiator
- **Deno is the runtime** — aligns with the Neue Internet stack
- **AGPL-3.0 or similar copyleft license** — consistent with Dap licensing philosophy

### Open Questions

- **Binary protocol support**: Should Disc implement Gel's binary protocol for backward compatibility with existing clients, or start fresh with HTTP/GraphQL only?
- **Extension system**: Gel has `ext::auth`, `ext::ai`, etc. How modular should Disc's extension system be from day one?
- **Multi-tenancy**: Should schema-per-tenant isolation be a first-class feature?
- **Distributed queries**: Long-term, should Disc support federated queries across instances?

## Working With This Codebase

### Getting Started

```bash
# Install Deno
curl -fsSL https://deno.land/install.sh | sh

# Clone and setup
git clone https://github.com/systemsoft/disc.git
cd disc

# Run tests
deno test

# Run the CLI in dev mode
deno task cli --help
```

### Before Committing

- `deno fmt --check` — formatting
- `deno lint` — linting
- `deno test` — all tests pass
- No `console.log` left in library code (use the logger from `lib/`)

### PR Guidelines

- One concern per PR
- Tests required for parser and compiler changes
- RFC-style documentation for architectural decisions (stored in `docs/rfcs/`)

## Reference Material

- Gel source: https://github.com/geldata/gel
- Gel UI source: https://github.com/geldata/gel-ui
- Gel docs: https://docs.geldata.com
- EdgeQL spec: https://docs.geldata.com/reference/edgeql
- SDL spec: https://docs.geldata.com/reference/sdl
- PostgreSQL docs: https://www.postgresql.org/docs/16/
- Deno standard library: https://jsr.io/@std
