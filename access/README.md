# Access Control Module

Object-level access policies and row-level security for Disc, equivalent to Gel’s access control system.

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

Access policies are defined in SDL schemas and flow through the system:

```
SDL Schema → SchemaManager → PolicyAdapter → Evaluator → SQL Injector → PostgreSQL RLS
```

### Server Integration

Enabled via `--enable-access-policies` CLI flag or `DISC_ENABLE_ACCESS_POLICIES=1` env var.

The `EdgeQLProtocolHandler` registers policies in the compiler and sets access context per request via `authContextToAccessContext()` (see `server/access-bridge.ts`).

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

### Write Checks

As in Gel, `update` is `update read` (which objects an update reaches) plus `update write`, and `insert` / `update write` policies check each object a statement writes, with its new values: it must pass an allowing policy's `using` (and Disc's optional `with check`) and no denying one's, or the statement fails with `access policy violation on <insert|update> of <module::Type>` (SQLSTATE 42501, plus the policies' `errmessage`s) and writes nothing. Binary protocol clients receive it as Gel’s `AccessPolicyError`; `/query` answers 403 with `extensions.code` `ACCESS_POLICY_ERROR` (and `sqlState` 42501). The compiler reads the RETURNING rows of every insert and update through `disc_access_check` (`lib/stdlib-sql.ts`); see `AccessEvaluator.writePolicies`.

### Programmatic Usage

```typescript
import {
  AccessConfig,
  AccessEvaluator,
  AccessSQLInjector,
  adaptAccessPolicies
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

### Deny semantics: row-level subtraction

As in Gel, “all allow policies collectively form a union of allowed sets; all deny policies subtract from that union”. A `deny` with a condition (`using`, `when`) denies the objects it holds for: select, update read and delete filter them out; insert and update write fail on them (the write check). A `deny` without a condition denies the operation outright: a select sees no objects, and an update, delete or insert is refused at compile time.

```esdl
access policy open
  allow all;
access policy hide_drafts
  deny select, update, delete
  using (.draft ?= true);     # drafts are invisible and untouchable; the rest is open
access policy no_delete
  deny delete;                # rejects every delete on this type
```

### Policy expressions

A policy’s `when`, `using` and `with check` are EdgeQL expressions over the object, compiled by the query compiler: they may follow single and multi links (`.owner.name`, `global current_user in .members.id`), backlinks (`exists .<team[is Project]`), call functions and read globals. The objects they read are not narrowed by those objects’ own policies — as in Gel, “policy expressions themselves do not take other policies into account” — so a policy never recurses into another.

`when (<cond>)` (Gel) limits the objects a policy applies to: an object it does not hold for is neither allowed nor denied by the policy. It is written in Gel’s form or inside Disc’s block form:

```esdl
access policy admins
  when (global role ?= 'admin')
  allow all;

access policy editors {
  when (global role ?= 'editor');
  allow select;
};
```

## `runtime::has_permission(...)` — Deno-permission-aware policies

Disc-original feature #5: policies can gate on the Deno process’s `--allow-*` permission set. The check is defense-in-depth — even if the application user is otherwise authorized, the row stays invisible if the runtime sandbox doesn’t have the corresponding permission.

```esdl
type SecretConfig {
  required value: str;
  access policy admin_only for SecretConfig {
    allow select;
    using (
      current_user = "admin"
      and runtime::has_permission("read:/etc/disc-secrets")
    );
  }
}
```

Permission-spec grammar:

| Spec                | Maps to `Deno.permissions.querySync({...})` |
| ------------------- | ------------------------------------------- |
| `read` / `write`    | `{ name }`                                  |
| `read:/path`        | `{ name: "read", path: "/path" }`           |
| `net`               | `{ name: "net" }`                           |
| `net:host[:port]`   | `{ name: "net", host: "host[:port]" }`      |
| `env`               | `{ name: "env" }`                           |
| `env:VAR`           | `{ name: "env", variable: "VAR" }`          |
| `run` / `run:cmd`   | `{ name: "run", command? }`                 |
| `sys` / `sys:KIND`  | `{ name: "sys", kind? }`                    |
| `ffi` / `ffi:/path` | `{ name: "ffi", path? }`                    |

Anything outside this grammar throws at policy-load time so a typo fails fast rather than silently treating the unknown spec as "missing" (which would always deny).

The check is process-local — Postgres can’t call back into Deno. At SQL emission time the function is pre-evaluated and inlined as `TRUE` or `FALSE` in the generated WHERE clause. The Deno permission set is fixed for the life of the process, so caching once at SQL emission is correct (the policy WHERE clause recompiles when the schema changes anyway).

For tests, `AccessContext.permissionChecker` accepts a mock so test suites don’t depend on the runner’s `--allow-*` flags. Default checker delegates to `Deno.permissions.querySync(...)`.

## Testing

```bash
# Run access module tests (46 tests)
deno test access/ --allow-all --no-check

# Run PG-backed E2E access tests
DISC_PG_AUTO=1 deno test server/access-pg.test.ts --allow-all --no-check
```
