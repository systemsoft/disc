# Extensions

Disc has a modular extension system that lets you add capabilities to the database server. Extensions can register custom EdgeQL functions, add HTTP routes, inject SQL setup, hook into the query compiler, and report health status.

Disc ships with five built-in extensions:

- **ext::fts** -- Full-text search using PostgreSQL tsvector/tsquery
- **ext::vector** -- Vector similarity search using pgvector
- **ext::graphql** -- Auto-generated GraphQL API from your SDL schema
- **ext::custom-functions** -- User-defined PL/pgSQL functions callable from EdgeQL
- **ext::oauth** -- OAuth 2.0 provider integration (Google, GitHub, Apple)

---

## Extension System Overview

### Lifecycle

Every extension goes through a defined lifecycle:

```
uninitialized -> initializing -> ready -> shutdown
                                  |
                                  v
                                error
```

1. **Registration** -- The extension is registered with the `ExtensionRegistry`.
2. **Database setup** -- Any SQL setup statements (e.g., `CREATE EXTENSION IF NOT EXISTS vector`) are executed.
3. **Initialization** -- The extension’s `initialize()` method is called with access to the connection pool, schema, server config, and logger.
4. **Ready** -- The extension is active. Its functions, routes, and middleware are available.
5. **Shutdown** -- On server stop, `shutdown()` is called in reverse initialization order.

### Dependency Resolution

Extensions can declare dependencies on other extensions. The registry performs a topological sort to ensure correct initialization order. Circular dependencies are detected and rejected.

```typescript
const extension: ExtensionMetadata = {
  dependencies: ["vector"], // initialized after the vector extension
  name: "my-extension",
  version: "1.0.0"
};
```

### Health Checks

Each extension implements a `healthCheck()` method. The server aggregates extension health into the `/health` endpoint:

```bash
curl http://localhost:8080/health
```

```json
{
  "extensions": {
    "fts": {
      "details": "FTS enabled (language: english)",
      "healthy": true
    },
    "graphql": {
      "details": "GraphQL endpoint ready (mutations: false)",
      "healthy": true
    },
    "vector": {
      "details": "pgvector enabled (1536d, hnsw)",
      "healthy": true
    }
  },
  "status": "healthy"
}
```

---

## Enabling Extensions

Extensions are registered with the `DiscServer` at startup. In code:

```typescript
import { CustomFunctionsExtension } from "./ext-custom-functions/extension.ts";
import { FtsExtension } from "./ext-fts/extension.ts";
import { GraphQLExtension } from "./ext-graphql/extension.ts";
import { OAuthExtension } from "./ext-oauth/extension.ts";
import { VectorExtension } from "./ext-vector/extension.ts";
import { DiscServer } from "./server/disc-server.ts";

const server = new DiscServer({
  // ... server config
  extensions: [
    new FtsExtension("english"),
    new VectorExtension({ defaultDimensions: 1536, indexType: "hnsw" }),
    new GraphQLExtension({ enableMutations: true })
  ]
});

await server.start();
```

Extension HTTP routes are served under `/ext/<extension-name>/`. For example, the GraphQL extension’s query endpoint is at `/ext/graphql/graphql`.

---

## Full-Text Search (ext::fts)

Full-text search uses PostgreSQL’s built-in tsvector and tsquery infrastructure. No additional PostgreSQL extension is needed.

### Schema Setup

Add an FTS index to your type’s properties using the index builder:

```typescript
import {
  generateFtsColumn,
  generateFtsIndex
} from "./ext-fts/index-builder.ts";

const config = {
  columns: ["title", "body"],
  language: "english",
  tableName: "blog_posts",
  typeName: "default::BlogPost",
  weights: {
    body: "B",
    title: "A"
  }
};

// Generates:
// ALTER TABLE blog_posts ADD COLUMN fts_vector tsvector
//   GENERATED ALWAYS AS (
//     setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
//     setweight(to_tsvector('english', coalesce(body, '')), 'B')
//   ) STORED;
const columnDDL = generateFtsColumn(config);

// Generates:
// CREATE INDEX blog_posts_fts_idx ON blog_posts USING GIN (fts_vector);
const indexDDL = generateFtsIndex(config);
```

The generated `fts_vector` column is a `GENERATED ALWAYS AS ... STORED` column that automatically updates when the source columns change.

### Weights

FTS weights control the relative importance of matches in different columns during ranking:

| Weight | Priority         |
| ------ | ---------------- |
| A      | Highest          |
| B      | High             |
| C      | Medium           |
| D      | Lowest (default) |

Columns without an explicit weight get the default (D) treatment.

### EdgeQL Functions

The FTS extension registers two EdgeQL functions:

**`fts::search(query: str) -> bool`** -- Returns true if the row’s `fts_vector` matches the search query.

**`fts::rank(query: str) -> float64`** -- Returns a relevance score for ranking results.

```
# Find posts matching "database TypeScript"
select BlogPost {
  body,
  rank := fts::rank("database TypeScript"),
  title
}
filter fts::search("database TypeScript")
order by fts::rank("database TypeScript") desc;
```

These compile to PostgreSQL’s `@@` (match) and `ts_rank()` operators:

```sql
SELECT jsonb_build_object(
  'title', bp.title,
  'body', bp.body,
  'rank', ts_rank(bp.fts_vector, plainto_tsquery('english', 'database TypeScript'))
)
FROM blog_posts bp
WHERE bp.fts_vector @@ plainto_tsquery('english', 'database TypeScript')
ORDER BY ts_rank(bp.fts_vector, plainto_tsquery('english', 'database TypeScript')) DESC;
```

### Language Configuration

The FTS extension defaults to the `english` text search configuration. Change it at construction:

```typescript
new FtsExtension("spanish");
new FtsExtension("simple"); // language-agnostic, no stemming
new FtsExtension("german");
```

PostgreSQL ships with configurations for many languages. Run `SELECT cfgname FROM pg_ts_config;` to list available configurations.

---

## Vector Search (ext::vector)

Vector search enables similarity queries on embedding vectors using the [pgvector](https://github.com/pgvector/pgvector) PostgreSQL extension.

### Prerequisites

The pgvector extension must be available in your PostgreSQL installation. Disc’s database setup automatically runs `CREATE EXTENSION IF NOT EXISTS vector;` when the extension initializes.

### Configuration

```typescript
new VectorExtension({
  defaultDimensions: 1536, // Default: 1536 (OpenAI ada-002)
  indexType: "hnsw" // Default: "hnsw" (alternative: "ivfflat")
});
```

### Storing Vectors

Add a vector column to your schema. The vector type is registered by the extension:

```
module default {
  type Document {
    required content: str;
    embedding: array<float32>;  # Vector stored as float array
    required title: str;
  };
};
```

### Distance Operators

The extension registers four EdgeQL functions that compile to pgvector operators:

| Function                  | Operator        | Description                                        |
| ------------------------- | --------------- | -------------------------------------------------- |
| `cosine_similarity(a, b)` | `1 - (a <=> b)` | Cosine similarity (0 to 1, higher is more similar) |
| `l2_distance(a, b)`       | `a <-> b`       | Euclidean (L2) distance (lower is more similar)    |
| `inner_product(a, b)`     | `a <#> b`       | Inner (dot) product distance                       |
| `to_vector(arr)`          | `arr::vector`   | Cast a float array to a pgvector vector            |

### EdgeQL Example

```
# Find documents similar to a query embedding
select Document {
  similarity := cosine_similarity(.embedding, to_vector(<array<float32>>$query_embedding)),
  title
}
order by l2_distance(.embedding, to_vector(<array<float32>>$query_embedding))
limit 10;
```

### Index Types

Create a vector index for fast approximate nearest neighbor search:

```typescript
import { generateVectorIndex } from "./ext-vector/index-builder.ts";

// HNSW index (recommended for most use cases)
const hnswIndex = generateVectorIndex({
  columnName: "embedding",
  dimensions: 1536,
  efConstruction: 64, // Build-time search width (default: 64)
  indexType: "hnsw",
  m: 16, // Max connections per node (default: 16)
  tableName: "documents"
});
// CREATE INDEX IF NOT EXISTS idx_documents_embedding_vector
//   ON documents USING hnsw (embedding vector_cosine_ops)
//   WITH (m = 16, ef_construction = 64);

// IVFFlat index (faster builds, slightly lower recall)
const ivfflatIndex = generateVectorIndex({
  columnName: "embedding",
  dimensions: 1536,
  indexType: "ivfflat",
  lists: 100, // Number of clusters (default: 100)
  tableName: "documents"
});
// CREATE INDEX IF NOT EXISTS idx_documents_embedding_vector
//   ON documents USING ivfflat (embedding vector_cosine_ops)
//   WITH (lists = 100);
```

**HNSW** is generally preferred for production workloads -- it provides better recall and does not require a separate training step. **IVFFlat** builds faster and uses less memory, but requires `lists` to be tuned based on dataset size.

---

## GraphQL (ext::graphql)

The GraphQL extension auto-generates a GraphQL schema from your SDL type definitions and translates incoming GraphQL queries to EdgeQL.

### Configuration

```typescript
new GraphQLExtension({
  enableMutations: false, // Default: false (queries only)
  maxDepth: 10 // Default: 10 (max nesting depth)
});
```

### Routes

The extension registers three HTTP routes:

| Method | Path                          | Description                      |
| ------ | ----------------------------- | -------------------------------- |
| POST   | `/ext/graphql/graphql`        | Execute a GraphQL query          |
| GET    | `/ext/graphql/graphql`        | GraphQL playground UI            |
| GET    | `/ext/graphql/graphql/schema` | Return the generated GraphQL SDL |

### Rate limiting (gh/geldata#718)

GraphQL endpoints inherit the server’s HTTP-level rate limiter — the same per-client-IP, per-minute gate that applies to `/query` and every other route. Configure via `rateLimitRpm` / `rateLimitBurst` on the server config; the limiter runs _before_ extension routing in `server/http.ts`, so any flood targeting `/ext/graphql/*` is rejected with `429 Rate limit exceeded` exactly like an EdgeQL flood would be.

Disc does **not** currently apply per-query-complexity weighting (deep nested queries count the same as `{ __typename }`). The `maxDepth` config above caps recursion depth as a coarse safety net, but a proper cost-based limiter — counting nested fields, list multipliers, and aliased duplicates — is future work and would require introducing a query-cost analyzer in `query-translator.ts`. File an issue if you hit a real DoS pattern this misses.

### Schema Generation

The extension automatically maps your SDL types to GraphQL types:

**EdgeQL to GraphQL type mapping:**

| EdgeQL Type          | GraphQL Type                         |
| -------------------- | ------------------------------------ |
| `str`                | `String`                             |
| `bool`               | `Boolean`                            |
| `int16`, `int32`     | `Int`                                |
| `int64`, `bigint`    | `String` (exceeds GraphQL Int range) |
| `float32`, `float64` | `Float`                              |
| `uuid`               | `ID`                                 |
| `datetime`           | `DateTime` (custom scalar)           |
| `json`               | `JSON` (custom scalar)               |
| `decimal`            | `String`                             |
| `bytes`              | `String`                             |

Object types and enum types are mapped directly. Links become nested object references.

**Generated query roots:**

For each non-abstract object type `Foo`, the extension generates:

```graphql
type Query {
  foo(id: ID!): Foo # Fetch by ID
  allFoos(first: Int, offset: Int, filter: String): [Foo]  # List query
}
```

**Generated mutations** (when `enableMutations: true`):

```graphql
input CreateFooInput { ... } # All fields except id
input UpdateFooInput { ... } # All fields optional

type Mutation {
  createFoo(input: CreateFooInput!): Foo
  updateFoo(id: ID!, input: UpdateFooInput!): Foo
  deleteFoo(id: ID!): Boolean
}
```

### Query Translation

GraphQL queries are parsed and translated to EdgeQL:

```graphql
# GraphQL
{
  user(id: "d290f1ee-6c54-4b01-90e6-d701748f0851") {
    email
    name
    posts {
      title
    }
  }
}
```

Translates to:

```
select User {email, name, posts: {title}}
filter .id = <uuid>"d290f1ee-6c54-4b01-90e6-d701748f0851"
```

List queries with pagination:

```graphql
{
  allUsers(first: 10, offset: 20) {
    email
    name
  }
}
```

Translates to:

```
select User {name, email} limit 10 offset 20
```

### Playground

Navigate to `/ext/graphql/graphql` in a browser to open the built-in GraphQL playground. It provides a text editor for writing queries and displays results inline.

### Query Depth Limiting

To prevent abuse, the extension rejects queries deeper than `maxDepth` (default: 10 levels of nesting). This is measured by counting nested `{ }` braces in the query string.

### Limitations

- Fragment spreading (`...FragmentName`) is not yet supported
- Directives (`@skip`, `@include`) are not yet supported
- Subscriptions are not supported via GraphQL (use EdgeQL WebSocket subscriptions instead)
- The query is translated to EdgeQL but currently returns the translation result rather than executing it end-to-end. Full execution through the EdgeQL compiler is planned.

---

## Custom Functions

The custom functions extension lets you define PL/pgSQL functions in PostgreSQL and call them from EdgeQL.

### Defining Functions

Create a `CustomFunctionsExtension` with your function definitions:

```typescript
import { CustomFunctionsExtension } from "./ext-custom-functions/extension.ts";

const ext = new CustomFunctionsExtension({
  functions: [
    {
      args: [
        { name: "amount", required: true, type: "float64" },
        { name: "rate", required: true, type: "float64" }
      ],
      description: "Calculate tax on an amount",
      implementation: {
        body: `
BEGIN
  RETURN amount * rate / 100.0;
END;
        `,
        kind: "plpgsql"
      },
      name: "calculate_tax",
      returnType: "float64",
      volatility: "immutable"
    }
  ]
});
```

### Implementation Types

Each function definition specifies how the function is implemented:

**`plpgsql`** -- A PL/pgSQL function body. The extension generates `CREATE OR REPLACE FUNCTION` DDL and executes it during initialization:

```typescript
{
  body: `
BEGIN
  RETURN upper(input_text);
END;
  `,
  kind: "plpgsql"
}
```

Generated DDL:

```sql
CREATE OR REPLACE FUNCTION calculate_tax(amount double precision, rate double precision)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
AS $func$
BEGIN
  RETURN amount * rate / 100.0;
END;
$func$;
```

**`sql_name`** -- Maps to an existing PostgreSQL function by name:

```typescript
{
  kind: "sql_name",
  sqlName: "pg_catalog.upper"
}
```

**`sql_expression`** -- An inline SQL expression with positional parameters:

```typescript
{
  expression: "$1 + $2",
  kind: "sql_expression"
}
```

### Type Mapping

EdgeQL types are mapped to PostgreSQL types:

| EdgeQL     | PostgreSQL         |
| ---------- | ------------------ |
| `str`      | `text`             |
| `bool`     | `boolean`          |
| `int16`    | `smallint`         |
| `int32`    | `integer`          |
| `int64`    | `bigint`           |
| `float32`  | `real`             |
| `float64`  | `double precision` |
| `datetime` | `timestamptz`      |
| `uuid`     | `uuid`             |
| `json`     | `jsonb`            |
| `bytes`    | `bytea`            |

Only these scalar types are supported in custom-function signatures; passing any other type name (including `decimal`) throws an `ExtensionConfigError` at registration.

### Volatility

PostgreSQL uses function volatility to optimize query plans:

| Volatility  | Meaning                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `immutable` | Same inputs always produce the same output. PostgreSQL can cache results and fold constant expressions. Use for pure calculations.    |
| `stable`    | Returns the same result within a single table scan. Safe for functions that read the database but do not modify it.                   |
| `volatile`  | May return different results on each call. Use for functions with side effects or that depend on external state. This is the default. |

### EdgeQL Usage

Once registered, custom functions are callable from EdgeQL like built-in functions:

```
select Invoice {
  subtotal,
  tax := calculate_tax(.subtotal, 8.25),
  total := .subtotal + calculate_tax(.subtotal, 8.25)
};
```

---

## OAuth (ext::oauth)

The OAuth extension adds OAuth 2.0 authorization code flow support with built-in provider configurations for Google, GitHub, and Apple.

### Configuration

```typescript
import { OAuthExtension } from "./ext-oauth/extension.ts";

import {
  appleProvider,
  githubProvider,
  googleProvider
} from "./ext-oauth/providers.ts";

const ext = new OAuthExtension({
  defaultRedirectUri: "http://localhost:8080/ext/oauth/callback",
  providers: [
    githubProvider(
      "your-github-client-id",
      "your-github-client-secret",
      "http://localhost:8080/ext/oauth/callback/github"
    ),
    googleProvider(
      "your-google-client-id",
      "your-google-client-secret",
      "http://localhost:8080/ext/oauth/callback/google"
    )
  ],
  stateExpiryMs: 600_000 // 10 minutes (default)
});
```

### Provider Factories

Disc includes factory functions that pre-configure OAuth endpoints:

**`googleProvider(clientId, clientSecret, redirectUri?)`**

- Authorize: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- User info: `https://www.googleapis.com/oauth2/v3/userinfo`
- Default scopes: `email`, `openid`, `profile`

**`githubProvider(clientId, clientSecret, redirectUri?)`**

- Authorize: `https://github.com/login/oauth/authorize`
- Token: `https://github.com/login/oauth/access_token`
- User info: `https://api.github.com/user`
- Default scopes: `user:email`

**`appleProvider(clientId, clientSecret, redirectUri?)`**

- Authorize: `https://appleid.apple.com/auth/authorize`
- Token: `https://appleid.apple.com/auth/token`
- User info: `https://appleid.apple.com/auth/userinfo`
- Default scopes: `email`, `name`

### Custom Providers

Define any OAuth 2.0 provider manually:

```typescript
const customProvider: OAuthProviderConfig = {
  authorizeUrl: "https://gitlab.com/oauth/authorize",
  clientId: "your-client-id",
  clientSecret: "your-client-secret",
  name: "gitlab",
  redirectUri: "http://localhost:8080/ext/oauth/callback/gitlab",
  scopes: ["read_user"],
  tokenUrl: "https://gitlab.com/oauth/token",
  userInfoUrl: "https://gitlab.com/api/v4/user"
};
```

### Routes

| Method | Path                              | Description                                   |
| ------ | --------------------------------- | --------------------------------------------- |
| GET    | `/ext/oauth/providers`            | List configured providers                     |
| GET    | `/ext/oauth/authorize/<provider>` | Start OAuth flow, returns authorize URL       |
| GET    | `/ext/oauth/callback/<provider>`  | Handle OAuth callback with `code` and `state` |

### OAuth Flow

1. **Start authorization:** Call `GET /ext/oauth/authorize/google`. The server generates a cryptographic state token, stores it with a 10-minute expiry, and returns the authorize URL:

```json
{
  "state": "a1b2c3d4-...",
  "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&state=..."
}
```

2. **Redirect the user** to the returned URL. They authenticate with the provider.

3. **Handle the callback:** The provider redirects back to `/ext/oauth/callback/google?code=...&state=...`. The server validates the state token (one-time use, checked against expiry) and returns the authorization code.

4. **Exchange for tokens:** In a full implementation, the callback exchanges the authorization code for an access token and fetches user info. The token exchange and user info functions are available:

```typescript
import {
  exchangeCodeForToken,
  fetchUserInfo
} from "./ext-oauth/token-exchange.ts";

const tokenResponse = await exchangeCodeForToken(provider, code, redirectUri);
// { accessToken: "...", expiresIn: 3600, tokenType: "Bearer" }

const userInfo = await fetchUserInfo(provider, tokenResponse.accessToken);
// { avatarUrl: "...", email: "...", id: "...", name: "...", raw: {...} }
```

### State Management

OAuth state tokens are managed by `OAuthStateManager`:

- Each state is a UUID generated with `crypto.randomUUID()`
- States expire after `stateExpiryMs` (default: 10 minutes)
- States are single-use -- validated once, then deleted
- Expired states are cleaned up when `cleanup()` is called

### Database Tables

The extension creates two tables:

**`disc_oauth_states`** -- Stores pending OAuth authorization states

| Column         | Type             |
| -------------- | ---------------- |
| `created_at`   | TIMESTAMPTZ      |
| `expires_at`   | TIMESTAMPTZ      |
| `provider`     | TEXT NOT NULL    |
| `redirect_uri` | TEXT NOT NULL    |
| `state`        | TEXT PRIMARY KEY |

**`disc_oauth_identities`** -- Links OAuth provider identities to local users

| Column             | Type             |
| ------------------ | ---------------- |
| `access_token`     | TEXT             |
| `avatar_url`       | TEXT             |
| `created_at`       | TIMESTAMPTZ      |
| `email`            | TEXT             |
| `id`               | UUID PRIMARY KEY |
| `name`             | TEXT             |
| `provider`         | TEXT NOT NULL    |
| `provider_user_id` | TEXT NOT NULL    |
| `refresh_token`    | TEXT             |
| `updated_at`       | TIMESTAMPTZ      |
| `user_id`          | UUID NOT NULL    |

A unique constraint on `(provider, provider_user_id)` prevents duplicate identity links.

---

## Creating Custom Extensions

### The Extension Interface

Every extension implements the `Extension` interface:

```typescript
interface Extension {
  readonly metadata: ExtensionMetadata;
  readonly state: ExtensionState;

  initialize(context: ExtensionContext): Promise<void>;
  shutdown(): Promise<void>;

  getCompilerHooks(): CompilerHook[];
  getDatabaseSetup(): ExtensionDatabaseSetup;
  getFunctions(): FunctionDef[];
  getMiddleware(): ExtensionMiddleware[];
  getRoutes(): ExtensionRoute[];
  getTypes(): TypeDef[];
  healthCheck(): Promise<{ details?: string; healthy: boolean; }>;
}
```

### Using BaseExtension

Extend `BaseExtension` to get default implementations for all methods. Override only what you need:

```typescript
import { BaseExtension } from "./extensions/base-extension.ts";

import type {
  ExtensionContext,
  ExtensionMetadata,
  ExtensionRoute
} from "./extensions/types.ts";

export class MyExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    dependencies: [], // other extensions this depends on
    description: "Does something useful",
    name: "my-extension",
    version: "1.0.0"
  };

  override async initialize(context: ExtensionContext): Promise<void> {
    this.setState("initializing");
    context.logger.info("My extension starting up");
    // Setup logic here
    this.setState("ready");
  }

  override async shutdown(): Promise<void> {
    // Cleanup logic here
    this.setState("shutdown");
  }
}
```

### Extension Context

The `initialize()` method receives an `ExtensionContext` with access to:

```typescript
interface ExtensionContext {
  config: ServerConfig; // Full server configuration
  logger: Logger; // Scoped logger instance
  pool?: ConnectionPool; // Database connection pool
  schema: Schema; // Current compiled schema
}
```

### Adding EdgeQL Functions

Return `FunctionDef` objects from `getFunctions()` to register custom EdgeQL functions:

```typescript
override getFunctions(): FunctionDef[] {
  return [
    {
      args: [{ name: "name", required: true, type: "str" }],
      name: "my_extension::greet",
      returnType: "str",
      sqlName: "my_greet_func" // PostgreSQL function name
    },
  ];
}
```

### Adding HTTP Routes

Return `ExtensionRoute` objects from `getRoutes()`. Routes are served at `/ext/<name>/<path>`:

```typescript
override getRoutes(): ExtensionRoute[] {
  return [
    {
      handler: async (request: Request): Promise<Response> => {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" }
        });
      },
      method: "GET",
      path: "/status"
    },
    {
      handler: async (request: Request): Promise<Response> => {
        const body = await request.json();
        // Process the request
        return new Response(JSON.stringify({ result: "done" }), {
          headers: { "Content-Type": "application/json" }
        });
      },
      method: "POST",
      path: "/process"
    }
  ];
}
```

These routes would be accessible at:

- `GET /ext/my-extension/status`
- `POST /ext/my-extension/process`

### Adding Middleware

Return `ExtensionMiddleware` objects from `getMiddleware()` to intercept all requests:

```typescript
override getMiddleware(): ExtensionMiddleware[] {
  return [
    {
      handle: async (request: Request, next: () => Promise<Response>): Promise<Response> => {
        const start = Date.now();
        const response = await next();
        console.log(`${request.method} ${request.url} - ${Date.now() - start}ms`);
        return response;
      },
      name: "my-logger",
      priority: 10 // Lower numbers run first
    }
  ];
}
```

### Database Setup

Return SQL statements to run during initialization:

```typescript
override getDatabaseSetup(): ExtensionDatabaseSetup {
  return {
    setupSql: [
      `CREATE TABLE IF NOT EXISTS my_extension_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL,
        value JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`,
      `CREATE INDEX IF NOT EXISTS idx_my_ext_key ON my_extension_data(key);`
    ],
    teardownSql: [
      "DROP TABLE IF EXISTS my_extension_data;"
    ]
  };
}
```

Setup SQL is executed before `initialize()` is called. Teardown SQL is available for cleanup but is not automatically executed.

### Compiler Hooks

Return `CompilerHook` objects to transform function calls during EdgeQL-to-SQL compilation:

```typescript
override getCompilerHooks(): CompilerHook[] {
  return [
    {
      name: "my-functions",
      transformFunctionCall: (funcName: string, args: string[]): string | undefined => {
        if (funcName === "my_extension::greet")
          return `"Hello, " || ${args[0]}`;

        return undefined;  // return undefined to skip (let other hooks handle it)
      },
    },
  ];
}
```

When the compiler encounters a function call, it checks each hook’s `transformFunctionCall`. The first hook that returns a non-undefined string wins. If no hook handles the function, the default compilation behavior is used.

### Health Reporting

Override `healthCheck()` to report extension health:

```typescript
override async healthCheck(): Promise<{ details?: string; healthy: boolean; }> {
  // Check whatever your extension depends on
  const isReady = this.state === "ready";

  return {
    details: isReady ?
      "My extension is operational" :
      "Not initialized",
    healthy: isReady
  };
}
```

### Registration

Register your extension with the server:

```typescript
import { MyExtension } from "./my-extension/extension.ts";
import { DiscServer } from "./server/disc-server.ts";

const server = new DiscServer({
  // ... config
  extensions: [
    new MyExtension()
  ]
});
```

Or register at runtime via the extension registry:

```typescript
import { ExtensionRegistry } from "./extensions/registry.ts";

const registry = new ExtensionRegistry();
registry.register(new MyExtension());

// Initialize all registered extensions
await registry.initializeAll(extensionContext);

// Get all registered functions for the compiler
const functions = registry.getAllFunctions();

// Get all routes for the HTTP server
const routes = registry.getAllRoutes();
```

### Error Handling

The extension system provides specific error classes:

```typescript
import {
  ExtensionConfigError,
  ExtensionDependencyError,
  ExtensionError,
  ExtensionInitError
} from "./extensions/errors.ts";

// General extension error
throw new ExtensionError("my-extension", "Something went wrong");

// Initialization failure
throw new ExtensionInitError(
  "my-extension",
  "Cannot connect to external service"
);

// Missing dependencies
throw new ExtensionDependencyError("my-extension", ["vector", "fts"]);

// Invalid configuration
throw new ExtensionConfigError("my-extension", "apiKey is required");
```

All extension errors include the extension name for clear error reporting.

---

## Related

- [Authentication](auth.md) -- built-in auth system (also available as an extension adapter)
- [Access Policies](access-policies.md) -- row-level security (also available as an extension adapter)
- [EdgeQL Functions](functions.md) -- built-in function reference
- [Server Configuration](server.md) -- server startup and extension loading
