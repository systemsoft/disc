# SDK

TypeScript client SDK for consuming Disc from applications. Provides a typed HTTP client, authentication manager, transaction support, and WebSocket-based subscriptions.

## Import

```typescript
import { AuthManager, createClient, createSubscriptionClient, DiscClient, SubscriptionClient, Transaction } from "disc/sdk/mod.ts";
```

## DiscClient

The core HTTP client for querying a Disc server. Handles request timeouts, retries with exponential backoff, auth token injection, and HTTP error classification.

### Configuration

```typescript
import type { DiscClientConfig } from "disc/sdk/mod.ts";

const client = createClient({
  baseUrl: "http://localhost:5656", // default
  timeout: 30000, // request timeout in ms (default: 30000)
  headers: { "X-Custom": "value" }, // custom headers on every request
  retries: 3, // retry count on network/server errors (default: 0)
  retryDelay: 1000, // base delay between retries in ms (default: 1000)
});
```

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
  { validate: User },
);

// Plain function — useful for cheap shape checks or transforms
const ids = await client.query(
  "select User.id",
  undefined,
  {
    validate: (v) => {
      if (!Array.isArray(v)) throw new Error("expected array");
      return v as string[];
    },
  },
);
```

If you omit `validate`, the SDK falls back to the legacy unchecked cast
(fast, but typos and upstream schema drift surface at runtime). For
codegen-driven type safety where the _query itself_ is checked against
your SDL, run `disc codegen`.

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

## AuthManager

Manages the full authentication lifecycle: login, registration, logout, token refresh, and profile retrieval. Automatically refreshes tokens before expiry when `autoRefresh` is enabled.

```typescript
import { AuthManager } from "disc/sdk/mod.ts";
import type { AuthManagerOptions } from "disc/sdk/mod.ts";

const auth = new AuthManager(client, {
  autoRefresh: true, // default: true
  refreshBuffer: 60, // seconds before expiry to trigger refresh (default: 60)
});
```

### Registration and Login

```typescript
// Register a new user
const response = await auth.register({
  email: "ada@example.com",
  password: "secure-password",
  username: "ada", // optional
  metadata: { role: "admin" }, // optional
});
// response.user, response.token, response.session

// Login with email or username
const loginResponse = await auth.login({
  email: "ada@example.com",
  password: "secure-password",
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
const result = await client.transaction(async (tx) => {
  const user = await tx.query<User>(
    "insert User { name := <str>$name, email := <str>$email }",
    { name: "Billie", email: "billie@example.com" },
  );

  await tx.query(
    "insert Post { title := <str>$title, author := (select User filter .id = <uuid>$id) }",
    { title: "Hello World", id: user.id },
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
    reconnectDelay: 1000, // base delay in ms (default: 1000)
  },
);

await sub.connect();
```

### Subscribing

```typescript
const handle = sub.subscribe<User>(
  "select User { name, email }",
  {
    onData: (data) => console.log("Update:", data),
    onError: (err) => console.error("Error:", err), // optional
    onComplete: () => console.log("Stream ended"), // optional
  },
  { filter: "active" }, // optional variables
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

- `DiscServerError` (5xx) and network errors are retried up to `retries` times with linear backoff.
- `DiscAuthError`, `DiscQueryError`, and `DiscProtocolError` are never retried.
- `DiscTimeoutError` is thrown immediately without retry.

## Types

Key type exports from `sdk/types.ts`:

| Type                       | Description                                         |
| -------------------------- | --------------------------------------------------- |
| `DiscClientConfig`         | Client constructor options                          |
| `QueryRequest`             | Query payload (query, variables, operationName)     |
| `QueryResponse<T>`         | Response envelope (data, errors, extensions)        |
| `QueryExtensions`          | Timing info (parseMs, compileMs, executeMs)         |
| `HealthStatus`             | Server health (status, database, pool)              |
| `ServerStats`              | Connections, queries, transactions, memory, cache   |
| `AuthTokens`               | JWT token and optional refresh token                |
| `AuthUser`                 | User profile (id, email, username, metadata)        |
| `AuthResponse`             | Login/register response (user, session, token)      |
| `LoginCredentials`         | Email/username + password                           |
| `RegisterData`             | Email, password, optional username/metadata         |
| `TransactionState`         | "active", "committed", "rolled_back"                |
| `SubscriptionCallbacks<T>` | onData, onError, onComplete handlers                |
| `SubscriptionHandle`       | Subscription id + unsubscribe function              |
| `IsolationLevel`           | "read_committed", "repeatable_read", "serializable" |
