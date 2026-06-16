# Disc Documentation

Disc is a schema-first, TypeScript-native database built on Deno. It sits on top of PostgreSQL and provides a declarative schema language (SDL), a purpose-built query language (EdgeQL), automatic migrations, and a bundled PostgreSQL instance that requires zero manual setup. Disc is a fork of [Gel](https://geldata.com) (formerly EdgeDB), reimplemented in TypeScript while preserving EdgeQL and SDL.

---

## Quick Links

| I want to...                         | Go to                                             |
| ------------------------------------ | ------------------------------------------------- |
| Get up and running from scratch      | [Getting Started](getting-started.md)             |
| Define types, links, and constraints | [Schema (SDL)](schema.md)                         |
| Write queries and mutations          | [EdgeQL](edgeql.md)                               |
| Look up built-in functions           | [Functions Reference](functions.md)               |
| Use the CLI                          | [CLI Reference](cli.md)                           |
| Manage schema changes over time      | [Migrations](migrations.md)                       |
| Generate TypeScript types            | [Codegen](codegen.md)                             |
| Use the TypeScript SDK in my app     | [Client SDK](client-sdk.md)                       |
| Write filter queries against schemas | [Filter API](filter-api.md)                       |
| Configure the Disc server            | [Server Configuration](server.md)                 |
| Set up authentication                | [Auth](auth.md)                                   |
| Add row-level security               | [Access Policies](access-policies.md)             |
| Use extensions                       | [Extensions](extensions.md)                       |
| Browse data in a web UI              | [Admin UI](admin-ui.md)                           |
| Understand the bundled PostgreSQL    | [Bundled PostgreSQL](bundled-postgres.md)         |
| Deploy to production                 | [Production Deployment](production-deployment.md) |
| Tune queries, indexes, and caches    | [Performance](performance.md)                     |
| Run Disc via Docker Compose          | [Docker Compose](docker-compose.md)               |
| Run and write tests                  | [Testing](testing.md)                             |
| Cut and publish a release            | [Releasing](releasing.md)                         |

---

## Key Concepts

**Schema-first.** Your data model is defined in `.disc` files using SDL (Schema Definition Language). Disc parses these definitions, generates migrations, creates PostgreSQL tables, and produces TypeScript types -- all from one source of truth.

**EdgeQL.** Disc uses EdgeQL, not SQL, as its primary query language. EdgeQL compiles to PostgreSQL SQL under the hood but provides a cleaner syntax for nested data, filtering, and type-safe queries. You never write raw SQL unless you want to.

**Bundled PostgreSQL.** Running `disc init` downloads and manages a PostgreSQL instance automatically. Users never install, configure, or maintain PostgreSQL directly. For production, an external PostgreSQL can be connected via `--backend-dsn`.

**TypeScript-native.** The entire stack -- schema parser, query compiler, migration engine, server, CLI, and SDK -- is written in TypeScript and runs on Deno. No Python, Rust, or Java dependencies.

---

## Searching

Disc's docs live as plain Markdown under [`docs/`](.) in the source repo — there is deliberately no docs site infrastructure to plug a search index into. The "search story" is the standard tools your editor and browser already give you:

- **Browser ⌘F / Ctrl+F** — every page is a single Markdown file, so in-page search hits everything you'd want from a search box. The "Quick Links" table near the top of this page is a cross-reference into every doc; once you're on the right page, in-page search closes the loop.
- **GitHub repo search** — the repo's [GitHub search](https://github.com/systemsoft/disc/search?q=&type=) indexes docs along with code, so a query for `disc admin test-policy` returns both the doc reference and the implementation. This is usually the fastest way to answer "where is X documented and where does it live in the code?".
- **`grep -rn ... docs/`** — the local-checkout equivalent. Useful when you want every match across docs and code, or when you're offline. The whole `docs/` tree is one shallow directory so flat grep works fine.

If a future Disc release ships a docs website (e.g., via mdBook, Docusaurus, or VitePress), that site will get a real search box and this section will document how to use it instead.

---

## Full Table of Contents

- [Getting Started](getting-started.md) -- Install Deno, create a project, write a schema, run queries, generate types.
- [Schema (SDL)](schema.md) -- Object types, scalar types, links, properties, constraints, defaults, computed fields, abstract types, modules.
- [EdgeQL](edgeql.md) -- SELECT, INSERT, UPDATE, DELETE, shapes, filters, ordering, pagination, aggregation, subqueries, parameters.
- [EdgeQL Cheat Sheet](edgeql-cheatsheet.md) -- One-page reference of common EdgeQL forms.
- [Functions Reference](functions.md) -- Built-in scalar functions, aggregate functions, date/time functions, string functions, math functions.
- [CLI Reference](cli.md) -- All CLI commands, flags, and usage examples.
- [Migrations](migrations.md) -- Creating, applying, rolling back, and squashing migrations. Schema diffing and DDL generation.
- [Codegen](codegen.md) -- Generating TypeScript interfaces, query builders, and client code from your schema.
- [Client SDK](client-sdk.md) -- Using the `DiscClient` to run queries, manage transactions, subscribe to changes, and handle authentication.
- [Filter API](filter-api.md) -- Object-shaped filter queries on the generated client: operators, combinators, link traversal (single, multi-hop, multi-link, junction tables), shape narrowing, ordering, pagination.
- [Server Configuration](server.md) -- Environment variables, ports, connection pools, CORS, WebSockets, logging, and protocol options.
- [Auth](auth.md) -- JWT-based authentication, user registration, login, session management, and the `AuthManager` SDK.
- [Access Policies](access-policies.md) -- Object-level access policies in SDL, row-level security enforcement, auth context bridging.
- [Extensions](extensions.md) -- Built-in extensions and the extension system architecture.
- [Admin UI](admin-ui.md) -- Schema browser, data viewer, query editor, REPL, and migration history in the web-based admin interface.
- [Bundled PostgreSQL](bundled-postgres.md) -- How Disc downloads, initializes, and manages PostgreSQL. Instance lifecycle, version upgrades, socket configuration.
- [Production Deployment](production-deployment.md) -- TLS, connection pools, health checks, rate limiting, Docker, native binaries, systemd, monitoring.
- [Performance](performance.md) -- Indexing strategy, EXPLAIN diagnostics, parse/compile/EXPLAIN caches, pool tuning, key Prometheus gauges.
- [Docker Compose](docker-compose.md) -- Self-hosted Disc + bundled PostgreSQL via `docker compose up`.
- [Testing](testing.md) -- Running the suite, test categories, authoring new tests, env isolation, PG-backed tests.
- [Releasing](releasing.md) -- How releases are cut and published; the current version is tracked in `version.txt`.
