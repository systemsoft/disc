# Client SDK

The Disc TypeScript SDK provides a typed HTTP client for querying a Disc server, managing authentication, executing transactions, and subscribing to real-time updates over WebSocket.

---

## Installation

Import from the SDK module directly:

```typescript
import {
  AuthManager,
  createClient,
  createSubscriptionClient,
  DiscClient,
} from "disc/sdk/mod.ts";
```

If you have generated a typed client with `disc codegen`, you can import the generated types alongside the SDK:

```typescript
import { createClient } from "disc/sdk/mod.ts";
import type { Post, User } from "./dbschema/disc-client/interfaces.ts";
```

---

## Creating a Client

Use `createClient()` to construct a `DiscClient` instance. All options are optional and have sensible defaults.

```typescript
import { createClient } from "disc/sdk/mod.ts";

const client = createClient({
  baseUrl: "http://localhost:5656",
  headers: { "X-Custom-Header": "value" },
  retries: 3,
  retryDelay: 1000,
  timeout: 30000,
});
```

### Configuration Options

| Option       | Type                     | Default                   | Description                                                 |
| ------------ | ------------------------ | ------------------------- | ----------------------------------------------------------- |
| `baseUrl`    | `string`                 | `"http://localhost:5656"` | URL of the Disc server                                      |
| `headers`    | `Record<string, string>` | `{}`                      | Custom headers included with every request                  |
| `retries`    | `number`                 | `0`                       | Number of retries on network or server errors               |
| `retryDelay` | `number`                 | `1000`                    | Base delay between retries in milliseconds (linear backoff) |
| `timeout`    | `number`                 | `30000`                   | Request timeout in milliseconds                             |

The `DiscClient` class can also be instantiated directly if you prefer:

```typescript
import { DiscClient } from "disc/sdk/mod.ts";

const client = new DiscClient({ baseUrl: "https://disc.example.com" });
```

---

## Basic Queries

### `client.query<T>(query, variables?)`

Executes an EdgeQL query and returns the result data directly. Throws `DiscQueryError` if the server returns any errors.

```typescript
// Select all users
const users = await client.query<User[]>("select User { email, name }");

// Select with variables
const user = await client.query<User>(
  `select User { email, name }
   filter .email = <str>$email`,
  { email: "ada@example.com" },
);

// Insert
const newUser = await client.query<User>(
  `insert User {
    email := <str>$email,
    name := <str>$name
  }`,
  { email: "billie@example.com", name: "Billie" },
);

// Update
await client.query(
  `update User
   filter .email = <str>$email
   set { name := <str>$name }`,
  { email: "billie@example.com", name: "Robert" },
);

// Delete
await client.query(
  `delete User filter .email = <str>$email`,
  { email: "billie@example.com" },
);
```

### `client.queryRaw<T>(query, variables?)`

Returns the full response envelope including data, errors, and timing extensions. Does not throw on query errors -- you must check `response.errors` yourself.

```typescript
const response = await client.queryRaw<User[]>("select User { email, name }");

if (response.errors && response.errors.length > 0) {
  for (const err of response.errors) {
    console.error(err.message, err.extensions);
  }
} else {
  console.log(response.data);
}

// Access timing information
console.log(response.extensions?.parseMs);
console.log(response.extensions?.compileMs);
console.log(response.extensions?.executeMs);
console.log(response.extensions?.cacheHit);
```

### Response Envelope

The `QueryResponse<T>` type has this shape:

```typescript
interface QueryResponse<T = unknown> {
  data?: T;
  errors?: QueryError[];
  extensions?: QueryExtensions;
}

interface QueryError {
  extensions?: Record<string, unknown>;
  locations?: Array<{ column: number; line: number; }>;
  message: string;
  path?: Array<string | number>;
}

interface QueryExtensions {
  cacheHit?: boolean;
  compileMs?: number;
  executeMs?: number;
  parseMs?: number;
  [key: string]: unknown;
}
```

---

## Health Checks

The SDK provides three methods for checking server health, suitable for orchestration systems and monitoring.

### `client.health()`

Returns the full health status including database connectivity, connection pool stats, uptime, and extension health.

```typescript
const health = await client.health();
// health.database?.connected: boolean
// health.database?.latencyMs: number
// health.pool?.active: number
// health.pool?.idle: number
// health.status: "healthy" | "degraded" | "unhealthy"
// health.uptimeMs: number
```

### `client.isAlive()`

Liveness probe. Returns `true` if the server process is running. Never throws -- returns `false` on any error.

```typescript
const alive = await client.isAlive();
```

### `client.isReady()`

Readiness probe. Returns `true` when the database is connected and the server can accept queries. Returns `false` if the database is unreachable.

```typescript
const ready = await client.isReady();
```

---

## Server Stats

### `client.stats()`

Returns detailed server statistics including connection counts, query metrics, transaction counts, memory usage, cache stats, and rate limiter info.

```typescript
const stats = await client.stats();

console.log("Active connections:", stats.connections.active);
console.log("Total queries:", stats.queries.total);
console.log("Failed queries:", stats.queries.failed);
console.log("Avg query duration:", stats.queries.avgDurationMs, "ms");
console.log("Active transactions:", stats.transactions.active);
console.log("Heap used:", stats.memoryUsage.heapUsed);
console.log("Uptime:", stats.uptimeMs, "ms");

// Cache stats (when available)
if (stats.cache) {
  console.log("Compilation cache hit rate:", stats.cache.compilation.hitRate);
  console.log("Parse cache size:", stats.cache.parse.size);
}

// Query performance metrics
if (stats.queryMetrics) {
  console.log("Avg parse time:", stats.queryMetrics.avgParseMs, "ms");
  console.log("Avg compile time:", stats.queryMetrics.avgCompileMs, "ms");
  console.log("Avg execute time:", stats.queryMetrics.avgExecuteMs, "ms");
  console.log("Cache hit rate:", stats.queryMetrics.cacheHitRate);
}
```

---

## Authentication

The `AuthManager` class handles the full authentication lifecycle: registration, login, logout, token refresh, and profile management. It wraps a `DiscClient` and automatically sets the JWT token on the client after successful authentication.

### Setup

```typescript
import { AuthManager, createClient } from "disc/sdk/mod.ts";

const client = createClient({ baseUrl: "http://localhost:5656" });

const auth = new AuthManager(client, {
  autoRefresh: true, // automatically refresh tokens before expiry (default: true)
  refreshBuffer: 60, // seconds before expiry to trigger refresh (default: 60)
});
```

### Registration

```typescript
const response = await auth.register({
  email: "ada@example.com",
  metadata: { department: "engineering" }, // optional
  password: "secure-password-123",
  username: "ada", // optional
});

// response contains:
// - response.refreshToken: refresh token (optional)
// - response.session: session details (id, userId, expiresAt)
// - response.token: JWT access token
// - response.user: AuthUser object
```

After registration, the client is automatically authenticated. All subsequent queries include the JWT token.

### Login

```typescript
// Login with email
const response = await auth.login({
  email: "ada@example.com",
  password: "secure-password-123",
});

// Login with username
const response = await auth.login({
  password: "secure-password-123",
  username: "ada",
});
```

### Checking Authentication State

```typescript
auth.isAuthenticated(); // true if a token is set on the client
auth.getUser(); // cached AuthUser from the last login/register call
```

`getUser()` returns the user from the most recent successful `login()` or `register()` call without making a server request. Returns `null` if no session is active.

### Fetching the Profile

```typescript
const profile = await auth.getProfile();
// profile.email, profile.id, profile.username
// profile.createdAt, profile.updatedAt
// profile.active, profile.emailVerified
// profile.metadata
```

`getProfile()` makes a `GET /auth/profile` request and updates the cached user.

### Updating the Password

```typescript
await auth.updatePassword("old-password", "new-password");
```

Throws `DiscAuthError` if not authenticated.

### Token Refresh

When `autoRefresh` is enabled (the default), the `AuthManager` parses the JWT `exp` claim and schedules a background refresh `refreshBuffer` seconds before the token expires. This happens automatically -- you do not need to call `refreshTokens()` manually.

To refresh manually:

```typescript
const tokens = await auth.refreshTokens();
// tokens.refreshToken: new refresh token (if issued)
// tokens.token: new JWT access token
```

Throws `DiscAuthError` if no refresh token is available.

### Logout

```typescript
await auth.logout();
```

This sends a `POST /auth/logout` request, then clears all local state: tokens, cached user, and the auth header on the client.

### Cleanup

When you are done with the `AuthManager`, call `dispose()` to cancel any pending auto-refresh timer:

```typescript
auth.dispose();
```

This is important in environments where timers would prevent garbage collection or process exit.

---

## Transactions

Transactions execute multiple queries atomically. The SDK uses a callback pattern: the transaction auto-commits on success and auto-rolls back on error.

### Basic Usage

```typescript
const result = await client.transaction(async (tx) => {
  const user = await tx.query<User>(
    `insert User { email := <str>$email, name := <str>$name }`,
    { email: "cher@example.com", name: "Cher" },
  );

  await tx.query(
    `insert Post {
      author := (select User filter .id = <uuid>$userId),
      body := <str>$body,
      title := <str>$title
    }`,
    { body: "Written atomically.", title: "First Post", userId: user.id },
  );

  return user;
});
```

If the callback throws, the transaction is automatically rolled back and the error is re-thrown.

### Transaction Methods

Inside the callback, the `tx` object provides:

| Method                           | Description                                           |
| -------------------------------- | ----------------------------------------------------- |
| `tx.query<T>(query, variables?)` | Execute a query within the transaction                |
| `tx.commit()`                    | Explicitly commit (usually unnecessary)               |
| `tx.rollback()`                  | Explicitly roll back                                  |
| `tx.getState()`                  | Returns `"active"`, `"committed"`, or `"rolled_back"` |
| `tx.getId()`                     | Returns the transaction ID string                     |

You do not need to call `tx.commit()` explicitly. The `client.transaction()` wrapper commits automatically when the callback returns without throwing. Explicit commit and rollback are available for advanced control flows.

### Transaction State Machine

A `Transaction` transitions through these states:

```
active  -->  committed
   |
   +---->  rolled_back
```

Calling `query()`, `commit()`, or `rollback()` on a non-active transaction throws `DiscTransactionError`.

### How It Works

Under the hood, `client.transaction()` performs these steps:

1. `POST /transaction/begin` -- server allocates a transaction and returns a `transactionId`.
2. Each `tx.query()` sends a `POST /query` with an `X-Transaction-ID` header linking the query to the transaction.
3. On callback success: `POST /transaction/{id}/commit`.
4. On callback error: `POST /transaction/{id}/rollback`, then re-throws.

---

## WebSocket Subscriptions

The `SubscriptionClient` provides real-time data streaming over WebSocket. It supports automatic reconnection with exponential backoff and re-subscribes to all active subscriptions after reconnection.

### Setup and Connection

```typescript
import { createSubscriptionClient } from "disc/sdk/mod.ts";

const sub = createSubscriptionClient(
  { baseUrl: "http://localhost:5656" },
  {
    autoReconnect: true, // reconnect on disconnect (default: true)
    maxReconnectAttempts: 5, // max reconnect attempts (default: 5)
    reconnectDelay: 1000, // base delay in ms (default: 1000)
  },
);

await sub.connect();
```

The `SubscriptionClient` automatically converts `http://` to `ws://` and `https://` to `wss://` when connecting.

### Subscribing to Queries

```typescript
const handle = sub.subscribe<User[]>(
  "select User { email, name, posts: { title } }",
  {
    onComplete: () => {
      console.log("Subscription stream ended");
    },
    onData: (data) => {
      console.log("Received update:", data);
    },
    onError: (error) => {
      console.error("Subscription error:", error.message);
    },
  },
  { status: "active" }, // optional variables
);
```

The `subscribe()` method returns a `SubscriptionHandle`:

```typescript
interface SubscriptionHandle {
  id: string; // unique subscription ID
  unsubscribe: () => void; // unsubscribe from this subscription
}
```

### Unsubscribing

```typescript
// Via the handle
handle.unsubscribe();

// Or by ID
sub.unsubscribe(handle.id);
```

### Connection Management

```typescript
sub.isConnected(); // true when WebSocket is in OPEN state
sub.close(); // close the connection and clean up all subscriptions
```

Calling `close()` prevents any further reconnection attempts.

### Auto-Reconnection

When the WebSocket connection drops and `autoReconnect` is `true`, the client automatically:

1. Waits with exponential backoff: `reconnectDelay * 2^attempt` milliseconds.
2. Reconnects to the server.
3. Re-subscribes to all active subscriptions.

If reconnection fails after `maxReconnectAttempts`, all active subscriptions receive an error via their `onError` callback.

### Subscription Client Config

| Option                 | Type      | Default | Description                                 |
| ---------------------- | --------- | ------- | ------------------------------------------- |
| `autoReconnect`        | `boolean` | `true`  | Reconnect automatically on disconnect       |
| `maxReconnectAttempts` | `number`  | `5`     | Maximum reconnect attempts before giving up |
| `reconnectDelay`       | `number`  | `1000`  | Base delay between reconnect attempts (ms)  |

---

## Error Handling

All SDK errors extend `DiscClientError`, which carries a `code` property from the `DiscErrorCode` enum.

### Error Hierarchy

| Error Class            | Code                | Thrown When                                         |
| ---------------------- | ------------------- | --------------------------------------------------- |
| `DiscAuthError`        | `AUTH_ERROR`        | 401 or 403 response, missing token, expired session |
| `DiscClientError`      | (varies)            | Base class for all SDK errors                       |
| `DiscConnectionError`  | `CONNECTION_ERROR`  | Server unreachable, connection refused              |
| `DiscNetworkError`     | `NETWORK_ERROR`     | Fetch failed, DNS resolution error                  |
| `DiscProtocolError`    | `PROTOCOL_ERROR`    | Server returned an unexpected response format       |
| `DiscQueryError`       | `QUERY_ERROR`       | Server returns one or more query errors             |
| `DiscServerError`      | `SERVER_ERROR`      | Server returned a 5xx status code                   |
| `DiscTimeoutError`     | `TIMEOUT`           | Request exceeds the configured timeout              |
| `DiscTransactionError` | `TRANSACTION_ERROR` | Operation on a non-active transaction               |

### Catching Specific Errors

```typescript
import {
  DiscAuthError,
  DiscConnectionError,
  DiscErrorCode,
  DiscQueryError,
  DiscServerError,
  DiscTimeoutError,
} from "disc/sdk/mod.ts";

try {
  const users = await client.query("select User { email, name }");
} catch (error) {
  if (error instanceof DiscQueryError) {
    // Query syntax or execution error
    console.error("Query failed:", error.message);

    for (const qe of error.errors) {
      console.error("  -", qe.message, qe.extensions);
    }
  } else if (error instanceof DiscTimeoutError) {
    // Request took too long
    console.error(`Timed out after ${error.timeoutMs}ms`);
  } else if (error instanceof DiscAuthError) {
    // Authentication failure
    console.error(`Auth error (HTTP ${error.statusCode}):`, error.message);
  } else if (error instanceof DiscConnectionError) {
    // Server unreachable
    console.error("Connection failed:", error.message);
  } else if (error instanceof DiscServerError) {
    // 5xx server error
    console.error(`Server error (HTTP ${error.statusCode}):`, error.message);
  }
}
```

### Using Error Codes

Every SDK error has a `code` property from the `DiscErrorCode` enum:

```typescript
import { DiscClientError, DiscErrorCode } from "disc/sdk/mod.ts";

try {
  await client.query("bad query");
} catch (error) {
  if (error instanceof DiscClientError) {
    switch (error.code) {
      case DiscErrorCode.AUTH_ERROR: {
        // handle auth error
        break;
      }

      case DiscErrorCode.CONNECTION_ERROR: {
        // handle connection error
        break;
      }

      case DiscErrorCode.NETWORK_ERROR: {
        // handle network error
        break;
      }

      case DiscErrorCode.PROTOCOL_ERROR: {
        // handle protocol error
        break;
      }

      case DiscErrorCode.QUERY_ERROR: {
        // handle query error
        break;
      }

      case DiscErrorCode.SERVER_ERROR: {
        // handle server error
        break;
      }

      case DiscErrorCode.TIMEOUT: {
        // handle timeout
        break;
      }

      case DiscErrorCode.TRANSACTION_ERROR: {
        // handle transaction error
        break;
      }
    }
  }
}
```

### Retry Behavior

The client retries requests based on the error type:

| Error Type              | Retried? | Notes                                                |
| ----------------------- | -------- | ---------------------------------------------------- |
| `DiscAuthError`         | No       | 401/403 will not succeed on retry                    |
| `DiscConnectionError`   | Yes      | Network-level failures are retried                   |
| `DiscNetworkError`      | Yes      | General fetch failures are retried                   |
| `DiscProtocolError`     | No       | Response format issues are not transient             |
| `DiscQueryError`        | No       | Query errors are deterministic                       |
| `DiscServerError` (5xx) | Yes      | Retried with linear backoff (`retryDelay * attempt`) |
| `DiscTimeoutError`      | No       | Thrown immediately, not retried                      |

---

## Multi-Database

When the server has multi-database support enabled, you can target a specific database by passing a custom header or by including a query parameter.

### Via Custom Headers

```typescript
const client = createClient({
  baseUrl: "http://localhost:5656",
  headers: { "X-Database": "analytics" },
});

const data = await client.query("select Event { name, timestamp }");
```

### Per-Request Override

If you need to query different databases from the same client, set the header on individual requests by using `queryRaw` with the underlying fetch:

```typescript
// Default database
const users = await client.query("select User { name }");

// Different database via a second client
const analyticsClient = createClient({
  baseUrl: "http://localhost:5656",
  headers: { "X-Database": "analytics" },
});

const events = await analyticsClient.query("select Event { name }");
```

The server resolves the database name in this order:

1. `X-Database` header
2. `?database=` query parameter
3. Default: `"disc"`

---

## Codegen-free query builder

A runtime DSL that gives the same end-to-end type safety as [`disc codegen`](codegen.md) without producing any generated files. Useful when CI shouldn't carry a codegen step or when the schema lives in TypeScript next to the application code.

### Declare the schema in TypeScript

`defineSchema()` accepts a record of type definitions; field markers come from the `t.*` namespace:

```typescript
import { defineSchema, t } from "disc/sdk/mod.ts";

export const schema = defineSchema({
  User: {
    email: t.str(),
    name: t.optional(t.str()),
    score: t.int64(),
    posts: t.multi("Post"),
  },
  Post: {
    title: t.str(),
    body: t.optional(t.str()),
    author: t.single("User"),
  },
});
```

The `t.*` markers carry compile-time type information; `defineSchema()` validates at construction (PascalCase type names, valid field names, link targets that resolve to defined types) and throws synchronously on misuse.

### Build typed queries

`createQueryBuilder(client, schema)` returns a Proxy where each property is a typed selection chain:

```typescript
import { createClient, createQueryBuilder } from "disc/sdk/mod.ts";
import { schema } from "./schema.ts";

const client = createClient();
const qb = createQueryBuilder(client, schema);

// Awaiting the chain runs the query through `client.query()`.
const users = await qb.User
  .select({ email: true, name: true })
  .filter((u) => u.email.eq("alice@example.com"))
  .first();
//    ^? { email: string; name: string | null } | null
```

`select` narrows the awaited row type to the picked shape. `filter` predicates receive a typed reference where each property accepts only the right comparison operand: `u.email.eq(...)` requires a `string`, `u.score.gt(...)` requires a `number`. Identifier safety is enforced at construction so schema typos fail before reaching the server.

### Composability with `client.query`

The query builder compiles to the same EdgeQL strings the raw `client.query("select User { ... }")` path does and runs through the same access-policy + read-only + auth-gate pipeline. The two patterns interoperate freely — pick whichever reads better at the call site, no migration needed.

(`sdk/query-builder.ts`, `sdk/schema-types.ts`)

---

## TypeScript Types

When using generated types from `disc codegen`, you can pass them as type parameters to `query()` for full type safety:

```typescript
import { createClient } from "disc/sdk/mod.ts";
import type { Post, User } from "./dbschema/disc-client/interfaces.ts";

const client = createClient();

// Type-safe query results
const users = await client.query<User[]>("select User { email, name }");
// users is typed as User[]

// Type-safe within transactions
const result = await client.transaction(async (tx) => {
  const user = await tx.query<User>(
    `insert User { email := <str>$email, name := <str>$name }`,
    { email: "daena@example.com", name: "Daena" },
  );

  return user; // typed as User
});

// Type-safe subscriptions
const sub = createSubscriptionClient();
await sub.connect();
sub.subscribe<User[]>(
  "select User { email, name }",
  {
    onData: (users) => {
      // users is typed as User[]
      for (const user of users) {
        console.log(user.email, user.name);
      }
    },
  },
);
```

---

## SDK Exports

The complete list of exports from `disc/sdk/mod.ts`:

### Classes

| Export               | Description                               |
| -------------------- | ----------------------------------------- |
| `AuthManager`        | Authentication lifecycle manager          |
| `DiscClient`         | Core HTTP client for Disc                 |
| `SubscriptionClient` | WebSocket subscription client             |
| `Transaction`        | Transaction handle (received in callback) |

### Factory Functions

| Export                                        | Description                            |
| --------------------------------------------- | -------------------------------------- |
| `createClient(config?)`                       | Create a `DiscClient` instance         |
| `createSubscriptionClient(config?, options?)` | Create a `SubscriptionClient` instance |

### Error Classes

| Export                 | Description                          |
| ---------------------- | ------------------------------------ |
| `DiscAuthError`        | Authentication/authorization failure |
| `DiscClientError`      | Base error class                     |
| `DiscConnectionError`  | Server unreachable                   |
| `DiscErrorCode`        | Error code enum                      |
| `DiscNetworkError`     | Network failure                      |
| `DiscProtocolError`    | Unexpected response format           |
| `DiscQueryError`       | Query execution error                |
| `DiscServerError`      | Server 5xx error                     |
| `DiscTimeoutError`     | Request timeout                      |
| `DiscTransactionError` | Invalid transaction state            |

### Types

| Export                     | Description                                               |
| -------------------------- | --------------------------------------------------------- |
| `AuthManagerOptions`       | Auth manager configuration                                |
| `AuthResponse`             | Login/register response (user, session, token)            |
| `AuthTokens`               | JWT token and optional refresh token                      |
| `AuthUser`                 | User profile (id, email, username, metadata)              |
| `CacheStats`               | Cache hit/miss/eviction stats                             |
| `DiscClientConfig`         | Client constructor options                                |
| `HealthStatus`             | Server health (status, database, pool)                    |
| `IsolationLevel`           | `"read_committed"`, `"repeatable_read"`, `"serializable"` |
| `LoginCredentials`         | Email/username and password                               |
| `QueryError`               | Single query error from the server                        |
| `QueryExtensions`          | Timing info (parseMs, compileMs, executeMs)               |
| `QueryRequest`             | Query payload (query, variables, operationName)           |
| `QueryResponse<T>`         | Response envelope (data, errors, extensions)              |
| `RegisterData`             | Email, password, optional username/metadata               |
| `ServerStats`              | Connections, queries, transactions, memory, cache         |
| `SubscriptionCallbacks<T>` | onData, onError, onComplete handlers                      |
| `SubscriptionClientConfig` | Subscription client options                               |
| `SubscriptionHandle`       | Subscription id and unsubscribe function                  |
| `SubscriptionMessage<T>`   | Incoming subscription message (id, type, payload)         |
| `SubscriptionRequest`      | Subscription request (id, query, variables)               |
| `TransactionState`         | `"active"`, `"committed"`, `"rolled_back"`                |

---

## See Also

- [Getting Started](getting-started.md) -- Quick introduction to Disc
- [EdgeQL](edgeql.md) -- Query language reference
- [Server Configuration](server.md) -- Server setup, HTTP API, and environment variables
- [Auth](auth.md) -- Authentication system details
- [Codegen](codegen.md) -- Generating typed clients from your schema
