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
3. **Gel-compatible schemas** — existing `.esdl` schema files should work with minimal changes
4. **Preserve EdgeQL semantics** — the query language is the best part of Gel, keep it

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
└─────────────────────────────────────┘
```

### Core Modules

| Module       | Responsibility                                         | Priority |
|--------------|--------------------------------------------------------|----------|
| `schema/`    | SDL parser, AST representation, validation             | P0       |
| `edgeql/`    | EdgeQL parser, AST, semantic analysis                  | P0       |
| `compiler/`  | EdgeQL AST → PostgreSQL SQL compilation                | P0       |
| `migration/` | Schema diffing, DDL generation, migration tracking     | P1       |
| `server/`    | Protocol handler, connection management, session state | P1       |
| `cli/`       | `disc` CLI — project init, migrate, shell, codegen     | P1       |
| `codegen/`   | TypeScript type generation from schemas                | P2       |
| `auth/`      | Built-in auth module (Gel `ext::auth` equivalent)      | P3       |
| `access/`    | Object-level access policies                           | P3       |

## Tech Stack

- **Runtime**: Deno (latest stable)
- **Language**: TypeScript (strict mode, no `any` unless absolutely necessary)
- **Storage**: PostgreSQL 16+
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
├── cli/               # CLI entry point and commands
├── compiler/          # EdgeQL → SQL compilation
├── edgeql/            # EdgeQL lexer, parser, AST nodes
├── migration/         # Schema diff engine and DDL generation
├── schema/            # SDL lexer, parser, AST nodes, validation
├── server/            # Protocol, connections, sessions
├── codegen/           # TypeScript client type generation
├── auth/              # Auth extension module
├── access/            # Access policy engine
├── lib/               # Shared utilities (errors, types, logging)
├── tests/             # Integration and end-to-end tests
├── deno.json          # Deno configuration
└── CLAUDE.md          # This file
```

### Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/Variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Test files: `*.test.ts` colocated or in `tests/`

### Error Handling

- Define specific error classes in `lib/errors.ts`
- All parser/compiler errors must include source location (line, column, context)
- Never swallow errors silently
- Use `Result<T, E>` patterns where recoverable errors are expected

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
    required name: str;
    required email: str {
      constraint exclusive;
    };
    multi posts: Post;
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
  };

  type Post {
    required title: str;
    required body: str;
    required author: User;
    created_at: datetime {
      default := datetime_current();
    };
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
  name,
  email,
  posts: {
    title,
    created_at
  }
} filter .email = "user@example.com";
```

Must compile to something like:

```sql
SELECT
  jsonb_build_object(
    'name', u.name,
    'email', u.email,
    'posts', (
      SELECT jsonb_agg(jsonb_build_object(
        'title', p.title,
        'created_at', p.created_at
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
disc init                  # Initialize a new Disc project
disc migrate               # Generate and apply migrations
disc migrate --create      # Create migration without applying
disc shell                 # Interactive EdgeQL REPL
disc codegen               # Generate TypeScript types
disc watch                 # Watch schema files and auto-migrate in dev
disc serve                 # Start the Disc server
```

### Phase 6: Codegen & Client (P2)

Generate TypeScript types from the schema so queries are fully typed:

```typescript
// Auto-generated by `disc codegen`
export interface User {
  id: string;
  name: string;
  email: string;
  posts: Post[];
  created_at: Date;
}

export interface Post {
  id: string;
  title: string;
  body: string;
  author: User;
  created_at: Date;
}
```

## Key Decisions & Open Questions

### Decided

- **PostgreSQL remains the storage engine** — no need to reinvent storage
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
git clone https://github.com/nickel/disc.git
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
- Gel docs: https://docs.geldata.com
- EdgeQL spec: https://docs.geldata.com/reference/edgeql
- SDL spec: https://docs.geldata.com/reference/sdl
- PostgreSQL docs: https://www.postgresql.org/docs/16/
- Deno standard library: https://jsr.io/@std
