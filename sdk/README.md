# SDK

TypeScript client SDK for consuming Disc from applications. Provides a typed HTTP client, a codegen-free query builder, an authentication manager, transaction support, and WebSocket-based subscriptions.

## Import

```typescript
import {
  and,
  AuthManager,
  createClient,
  createQueryBuilder,
  createSubscriptionClient,
  defineSchema,
  DiscClient,
  from,
  not,
  or,
  SubscriptionClient,
  t,
  Transaction
} from "disc/sdk/mod.ts";

// Wire-format codecs
import {
  encodeBytes,
  parseBytes,
  parseDateTime,
  parseInt64,
  reviveResponse
} from "disc/sdk/mod.ts";

// Errors -- all extend DiscClientError
import {
  DiscErrorCode,
  DiscQueryError,
  DiscValidationError
} from "disc/sdk/mod.ts";
```

## DiscClient

The core HTTP client for querying a Disc server. Handles request timeouts, retries with exponential backoff, auth token injection, and HTTP error classification.

### Configuration

```typescript
import type { DiscClientConfig } from "disc/sdk/mod.ts";

const client = createClient({
  baseUrl: "http://localhost:5656", // see resolution order below
  timeout: 30000, // request timeout in ms (default: 30000)
  headers: { "X-Custom": "value" }, // custom headers on every request
  retries: 3, // retry count on network/server errors (default: 0)
  retryDelay: 1000 // base delay between retries in ms (default: 1000)
});
```

`baseUrl` is resolved in this order, first hit wins:

1. `config.baseUrl`
2. The `DISC_SERVER_URL` environment variable -- works on any runtime, and the robust choice for deployed servers where cwd and filesystem permissions are unpredictable
3. A `disc.toml` walked up from the cwd, deriving the URL from its `[server]` host/port. Deno-only (needs sync filesystem access) and requires `--allow-read`; a permission failure is reported through `config.logger.warn` rather than swallowed, since a silent fallback to localhost is the hard case to diagnose
4. `http://localhost:5656`

In a project with a `disc.toml`, `createClient()` with no arguments connects to that project's server.

### Querying

```typescript
// Returns data directly, throws DiscQueryError on server errors.
// NOTE: the <User[]> generic is an unchecked cast — see "Runtime validation".
const users = await client.query<User[]>("select User { name, email }");

// Returns the full response envelope (data, errors, extensions)
const response = await client.queryRaw<User[]>("select User { name, email }");
if (response.errors) {
  console.log(response.errors);
}
console.log(response.extensions?.parseMs);
```

### Runtime validation

`query<T>()` and `tx.query<T>()` accept an `options.validate` argument that
runs against `response.data` before returning. It accepts either a plain
function (`(value) => T`) or any [Standard Schema](https://standardschema.dev)
— Zod 3.24+, Valibot, ArkType, Effect Schema, etc. all conform without
adapters. On rejection a `DiscValidationError` is thrown with structured
issues.

```typescript
import { z } from "zod";

const User = z.object({ name: z.string(), email: z.string().email() });

// Standard Schema — works with Zod, Valibot, ArkType, Effect Schema, …
const user = await client.query(
  "select User { name, email } limit 1",
  undefined,
  { validate: User }
);

// Plain function — useful for cheap shape checks or transforms
const ids = await client.query(
  "select User.id",
  undefined,
  {
    validate: v => {
      if (!Array.isArray(v))
        throw new Error("expected array");
      return v as string[];
    }
  }
);
```

If you omit `validate`, the SDK falls back to the legacy unchecked cast
(fast, but typos and upstream schema drift surface at runtime). For
codegen-driven type safety where the _query itself_ is checked against
your SDL, run `disc codegen`.

### Serialization

Server responses are JSON, so several EdgeQL types arrive as strings: `datetime` as ISO-8601, `int64` / `bigint` as numeric strings, and `bytes` as base64. Pass `options.revive` to convert them back:

```typescript
// Revive Date and bigint automatically
const posts = await client.query("select Post { title, created }", undefined, {
  revive: true
});

// Or opt into a subset
const rows = await client.query("select Post { created }", undefined, {
  revive: { bigints: false, dates: true }
});
```

Revival is deliberately conservative: only ISO-8601 strings with a time component become `Date`, and only numeric strings outside `Number.MAX_SAFE_INTEGER` become `bigint`. `bytes` is never auto-revived -- base64 collides with ordinary text too often -- so decode those at the call site.

`revive` runs _before_ `validate`, so validators see real `Date` and `bigint` values.

For per-field control, the codecs are exported directly:

```typescript
import {
  encodeBytes,
  parseBytes,
  parseDateTime,
  parseInt64
} from "disc/sdk/mod.ts";

parseDateTime("2026-09-16T12:00:00Z"); // Date | undefined
parseInt64("9007199254740993"); // bigint | undefined
parseBytes("aGVsbG8="); // Uint8Array | undefined

// Outbound: encode binary for a query variable
await client.query("insert Blob { data := <bytes>$data }", {
  data: encodeBytes(buffer)
});
```

Each parser returns `undefined` rather than throwing when the input doesn't match the expected wire format. Outbound `bigint` variables are serialized automatically by `jsonReplacer`, which the client already applies to every request body.

### Schema Drift Detection

A generated client carries the schema epoch it was built against and sends it as the `X-Disc-Expected-Schema` request header. When the server's schema has moved, it answers with `X-Disc-Schema-Mismatch` (`none`, `compatible`, or `breaking`) plus `X-Disc-Schema-Version`, and the client surfaces the verdict:

```typescript
const client = createClient({
  logger: {
    warn: (msg, details) => console.warn(msg, details),
    error: (msg, details) => console.error(msg, details)
  },
  onSchemaMismatch: info => {
    // info.status: "compatible" | "breaking" | "unknown"
    // info.serverVersion, info.clientEpoch
    metrics.increment("disc.schema_drift", { status: info.status });
  },
  schemaEpoch: "2026-09-16T00:00:00Z" // normally set by the generated subclass
});
```

`compatible` and `breaking` emit a `logger.warn` describing what to do; `unknown` does not. The `onSchemaMismatch` callback fires for every non-`none` status, in addition to the log line. The `logger` is also used for retry attempts (`warn`), final failures (`error`), and `baseUrl` resolution problems.

### Health and Stats

```typescript
// Full health check (status, database, pool)
const health = await client.health();
// health.status: "healthy" | "degraded" | "unhealthy"

// Liveness probe (returns boolean)
const alive = await client.isAlive();

// Readiness probe (returns boolean)
const ready = await client.isReady();

// Server statistics (connections, queries, transactions, memory, cache)
const stats = await client.stats();
```

### Auth Token Management

```typescript
client.setAuthToken("jwt-token-here");
client.getAuthToken(); // "jwt-token-here" | undefined
client.clearAuthToken();
```

## Query Builder

A codegen-free runtime DSL that builds EdgeQL from a chainable builder. It never talks to the network itself -- it compiles to a `{ query, variables }` pair that goes through the same `client.query()` pipeline as raw EdgeQL, so access policies, read-only mode, the auth gate, and server-side validators all still apply.

Use `from()` to compile without a client:

```typescript
import { from } from "disc/sdk/mod.ts";

const compiled = from("User")
  .select({ email: true, posts: { title: true } })
  .filter(u => u.email.eq("ada@example.com"))
  .toEdgeQL();

// compiled.query     → "select User { email, posts: { title } } filter .email = <str>$p0"
// compiled.variables → { p0: "ada@example.com" }
```

Or bind a client and await the chain directly:

```typescript
import { createQueryBuilder } from "disc/sdk/mod.ts";

const qb = createQueryBuilder(client);

const users = await qb
  .User
  .select({ id: true, email: true })
  .filter(u => u.active.eq(true))
  .orderBy(u => u.name.desc())
  .limit(10);

// first() adds `limit 1` and unwraps to a single row or null
const ada = await qb
  .User
  .select({ id: true })
  .filter(u => u.email.eq("ada@example.com"))
  .first();
```

Chain methods: `select(shape)`, `filter(predicate)`, `orderBy(fn)`, `limit(n)`, `offset(n)`, `toEdgeQL()`, `run(options?)`, `first(options?)`. The chain is `PromiseLike`, so `await chain` is sugar for `chain.run()`, and `run()` / `first()` forward `QueryOptions` (`validate`, `revive`) to the client. Repeated `filter()` calls are ANDed together. Field comparisons are `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, and `exists`; ordering uses `field.asc()` / `field.desc()` or a bare field reference.

Type names and shape keys are validated as identifiers when you build the chain, so injection-shaped input fails immediately rather than reaching the server. Every compared value is bound as a parameter with an inferred cast, never interpolated.

### Typed Builder

`defineSchema()` re-declares your schema in TypeScript so the builder can infer row types from the requested shape, with no codegen step. The schema of record stays in `.disc` -- this is a thin companion file, hand-written or generated once and committed.

```typescript
import { createQueryBuilder, defineSchema, t } from "disc/sdk/mod.ts";

const schema = defineSchema({
  User: {
    email: t.str(),
    name: t.str(),
    active: t.bool(),
    bio: t.optional(t.str()),
    posts: t.multi("Post")
  },
  Post: {
    title: t.str(),
    score: t.int64(),
    author: t.single("User")
  }
});

const qb = createQueryBuilder(client, schema);

// Row type is narrowed to { email: string; posts: { title: string }[] }
const rows = await qb.User.select({ email: true, posts: { title: true } });
```

Markers: `t.str()`, `t.bool()`, `t.int16/int32/int64()`, `t.float32/float64()`, `t.bigint()`, `t.datetime()`, `t.bytes()`, `t.uuid()`, `t.json()`, plus `t.optional(inner)`, `t.single(Target)`, and `t.multi(Target)`.

With a schema attached, `qb.Typo` throws at property access with the list of declared types, instead of sending a doomed query. `defineSchema()` itself rejects non-PascalCase type names and malformed field names at call time.

### Combinators

`and`, `or`, and `not` accept either runtime-DSL expressions or codegen `Filter` objects, so they work with both query paths:

```typescript
import { and, not, or } from "disc/sdk/mod.ts";

// With the runtime DSL
await qb.User.select({ id: true }).filter(u =>
  or(u.email.eq("a@b.c"), u.name.eq("Ada"))
);

// With a generated client's filter()
await client.user.filter(and({ active: true }, not({ name: "Ada" })));
```

Note that the runtime DSL's own compiler only understands `Expr` children -- handing it a plain Filter object throws. The codegen filter compiler understands both forms.

### Generated-Client Internals

`compileFilter()`, its `TypeInfo` / `CompiledFilter` types, and `escapeEdgeQLIdent()` are exported for the generated query builders, which import them from the SDK copy that `disc codegen` materializes. Application code rarely calls them directly; see `codegen/README.md` for the filter-object format they consume.

## AuthManager

Manages the full authentication lifecycle: login, registration, logout, token refresh, and profile retrieval. Automatically refreshes tokens before expiry when `autoRefresh` is enabled.

```typescript
import { AuthManager } from "disc/sdk/mod.ts";
import type { AuthManagerOptions } from "disc/sdk/mod.ts";

const auth = new AuthManager(client, {
  autoRefresh: true, // default: true
  refreshBuffer: 60 // seconds before expiry to trigger refresh (default: 60)
});
```

### Registration and Login

```typescript
// Register a new user
const response = await auth.register({
  email: "ada@example.com",
  password: "secure-password",
  username: "ada", // optional
  metadata: { role: "admin" } // optional
});
// response.user, response.token, response.session

// Login with email or username
const loginResponse = await auth.login({
  email: "ada@example.com",
  password: "secure-password"
});

// Check authentication state
auth.isAuthenticated(); // true
auth.getUser(); // cached AuthUser from last login/register
```

### Token Refresh and Profile

```typescript
// Manual token refresh
const tokens = await auth.refreshTokens();

// Fetch profile from server
const profile = await auth.getProfile();

// Update password
await auth.updatePassword("old-password", "new-password");
```

### Logout and Cleanup

```typescript
await auth.logout(); // POST /auth/logout, clears local state
auth.dispose(); // cancel any pending auto-refresh timer
```

## Transaction

Execute multiple queries atomically using a callback pattern. The transaction auto-commits on success and auto-rolls back on error.

```typescript
const result = await client.transaction(async tx => {
  const user = await tx.query<User>(
    "insert User { name := <str>$name, email := <str>$email }",
    { name: "Billie", email: "billie@example.com" }
  );

  await tx.query(
    "insert Post { title := <str>$title, author := (select User filter .id = <uuid>$id) }",
    { title: "Hello World", id: user.id }
  );

  return user;
});
```

### Transaction State Machine

A `Transaction` moves through these states:

| State         | Description                        |
| ------------- | ---------------------------------- |
| `active`      | Queries can be executed            |
| `committed`   | Transaction committed successfully |
| `rolled_back` | Transaction was rolled back        |

Attempting to query, commit, or rollback a non-active transaction throws `DiscTransactionError`.

```typescript
tx.getState(); // "active" | "committed" | "rolled_back"
tx.getId(); // transaction ID string
```

## SubscriptionClient

WebSocket-based client for real-time subscriptions. Supports auto-reconnect with exponential backoff and automatic re-subscription after reconnection.

### Configuration and Connection

```typescript
import { createSubscriptionClient } from "disc/sdk/mod.ts";
import type { SubscriptionClientConfig } from "disc/sdk/mod.ts";

const sub = createSubscriptionClient(
  { baseUrl: "http://localhost:5656" },
  {
    autoReconnect: true, // default: true
    maxReconnectAttempts: 5, // default: 5
    reconnectDelay: 1000 // base delay in ms (default: 1000)
  }
);

await sub.connect(); // optional arg: connect timeout in ms (default: 30000)
```

### Subscribing

```typescript
const handle = sub.subscribe<User>(
  "select User { name, email }",
  {
    onData: data => console.log("Update:", data),
    onError: err => console.error("Error:", err), // optional
    onComplete: () => console.log("Stream ended") // optional
  },
  { filter: "active" } // optional variables
);

// Unsubscribe
handle.unsubscribe();

// Or by ID
sub.unsubscribe(handle.id);
```

### Connection Management

```typescript
sub.isConnected(); // true when WebSocket is OPEN
sub.close(); // close connection and clean up all subscriptions
```

## Error Hierarchy

All SDK errors extend `DiscClientError`, which carries a `code` from `DiscErrorCode`.

| Error Class            | Code                | When                                   |
| ---------------------- | ------------------- | -------------------------------------- |
| `DiscQueryError`       | `QUERY_ERROR`       | Server returns query errors            |
| `DiscNetworkError`     | `NETWORK_ERROR`     | Fetch failure, DNS resolution error    |
| `DiscTimeoutError`     | `TIMEOUT`           | Request exceeds configured timeout     |
| `DiscAuthError`        | `AUTH_ERROR`        | 401/403 response or missing token      |
| `DiscConnectionError`  | `CONNECTION_ERROR`  | Server unreachable, connection refused |
| `DiscTransactionError` | `TRANSACTION_ERROR` | Operation on non-active transaction    |
| `DiscProtocolError`    | `PROTOCOL_ERROR`    | Unexpected response format             |
| `DiscServerError`      | `SERVER_ERROR`      | 5xx response from server               |
| `DiscValidationError`  | `VALIDATION_ERROR`  | `options.validate` rejected the data   |

`DiscValidationError` carries an `issues` array (`StandardSchemaIssue[]`) describing what failed, and an optional `cause` when the validator threw.

```typescript
import { DiscErrorCode, DiscQueryError } from "disc/sdk/mod.ts";

try {
  await client.query("invalid query");
} catch (err) {
  if (err instanceof DiscQueryError) {
    console.log(err.code); // DiscErrorCode.QUERY_ERROR
    console.log(err.errors); // QueryError[] from server
  }
}
```

### Retry Behavior

- `DiscServerError` (5xx) and connection failures (`DiscConnectionError`, raised when `fetch` itself throws) are retried up to `retries` times with exponential backoff and ±25% jitter: `retryDelay * 2^attempt`, multiplied by a random factor in [0.75, 1.25]. The jitter prevents a thundering herd when many clients retry in lockstep after a shared outage.
- `DiscAuthError`, `DiscQueryError`, and `DiscProtocolError` are never retried.
- `DiscTimeoutError` is thrown immediately without retry.
- Unclassified failures become `DiscNetworkError` and are retried with linear backoff (`retryDelay * (attempt + 1)`).

## Types

Key type exports from `sdk/types.ts`:

| Type                       | Description                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DiscClientConfig`         | Client constructor options                                                                                                        |
| `QueryRequest`             | Query payload (query, variables, operationName)                                                                                   |
| `QueryResponse<T>`         | Response envelope (data, errors, extensions)                                                                                      |
| `QueryExtensions`          | Timing info (parseMs, compileMs, executeMs)                                                                                       |
| `HealthStatus`             | Server health (status, database, pool)                                                                                            |
| `ServerStats`              | Connections, queries, transactions, memory, cache                                                                                 |
| `AuthTokens`               | JWT token and optional refresh token                                                                                              |
| `AuthUser`                 | User profile (id, email, username, metadata)                                                                                      |
| `AuthResponse`             | Login/register response (user, session, token)                                                                                    |
| `LoginCredentials`         | Email/username + password                                                                                                         |
| `RegisterData`             | Email, password, optional username/metadata                                                                                       |
| `TransactionState`         | "active", "committed", "rolled_back"                                                                                              |
| `SubscriptionCallbacks<T>` | onData, onError, onComplete handlers                                                                                              |
| `SubscriptionHandle`       | Subscription id + unsubscribe function                                                                                            |
| `IsolationLevel`           | "read_committed", "repeatable_read", "serializable" -- exported but not yet consumed; `transaction()` takes no isolation argument |
| `QueryOptions<T>`          | Per-query `validate` / `revive` options                                                                                           |
| `QueryValidator<T>`        | A `(data) => T` function or any Standard Schema                                                                                   |
| `StandardSchemaV1`         | Minimal Standard Schema v1 surface the SDK accepts                                                                                |
| `StandardSchemaIssue`      | One validation failure, as carried on `DiscValidationError.issues`                                                                |
| `QueryError`               | A single server-reported query error                                                                                              |
| `CacheStats`               | Cache section of `ServerStats`                                                                                                    |
| `AuthManagerOptions`       | autoRefresh, refreshBuffer                                                                                                        |
| `SubscriptionClientConfig` | autoReconnect, maxReconnectAttempts, reconnectDelay                                                                               |

From `sdk/codecs.ts`, `sdk/query-builder.ts`, `sdk/schema-types.ts`, and `sdk/filter-compiler.ts`:

| Type                   | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `ReviveOptions`        | Which wire formats `revive` converts (dates, bigints)            |
| `CompiledQuery`        | `{ query, variables }` produced by `toEdgeQL()`                  |
| `Expr`                 | A boolean expression node from a comparison or combinator        |
| `FilterArg<T>`         | `Expr \| T` -- what `and` / `or` / `not` and `filter()` accept   |
| `Shape`                | Recursive select shape (`true` or a nested shape)                |
| `QueryRunner`          | Minimal client surface the builder needs                         |
| `QueryBuilder`         | Untyped `createQueryBuilder()` proxy                             |
| `TypedQueryBuilder<S>` | Schema-driven proxy with inferred row types                      |
| `DiscSchema<S>`        | Output of `defineSchema()`                                       |
| `SchemaSpec`           | The raw type-to-fields map a `DiscSchema` wraps                  |
| `ResolveSelected`      | Row type inferred from a schema plus a select shape              |
| `TypeInfo`             | Per-type casts/links a generated builder hands `compileFilter()` |
