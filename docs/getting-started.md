# Getting Started

This guide takes you from zero to a running Disc project in about 10 minutes. By the end, you will have a schema, a running database with data in it, generated TypeScript types, and an open admin UI.

---

## Prerequisites

**Deno** (latest stable) is the only requirement. Disc runs on Deno and manages its own PostgreSQL instance automatically -- you do not need to install PostgreSQL.

Install Deno if you have not already:

```bash
curl -fsSL https://deno.land/install.sh | sh
```

Verify the installation:

```bash
deno --version
```

---

## Install Disc

Pick whichever path matches your environment. Each option puts the `disc` binary on your PATH so the rest of this guide can run `disc init`/`serve`/etc. directly.

### Homebrew (macOS, Linux)

The Homebrew Formula builds Disc from source via `deno compile` and installs the binary into `$(brew --prefix)/bin`. `deno` and `bun` are pulled in automatically.

```bash
# Cutting-edge (primary branch HEAD):
brew install --HEAD https://raw.githubusercontent.com/systemsoft/disc/primary/homebrew/disc.rb

# Stable (latest tagged release):
brew install https://raw.githubusercontent.com/systemsoft/disc/primary/homebrew/disc.rb
```

The brew-built binary doesn't bundle PostgreSQL — the runtime downloads it on first `disc init` or `disc serve`. If you want a bundled binary instead, build from source with `deno task build` (see "From source" below).

A standalone tap repo (`brew tap systemsoft/disc && brew install disc`) is planned; until it's published, the Formula URL above is the canonical install path. See [`homebrew/README.md`](https://github.com/systemsoft/disc/blob/primary/homebrew/README.md) for the full rationale.

### From source (any platform)

Clone the repo and use the existing `deno task build`:

```bash
git clone https://github.com/systemsoft/disc.git
cd disc
deno task build
sudo install ./disc /usr/local/bin/disc   # or wherever your PATH points
```

This produces a binary that bundles whatever PG version is in `<DISC_HOME>/postgres/<version>/` if one is cached, otherwise the binary downloads PG on first run. For cross-compilation to a different platform, see [`disc build --platform`](cli.md#disc-build).

---

## 1. Initialize a Project

Create a new Disc project:

```bash
disc init my-app
```

Or, if you have not installed the `disc` binary globally, run via Deno:

```bash
deno run -A jsr:@disc/cli init my-app
```

This creates the following structure:

```
my-app/
  .env          # Database configuration
  .gitignore
  deno.json     # Deno configuration with Disc tasks
  migrations/   # Migration files (auto-generated)
  mod.ts        # Application entry point
  README.md
  schema.disc   # Your database schema
```

Move into the project directory:

```bash
cd my-app
```

On first run, `disc init` downloads a PostgreSQL binary for your platform and creates a managed instance. This happens once and is cached at `~/.disc/postgres/`.

### Init Options

| Flag                  | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `--template <type>`   | Schema template: `minimal`, `basic` (default), or `full` |
| `--backend-dsn <url>` | Use an external PostgreSQL instead of bundled            |
| `--skip-postgres`     | Skip PostgreSQL setup entirely                           |
| `--force`             | Overwrite an existing directory                          |
| `--directory <path>`  | Parent directory for the project                         |

Example with an external database:

```bash
disc init my-app --backend-dsn "postgres://user:pass@host:5432/mydb"
```

---

## 2. Write Your Schema

Open `schema.disc` in your editor. If you used the `basic` template, it already contains a `User` type. Replace it with a more complete schema:

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
    published: bool {
      default := false;
    };
    required title: str;
  };
};
```

This defines two object types -- `User` and `Post` -- with a link between them. The `required` keyword means the property must always have a value. The `multi` keyword on `posts` means a user can have many posts. Constraints like `exclusive` enforce uniqueness.

For full schema syntax, see the [Schema (SDL) reference](schema.md).

---

## 3. Start PostgreSQL

Start the bundled PostgreSQL instance:

```bash
disc start
```

Check that it is running:

```bash
disc status
```

If you used `--backend-dsn` during init, skip this step -- your external PostgreSQL is used directly.

---

## 4. Run Migrations

Generate and apply migrations from your schema:

```bash
disc migrate
```

Disc compares your `.disc` schema against the current database state, generates DDL statements (CREATE TABLE, etc.), and applies them. The migration is tracked in a `disc_migrations` table so it is never applied twice.

To preview what would happen without changing the database:

```bash
disc migrate --dry-run
```

To create a migration without applying it:

```bash
disc migrate --create
```

For more on migrations, see the [Migrations guide](migrations.md).

---

## 5. Start the Server

Start the Disc server, which provides an HTTP API for running EdgeQL queries:

```bash
disc serve
```

The server starts on `http://localhost:5656` by default. It automatically starts the bundled PostgreSQL instance if it is not already running.

### Serve Options

| Flag                       | Description                                 |
| -------------------------- | ------------------------------------------- |
| `--port <port>`            | HTTP port (default: 5656)                   |
| `--host <host>`            | Bind address (default: localhost)           |
| `--jwt-secret <key>`       | Enable authentication with this signing key |
| `--enable-auth`            | Enable the auth subsystem                   |
| `--enable-access-policies` | Enable object-level access policies         |
| `--tls-cert <path>`        | Path to TLS certificate for HTTPS           |
| `--tls-key <path>`         | Path to TLS private key                     |

---

## 6. Run Your First Queries

Open the interactive EdgeQL shell:

```bash
disc shell
```

You will see a `disc>` prompt. Try these queries:

### Insert a user

```
disc> insert User { email := "ada@example.com", name := "Ada" };
```

### Insert a post linked to the user

```
disc> insert Post {
...   author := (select User filter .email = "ada@example.com"),
...   body := "This is my first post.",
...   title := "Hello World"
... };
```

### Select users with their posts

```
disc> select User {
...   email,
...   name,
...   posts: {
...     created_at,
...     title
...   }
... };
```

The result is a nested JSON structure -- no joins, no ORMs:

```json
[
  {
    "email": "ada@example.com",
    "name": "Ada",
    "posts": [
      {
        "created_at": "2026-03-20T12:00:00Z",
        "title": "Hello World"
      }
    ]
  }
]
```

### Filter and order

```
disc> select Post {
...   author: { name },
...   title
... } filter .published = false
...   order by .created_at desc;
```

### Update a post

```
disc> update Post
...   filter .title = "Hello World"
...   set { published := true };
```

### Delete a post

```
disc> delete Post filter .title = "Hello World";
```

Type `\q` to exit the shell. For full query language documentation, see the [EdgeQL reference](edgeql.md).

### Shell Commands

The shell supports several backslash commands:

| Command         | Description                                  |
| --------------- | -------------------------------------------- |
| `\?` or `\help` | Show help                                    |
| `\q` or `\quit` | Quit shell                                   |
| `\d`            | List tables                                  |
| `\dt`           | List tables with details (size, description) |
| `\c <database>` | Connect to a different database              |
| `\i <file>`     | Execute queries from a file                  |
| `\timing`       | Toggle query timing display                  |
| `\history`      | Show command history                         |
| `\clear`        | Clear the screen                             |

> The same table appears in [`docs/cli.md`](cli.md#disc-shell). Keep
> them in sync — column widths included — so a `git diff` instantly
> flags drift.

---

## 7. Generate TypeScript Types

Generate TypeScript types and a client from your schema:

```bash
disc codegen
```

This reads all `.disc` files in `./dbschema/` (or `schema.disc` in the project root) and writes generated code to `./dbschema/disc-client/`:

```
dbschema/disc-client/
  index.ts            # Re-exports and client factory
  client.ts           # DiscClient class
  queries.ts          # Type-safe query builder functions
  types.ts            # TypeScript interfaces for each type
```

### Codegen Options

| Flag                 | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `--schema <file>`    | Single schema file path                                           |
| `--schema-dir <dir>` | Schema directory for multi-file discovery (default: `./dbschema`) |
| `--output <dir>`     | Output directory (default: `./dbschema/disc-client`)              |
| `--target <type>`    | Target: `client`, `server`, or `both`                             |
| `--no-queries`       | Skip query builder generation                                     |
| `--no-mutations`     | Skip mutation method generation                                   |
| `--no-client`        | Skip client library generation                                    |

For more details, see the [Codegen guide](codegen.md).

---

## 8. Use the SDK in Your Application

Import the SDK and run queries programmatically:

```typescript
import { createClient } from "disc/sdk/mod.ts";

const client = createClient({
  baseUrl: "http://localhost:5656"
});

// Run an EdgeQL query
const users = await client.query(`
  select User {
    email,
    name,
    posts: { title }
  }
`);

console.log(users);
```

### Queries with variables

```typescript
const user = await client.query(
  `select User { email, name }
   filter .email = <str>$email`,
  { email: "ada@example.com" }
);
```

### Insert data

```typescript
await client.query(
  `
  insert User {
    email := <str>$email,
    name := <str>$name
  }
`,
  { email: "billie@example.com", name: "Billie" }
);
```

### Transactions

```typescript
const result = await client.transaction(async tx => {
  const user = await tx.query(`
    insert User { email := "cher@example.com", name := "Cher" }
  `);
  await tx.query(`
    insert Post {
      author := (select User filter .email = "cher@example.com"),
      body := "Written in a transaction.",
      title := "First Post"
    }
  `);
  return user;
});
```

### Health checks

```typescript
const alive = await client.isAlive(); // true/false
const ready = await client.isReady(); // true/false
const health = await client.health(); // full status object
```

For the full SDK reference, see the [Client SDK documentation](client-sdk.md).

---

## 9. Open the Admin UI

Disc ships with a web-based admin interface:

```bash
disc ui
```

This opens your browser to the admin UI, which provides:

- **Schema browser** -- view your types, links, properties, and constraints
- **Data viewer** -- browse, filter, and edit data
- **Query editor** -- write and run EdgeQL with syntax highlighting
- **REPL** -- interactive shell in the browser
- **Migration history** -- view applied migrations and schema evolution

For more on the admin UI, see the [Admin UI guide](admin-ui.md).

---

## 10. Development Workflow

For day-to-day development, use the watcher to auto-apply schema changes:

```bash
disc watch
```

This watches your `.disc` files and automatically runs migrations and regenerates types when you save changes.

The typical workflow is:

1. Edit `schema.disc`
2. `disc watch` detects the change and runs migrations
3. Generated TypeScript types update automatically
4. Import the types in your application code

---

## Next Steps

You now have a working Disc project with a schema, data, generated types, and a running server. Here is where to go from here:

- **[Schema (SDL)](schema.md)** -- Learn the full schema language: abstract types, computed properties, indexes, annotations, multi-module schemas.
- **[EdgeQL](edgeql.md)** -- Master the query language: aggregation, grouping, subqueries, polymorphic queries, `with` blocks, and more.
- **[Functions Reference](functions.md)** -- Browse all built-in functions for strings, dates, math, arrays, and JSON.
- **[CLI Reference](cli.md)** -- All commands and flags: `disc start`, `disc stop`, `disc status`, `disc build`, `disc deploy`, `disc db`, `disc pg`.
- **[Migrations](migrations.md)** -- Rollbacks, squashing, migration status, and dry-run previews.
- **[Client SDK](client-sdk.md)** -- Transactions, subscriptions, authentication, error handling, and retry configuration.
- **[Server Configuration](server.md)** -- Environment variables for connection pools, rate limiting, caching, logging, and TLS.
- **[Production Deployment](production-deployment.md)** -- Docker, native binaries, systemd services, health checks, monitoring, and security hardening.
