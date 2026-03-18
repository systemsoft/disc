# Access Control Module

Object-level access policies and row-level security for Disc, equivalent to Gel's access control system.

## Features

- Object-level access policies defined in SDL
- Row-level security (RLS) enforcement via PostgreSQL
- Column-level restrictions for UPDATE operations
- Permissive and restrictive evaluation modes
- SQL condition injection into queries
- Auth-to-access context bridging
- Policy adapter: SDL AccessPolicy to runtime AccessPolicy

## Architecture

```
access/
├── ast.ts                        # AST nodes for policy expressions
├── evaluator.ts                  # Policy evaluation engine
├── evaluator.test.ts             # 12 tests
├── expression-converter.ts       # SDL expression to access expression conversion
├── expression-converter.test.ts  # 14 tests
├── mod.ts                        # Module exports
├── parser.ts                     # SDL access policy syntax parser
├── parser.test.ts                # 11 tests
├── policy-adapter.ts             # SDL AccessPolicy → runtime AccessPolicy bridge
├── policy-adapter.test.ts        # 9 tests
├── sql-injector.ts               # SQL query modification for access control
└── types.ts                      # Type definitions and interfaces
```

## Integration

Access policies are defined in SDL schemas and flow through the system:

```
SDL Schema → SchemaManager → PolicyAdapter → Evaluator → SQL Injector → PostgreSQL RLS
```

### Server Integration

Enabled via `--enable-access-policies` CLI flag or `DISC_ENABLE_ACCESS_POLICIES=1` env var.

The `EdgeQLProtocolHandler` registers policies in the compiler and sets access context per request via `authContextToAccessContext()` (see `server/access-bridge.ts`).

### SDL Policy Syntax

```
module default {
  type User {
    required email: str;
    required name: str;

    access policy owner_only
      allow select, update
      using (.id ?= global current_user_id);

    access policy no_delete
      deny delete;
  };

  type Post {
    required author: User;
    required title: str;
    published: bool { default := false; };

    access policy public_read
      allow select
      using (.published = true);

    access policy author_write
      allow insert, update, delete
      using (.author.id ?= global current_user_id);
  };
};
```

### Programmatic Usage

```typescript
import {
  AccessConfig,
  AccessEvaluator,
  AccessSQLInjector,
  adaptAccessPolicies,
} from "./access/mod.ts";

// Adapt SDL policies to runtime format
const policies = adaptAccessPolicies(sdlAccessPolicies, "User");

// Create evaluator
const evaluator = new AccessEvaluator({
  defaultAllow: false,
  enableRLS: true,
  mode: "permissive"
});

// Register policies
for (const policy of policies) {
  evaluator.registerPolicy(policy);
}

// Evaluate access
const context = {
  sessionData: { tenant_id: "tenant1" },
  userId: "user123",
  userRole: "member"
};

const decision = evaluator.evaluate("User", "select", context);
```

## Policy Evaluation

### Permissive Mode (default)

- Any matching `allow` rule grants access
- Explicit `deny` rules override allows
- If no rules match, falls back to `defaultAllow`

### Restrictive Mode

- Requires an explicit `allow` to grant access
- Any `deny` rule immediately denies
- More secure but requires comprehensive policy coverage

## Testing

```bash
# Run access module tests (46 tests)
deno test access/ --allow-all --no-check

# Run PG-backed E2E access tests
DISC_PG_AUTO=1 deno test server/access-pg.test.ts --allow-all --no-check
```
