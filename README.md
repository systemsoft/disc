![](banner.png)

A schema-first, TypeScript-native database built on Deno. Disc is a fork of [Gel](https://geldata.com) (formerly EdgeDB), reimplemented in TypeScript/Deno while preserving EdgeQL, SDL schemas, and PostgreSQL as the storage engine.

## Why Disc?

- **Single-language stack** — TypeScript from schema to query to server
- **Deno-native** — leverages Deno's built-in TypeScript, permissions model, and standard library
- **Bundled PostgreSQL** — `disc init` just works; users never install or manage Postgres directly
- **EdgeQL preserved** — the query language is the best part of Gel, so it stays
- **Schema-first** — SDL drives database schema, TypeScript types, and access policies

## Quick Start

```bash
# Install Deno
curl -fsSL https://deno.land/install.sh | sh

# Initialize a new project (downloads PostgreSQL automatically)
deno task cli init my-project
cd my-project

# Start the server
deno task cli serve

# Open the admin UI
deno task cli ui

# Interactive EdgeQL shell
deno task cli shell
```

## Schema Definition

Define your data model with SDL (Schema Definition Language):

```
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

## Query with EdgeQL

```
select User {
  email,
  name,
  posts: {
    created_at,
    title
  }
} filter .email = "user@example.com";
```

Compiles to PostgreSQL SQL automatically.

## CLI Commands

```bash
disc init                      # Initialize a new Disc project
disc start                     # Start the server and bundled PostgreSQL
disc stop                      # Stop the server and PostgreSQL
disc status                    # Show instance status
disc migrate                   # Generate and apply migrations
disc shell                     # Interactive EdgeQL REPL
disc codegen                   # Generate TypeScript types
disc watch                     # Watch schema files and auto-migrate in dev
disc serve                     # Start the Disc server
disc ui                        # Open admin UI in browser
disc build                     # Compile to native binary
disc build --platform linux-x64  # Cross-compile for Linux
disc deploy --format <fmt>     # Generate deployment scaffolds (docker, compose, systemd, env)
disc pg log                    # View PostgreSQL logs
disc pg log -f                 # Follow log output
disc pg upgrade --target-version 17.0  # Upgrade PostgreSQL
```

## Architecture

```
+-----------------------------------------+
|               Disc Server               |
|           (Deno / TypeScript)           |
+-----------------------------------------+
|   Schema Parser   |    EdgeQL Parser    |
|   (SDL -> AST)    |    (EQL -> AST)     |
+-----------------------------------------+
|        Query Planner / Compiler         |
|        (AST -> SQL generation)          |
+-----------------------------------------+
|            Migration Engine             |
|          (Schema diff -> DDL)           |
+-----------------------------------------+
|           Connection Manager            |
|        (PostgreSQL via deno-pg)         |
+-----------------------------------------+
|           PostgreSQL Manager            |
|     (bundled binary lifecycle mgmt)     |
+-----------------------------------------+
                    |
+-----------------------------------------+
|         Bundled PostgreSQL 16+          |
|       ~/.disc/postgres/<version>/       |
+-----------------------------------------+
```

## Features

### Core

- Full SDL parser and schema validation
- EdgeQL parser with complete AST support
- EdgeQL-to-SQL compiler with query caching
- Automatic schema migrations with diffing
- Bundled PostgreSQL lifecycle management
- Real query execution against PostgreSQL

### Server

- HTTP/JSON API with WebSocket support
- Rate limiting (token bucket per IP)
- TLS/HTTPS with HTTP-to-HTTPS redirect
- Prometheus metrics endpoint
- Structured logging (JSON/text)
- Graceful shutdown and health checks
- Request timeouts and CORS

### Security

- JWT authentication with session management
- Object-level access policies
- Row-level security enforcement
- Auth context bridging

### Developer Experience

- Admin UI (SvelteKit, TRON-inspired design)
- TypeScript type generation from schemas
- Interactive EdgeQL REPL
- Development file watcher with auto-migration
- Production deployment guide

## External PostgreSQL

For production deployments or users who prefer to manage their own Postgres:

```bash
disc init --backend-dsn "postgres://user:pass@host:5432/disc"
```

## Deployment

### Native Binary

```bash
disc build                          # Build for current platform
disc build --platform linux-x64     # Cross-compile for Linux
disc build --platform linux-arm64   # Cross-compile for Linux ARM
```

### Docker

```bash
docker build -t disc .              # Production image (external PG)
docker build -f Dockerfile.bundled -t disc-bundled .  # All-in-one with PG
docker compose up -d                # Start Disc + PostgreSQL
```

### Scaffold Generator

```bash
disc deploy --format env            # Generate .env.production template
disc deploy --format systemd        # Generate systemd service unit
disc deploy --format compose        # Generate docker-compose.yml
disc deploy --format docker         # Generate Dockerfile
```

See [Production Deployment Guide](docs/production-deployment.md) for full details including TLS setup, connection pool tuning, health checks, monitoring, and more.

## Development

```bash
# Run tests
deno test --allow-all --no-check --ignore=ui/

# Run tests with PostgreSQL integration
DISC_PG_AUTO=1 deno test --allow-all --no-check --ignore=ui/

# Format and lint
deno fmt
deno lint

# Dev server
deno task dev
```

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation and contribution guidelines.

## License

AGPL-3.0
