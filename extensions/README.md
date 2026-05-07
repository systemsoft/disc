# Extensions

Modular extension system for the Disc database server. Extensions can register custom functions, types, HTTP routes, middleware, compiler hooks, and database setup SQL. The server initializes and shuts down extensions as part of its lifecycle.

## Import

```typescript
import { AccessExtensionAdapter, AuthExtensionAdapter, BaseExtension, createExtensionContext, ExtensionRegistry } from "disc/extensions/mod.ts";

import type {
  CompilerHook,
  Extension,
  ExtensionConfig,
  ExtensionContext,
  ExtensionDatabaseSetup,
  ExtensionMetadata,
  ExtensionMiddleware,
  ExtensionRoute,
  ExtensionState,
} from "disc/extensions/mod.ts";
```

## Extension Interface

Every extension implements the `Extension` interface:

```typescript
interface Extension {
  readonly metadata: ExtensionMetadata;
  readonly state: ExtensionState;
  initialize(context: ExtensionContext): Promise<void>;
  shutdown(): Promise<void>;
  getFunctions(): FunctionDef[];
  getTypes(): TypeDef[];
  getRoutes(): ExtensionRoute[];
  getMiddleware(): ExtensionMiddleware[];
  getDatabaseSetup(): ExtensionDatabaseSetup;
  getCompilerHooks(): CompilerHook[];
  healthCheck(): Promise<{ healthy: boolean; details?: string }>;
}
```

### ExtensionMetadata

```typescript
interface ExtensionMetadata {
  name: string;
  version: string;
  description?: string;
  dependencies?: string[]; // names of extensions that must be initialized first
}
```

### ExtensionState

Extensions move through these states:

| State           | Description                              |
| --------------- | ---------------------------------------- |
| `uninitialized` | Registered but not yet initialized       |
| `initializing`  | Currently being initialized              |
| `ready`         | Successfully initialized and operational |
| `error`         | Initialization or runtime error          |
| `shutdown`      | Cleanly shut down                        |

## BaseExtension

Abstract base class with sensible defaults for all extension methods. Extend this instead of implementing `Extension` directly.

```typescript
import { BaseExtension } from "disc/extensions/mod.ts";
import type { ExtensionContext, ExtensionMetadata } from "disc/extensions/mod.ts";

class MyExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "my-extension",
    version: "1.0.0",
    description: "A custom extension",
  };

  override async initialize(context: ExtensionContext): Promise<void> {
    // Custom initialization logic
    this.setState("ready");
  }

  override getFunctions(): FunctionDef[] {
    return [
      // Register custom EdgeQL functions
    ];
  }

  override getRoutes(): ExtensionRoute[] {
    return [
      {
        method: "GET",
        path: "/status",
        handler: async (request: Request) => {
          return new Response(JSON.stringify({ ok: true }));
        },
      },
    ];
  }
}
```

Default implementations in `BaseExtension`:

- `initialize()` -- sets state to `"ready"`
- `shutdown()` -- sets state to `"shutdown"`
- `getFunctions()` -- returns `[]`
- `getTypes()` -- returns `[]`
- `getRoutes()` -- returns `[]`
- `getMiddleware()` -- returns `[]`
- `getDatabaseSetup()` -- returns `{ setupSql: [] }`
- `getCompilerHooks()` -- returns `[]`
- `healthCheck()` -- returns `{ healthy: state === "ready" }`

## Extension Lifecycle

1. **Register**: Call `registry.register(extension)`. Duplicate names are rejected.
2. **Initialize**: `registry.initializeAll(context)` initializes extensions in dependency order (topological sort). For each extension:
   - Execute `getDatabaseSetup().setupSql` statements via the connection pool (if available).
   - Call `extension.initialize(context)`.
3. **Running**: Extension routes are served under `/ext/<name>/<path>`. Middleware runs on every request sorted by priority. Functions and types are merged into the server schema.
4. **Shutdown**: `registry.shutdownAll()` shuts down extensions in reverse initialization order.

## ExtensionRegistry

Manages the collection of extensions.

```typescript
const registry = new ExtensionRegistry();

// Register
registry.register(new MyExtension());

// Initialize all (respects dependency order)
const context = createExtensionContext({ schema, config });
await registry.initializeAll(context);

// Access extensions
registry.get("my-extension"); // Extension | undefined
registry.getAll(); // Extension[]
registry.size; // number

// Collect extension contributions
registry.getAllFunctions(); // FunctionDef[]
registry.getAllTypes(); // TypeDef[]
registry.getAllRoutes(); // Map<string, ExtensionRoute[]>
registry.getAllMiddleware(); // ExtensionMiddleware[] (sorted by priority)
registry.getAllCompilerHooks(); // CompilerHook[]

// Health
await registry.getHealthStatus(); // Map<string, { healthy, details? }>

// Shutdown
await registry.shutdownAll();
```

### Dependency Resolution

Extensions declare dependencies via `metadata.dependencies`. The registry performs a topological sort to determine initialization order. Circular dependencies throw `ExtensionDependencyError`. Missing dependencies throw `ExtensionDependencyError` listing the missing extension names.

## Extension Routes

Routes are served under `/ext/<extension-name>/<path>`:

```typescript
interface ExtensionRoute {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  handler: (request: Request) => Promise<Response>;
}
```

A route with `path: "/status"` on extension `"my-ext"` is accessible at `GET /ext/my-ext/status`.

## Extension Middleware

Middleware runs on every request, sorted by `priority` (lower numbers run first):

```typescript
interface ExtensionMiddleware {
  name: string;
  priority: number;
  handle: (
    request: Request,
    next: () => Promise<Response>,
  ) => Promise<Response>;
}
```

## Compiler Hooks

Extensions can transform function calls at compile time:

```typescript
interface CompilerHook {
  name: string;
  transformFunctionCall?: (
    funcName: string,
    args: string[],
  ) => string | undefined;
}
```

Return `undefined` to skip transformation; return a string to replace the generated SQL for that function call.

## ExtensionContext

Passed to `initialize()`. Provides access to the server's connection pool, schema, config, and logger:

```typescript
interface ExtensionContext {
  pool?: ConnectionPool;
  schema: Schema;
  config: ServerConfig;
  logger: Logger;
}
```

## Built-in Adapters

### AuthExtensionAdapter

Wraps the existing auth module as an extension. Registers `/auth/*` routes, authentication middleware, and database setup SQL for `users` and `sessions` tables.

```typescript
import { AuthExtensionAdapter } from "disc/extensions/mod.ts";

const authExt = new AuthExtensionAdapter({
  authProvider,
  authMiddleware,
  authRoutes,
});
registry.register(authExt);
```

### AccessExtensionAdapter

Wraps the access policy module as an extension. No routes or database tables; policies are enforced at compile time via `AccessSQLInjector`. Provides `getEvaluator()` and `getInjector()` for direct access to the access subsystem.

```typescript
import { AccessExtensionAdapter } from "disc/extensions/mod.ts";

const accessExt = new AccessExtensionAdapter({
  evaluator,
  injector,
});
registry.register(accessExt);
```

## Error Classes

| Error                      | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `ExtensionError`           | Base error for extension system                  |
| `ExtensionInitError`       | Initialization failure (includes extension name) |
| `ExtensionConfigError`     | Invalid extension configuration                  |
| `ExtensionDependencyError` | Missing or circular dependencies                 |

## Creating a Custom Extension

1. Extend `BaseExtension`.
2. Set `metadata` with a unique name and version.
3. Override methods to provide functions, routes, middleware, or database setup.
4. Register the extension with the server via `DiscServerOptions.extensions`.

```typescript
const server = new DiscServer({
  extensions: [new MyExtension()],
});
```

Extension routes appear at `/ext/my-extension/...` and extension functions become available in EdgeQL queries.
