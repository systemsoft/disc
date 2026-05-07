# Access Policies

Access policies are declarative, row-level security rules defined directly in your SDL schema. They control which rows a user can select, insert, update, or delete based on the authenticated user’s identity, role, or any other context you define.

Access policies are Disc’s equivalent to Gel’s object-level access control. They compile down to SQL WHERE clauses that are injected into every query touching the protected type.

---

## Enabling Access Policies

Access policies must be explicitly enabled on the server:

```bash
disc serve --enable-access-policies --jwt-secret "your-secret" --enable-auth
```

Or via environment variables:

```bash
export DISC_ENABLE_ACCESS_POLICIES=1
export DISC_JWT_SECRET="your-secret"
export DISC_ENABLE_AUTH=1
disc serve
```

Access policies work best with [authentication](auth.md) enabled, since most policies reference the authenticated user. However, you can use policies without auth for public/anonymous access patterns.

---

## SDL Syntax

Access policies are defined inside type declarations in your `.disc` schema files:

```
module default {
  type Post {
    required author: User;
    required body: str;
    published: bool { default := false; };
    required title: str;

    access policy public_read
      allow select
      using (.published = true);

    access policy author_full_access
      allow all
      using (.author.id ?= global current_user_id);
  };
};
```

Each policy has three parts:

1. **Name** -- a unique identifier within the type (`public_read`, `author_full_access`)
2. **Action** -- `allow` or `deny`, followed by the operations it applies to
3. **Using expression** (optional) -- a boolean condition that determines which rows the policy covers

---

## Policy Actions

### Allow vs Deny

- **`allow`** grants access to matching rows
- **`deny`** blocks access, overriding any allow policies

```
access policy editors_can_update
  allow update
  using (.editor.id ?= global current_user_id);

access policy no_delete
  deny delete;
```

### Operations

Policies apply to one or more operations:

| Operation | Description                       |
| --------- | --------------------------------- |
| `select`  | Reading rows                      |
| `insert`  | Creating new rows                 |
| `update`  | Modifying existing rows           |
| `delete`  | Removing rows                     |
| `all`     | Shorthand for all four operations |

You can list multiple operations:

```
access policy owner_write
  allow insert, update, delete
  using (.owner.id ?= global current_user_id);
```

---

## Using Expressions

The `using` clause defines a boolean condition evaluated against each row. Only rows where the condition is `true` are accessible.

### Object Property References

Use `.property` syntax to reference the current object’s properties:

```
access policy published_only
  allow select
  using (.published = true);
```

### Link Traversal

Follow links with dot notation:

```
access policy author_only
  allow update
  using (.author.id ?= global current_user_id);
```

### Coalescing Comparison

The `?=` operator is a coalescing equality check. It returns `false` when either side is empty (rather than returning an empty set), making it safe for comparing optional values and globals:

```
using (.owner.id ?= global current_user_id);
```

### Unconditional Policies

Omit the `using` clause for policies that apply to all rows:

```
access policy public_read
  allow select;

access policy no_delete
  deny delete;
```

---

## Globals in Policies

Globals provide context values from the authenticated session. These are the primary mechanism for connecting auth identity to row-level security.

### Built-in Globals

| Global                   | Description                               | Source                     |
| ------------------------ | ----------------------------------------- | -------------------------- |
| `global current_user`    | Whether a user is authenticated (boolean) | JWT `sub` claim            |
| `global current_user_id` | Authenticated user’s ID                   | JWT `sub` claim            |
| `global current_role`    | User’s primary role                       | First entry in roles array |

### Custom Globals

You can define custom globals in your schema and set them via session variables:

```
module default {
  global current_tenant_id: uuid;

  type Project {
    required name: str;
    required tenant_id: uuid;

    access policy tenant_isolation
      allow all
      using (.tenant_id ?= global current_tenant_id);
  };
};
```

Custom globals are resolved at query time using PostgreSQL’s `current_setting()` mechanism, which means they can be set per-session or per-transaction.

---

## Deno-Permission-Aware Policies

Access policies can gate on the running Disc process's `--allow-*` permission set as a defense-in-depth layer. Even an authorized application user gets an empty result when the runtime sandbox lacks the corresponding permission — useful for restricting whole categories of access (e.g. "this read endpoint must not run on a process without filesystem read") without re-engineering the auth layer.

### `runtime::has_permission(<spec>)`

A built-in policy function that pre-evaluates against `Deno.permissions.querySync(...)` at SQL emission time and inlines the result as `TRUE`/`FALSE` in the generated WHERE clause. Postgres can't call back into Deno; the permission set is fixed for the life of the process, so caching at SQL emission is correct.

### Spec grammar

| Spec form                            | Maps to                           | Example                           |
| ------------------------------------ | --------------------------------- | --------------------------------- |
| `read`                               | `{name: "read"}`                  | `runtime::has_permission("read")` |
| `read:/path`                         | `{name: "read", path: "/path"}`   | `read:/etc/secrets`               |
| `write` / `write:/path`              | `{name: "write", ...}`            | `write:/var/disc/uploads`         |
| `net` / `net:host` / `net:host:port` | `{name: "net", host?: "..."}`     | `net:api.example.com`             |
| `env` / `env:VAR`                    | `{name: "env", variable?: "VAR"}` | `env:DATABASE_URL`                |
| `run` / `run:cmd`                    | `{name: "run", command?: "cmd"}`  | `run:git`                         |
| `sys` / `sys:KIND`                   | `{name: "sys", kind?: "KIND"}`    | `sys:hostname`                    |
| `ffi` / `ffi:/lib`                   | `{name: "ffi", path?: "..."}`     | `ffi:/usr/lib/libfoo.so`          |

The spec parser is strict — unknown names (`"filesystem"`, `"admin"`) and empty scopes (`"read:"`) throw a `ValidationError` at policy-load time so SDL typos fail fast rather than silently always-denying.

### Example

```
module default {
  type SecretDoc {
    required title: str;
    required body: str;

    access policy filesystem_required
      allow select
      using (
        global current_user
        and runtime::has_permission("read:/etc/disc/secrets")
      );
  };
};
```

A SELECT against `SecretDoc` returns rows only when (a) the request is authenticated **and** (b) the Disc process was started with `--allow-read=/etc/disc/secrets`. Drop the flag and the same query — same user, same JWT — returns an empty set.

### Composition

`runtime::has_permission(...)` composes with every other policy expression. The spec argument **must** be a string literal — non-literal arguments are rejected at policy parse time with a `ValidationError`, since arbitrary expression args have undefined semantics.

### Test seam

Production code calls `Deno.permissions.querySync(...)` via the `defaultPermissionChecker`. Tests inject a `PermissionChecker` mock through `AccessContext.permissionChecker` to assert deterministic `granted`/`denied`/`prompt` outcomes without depending on the test runner's `--allow-*` flags. See `access/runtime-permissions.test.ts` for the pattern.

---

## Evaluation Order

Disc evaluates policies in two modes:

### Permissive Mode (Default)

1. All `allow` policies are evaluated. If **any** allow policy matches, the row is accessible.
2. All `deny` policies are evaluated. If **any** deny policy matches, it overrides the allow.
3. If no policies match, the `defaultAllow` setting determines access.

In permissive mode, allow policies are OR’d together: a row is accessible if it matches at least one allow policy.

### Restrictive Mode

1. Requires an **explicit** allow policy to grant access.
2. Any deny policy immediately blocks access.
3. If no allow policy matches, access is denied regardless of `defaultAllow`.

Configure the mode programmatically:

```typescript
const evaluator = new AccessEvaluator({
  defaultAllow: false,
  enableAudit: false,
  enableRLS: true,
  mode: "permissive", // or "restrictive"
});
```

---

## Per-request bypass (admin-only)

Admin-role callers can opt out of policy injection on a single
request via the `X-Disc-Apply-Access-Policies: false` header. This
mirrors Gel's session-level `apply_access_policies := false` and is
useful for support tooling that needs to read across tenants, or
admin scripts that intentionally want unfiltered output.

```bash
curl -X POST http://localhost:5656/query \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "X-Disc-Apply-Access-Policies: false" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT User { name, email }"}'
```

**Gating.** The HTTP layer reads the JWT's `roles` claim and only
honors the header when `roles` includes `"admin"`. Non-admin callers
who set the header have it silently dropped at the boundary — there
is no way for a regular user to escalate by setting the header.

**Cache safety.** The compilation cache key embeds the bypass flag so
a bypassed result is never served to a non-bypassed call (and vice
versa). Two requests with the same EdgeQL but different bypass state
compile independently.

**Truthy values.** The header value is normalized: `false`, `0`, and
`no` (case-insensitive, trimmed) all opt out. Any other value
(including absent, empty, `true`, `1`) keeps policies enforced.

The implementation lives in `server/http.ts:handle_query` (header
parsing + role gate) and `compiler/compiler.ts:applyAccessControl`
(short-circuit on `AccessContext.bypass`). (gh/geldata#6358)

## Per-policy disable (admin-only) (gh/geldata#6432 slice 3)

When you want to test how _one_ policy behaves without nuking the
whole stack, the `X-Disc-Disable-Policies` header takes a
comma-separated list of qualified policy names
(`<TypeName>.<policy_name>`) and silently skips them in the
evaluator. The evaluator behaves as if those policies weren't
declared at all — same fall-back to `defaultAllow` semantics.

```bash
# Disable a single policy, leave the rest in force
curl -X POST http://localhost:5656/edgeql \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Disc-Disable-Policies: Doc.owner_only" \
  -d '{"query": "select Doc { id, title }"}'

# Disable several at once
curl -X POST http://localhost:5656/edgeql \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Disc-Disable-Policies: Doc.owner_only, User.admin_check" \
  -d '{"query": "select Doc { id, title, author: { name } }"}'
```

Same admin-only gate as the apply-bypass header: a non-admin caller
setting the header has it dropped at the boundary, never reaching
the compiler. The compilation cache key embeds the disabled set so a
disabled-policies call can't share a cache slot with a regular call.

This is the surgical alternative to the all-or-nothing
`X-Disc-Apply-Access-Policies: false` bypass — useful when you're
isolating one policy at a time during testing or debugging an
authorization regression.

The implementation lives in `server/http.ts:handle_query` (header
parsing + role gate), `server/edgeql-protocol.ts:handleRequest`
(threading into AccessContext + cache-key embedding), and
`access/evaluator.ts:evaluate` (qualified-name filter before policy
evaluation).

## Run-in-isolation: `disc admin test-policy` (gh/geldata#6432 slice 4)

When you want to debug _why_ a specific policy is denying a specific
user — without spinning up the server or wiring an admin token —
the `disc admin test-policy` CLI runs a single policy (or every
policy on a type) against a synthetic `AccessContext` built from
flags. Pure SDL + in-memory evaluator; no DB hookup.

```bash
# Evaluate one policy against a synthetic user
disc admin test-policy Doc.owner_only \
  --action select \
  --user-id u1 \
  --global current_user=u1

# Output:
#   Doc.owner_only (select): ALLOW (12µs)
#     reason: Allowed by permissive policy
#     sql: ($1 = u1)

# --all mode: walk every policy on the type
disc admin test-policy Doc --all \
  --action delete \
  --user-id u1 \
  --user-role admin \
  --global is_admin=true

# Output:
#   Doc.owner_only (delete): DENY (8µs)
#     reason: No allowing policy found
#   Doc.admin_override (delete): ALLOW (5µs)
#     reason: Allowed by permissive policy
#     sql: ($1 = true)
```

Flags:

| Flag                 | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `<Type>.<policy>`    | The policy to evaluate (positional). Use `<Type>` with `--all` instead. |
| `--all`              | Evaluate every policy on the type                                       |
| `--action <op>`      | `select` (default), `insert`, `update`, `delete`, or `all`              |
| `--user-id <id>`     | `AccessContext.userId`                                                  |
| `--user-role <role>` | `AccessContext.userRole`                                                |
| `--global key=value` | Add to `AccessContext.globals` (repeatable)                             |
| `--schema <file>`    | Override default `./dbschema/default.disc`                              |

Each policy runs through a fresh `AccessEvaluator` so global
mode/defaultAllow don't muddy the per-policy verdict. The output
includes the verdict (ALLOW/DENY), the reason, the policy's
errmessage if it carries one, the generated SQL condition, and the
evaluation time in microseconds.

This complements the `X-Disc-Disable-Policies` header above:

- **Disable header** — debug behavior of a live query with one
  policy turned off.
- **`test-policy`** — debug a single policy itself in isolation,
  no live query needed.

The implementation lives in `cli/admin.ts:testPolicyImpl` (pure
function exported for testing) and `cli/main.ts` (CLI routing).
The exported `collectAccessPolicyAst(sdl)` helper exposes the raw
AST shape for tests that don't want to drive the evaluator path.

---

## Auth + Access Flow

When a request arrives, Disc builds the access context from the authenticated JWT:

```
Request with JWT
    |
    v
AuthMiddleware.authenticate()
    |  extracts and verifies JWT
    v
AuthContext { userId, roles, permissions, jwtClaims }
    |
    v
authContextToAccessContext()
    |  bridges server auth to access module
    v
AccessContext { userId, userRole, globals, sessionData }
    |
    v
AccessEvaluator.evaluate(objectType, operation, context)
    |  checks all registered policies
    v
AccessDecision { allowed, sqlConditions }
    |
    v
AccessSQLInjector.injectSelect/Update/Delete()
    |  adds WHERE clauses to compiled SQL
    v
PostgreSQL executes filtered query
```

The bridge function maps auth claims to access context:

```typescript
function authContextToAccessContext(
  auth: AuthContext,
  sessionGlobals?: Map<string, unknown>,
): AccessContext {
  return {
    globals: sessionGlobals,
    sessionData: auth.jwtClaims,
    userId: auth.userId,
    userRole: auth.roles.length > 0 ? auth.roles[0] : undefined,
  };
}
```

---

## SQL Injection

Access policies are enforced by injecting SQL WHERE clauses into compiled queries. This happens transparently -- you write EdgeQL as normal, and the access layer modifies the generated SQL before it reaches PostgreSQL.

For SELECT queries, conditions filter which rows are returned:

```sql
-- Original compiled SQL
SELECT jsonb_build_object('title', p.title, 'body', p.body)
FROM posts p

-- After access policy injection
SELECT jsonb_build_object('title', p.title, 'body', p.body)
FROM posts p
WHERE (p.published = true) AND (p.author_id = 'd290f1ee-...')
```

For UPDATE and DELETE queries, conditions restrict which rows can be modified. If a policy denies the operation entirely, the query raises an error rather than silently affecting zero rows.

For INSERT queries, the evaluator checks the policy condition against the request context. If the insert is denied, an error is raised before the SQL executes.

---

## Examples

### Owner-Only Access

Users can only see and modify their own records:

```
module default {
  type Profile {
    bio: str;
    required display_name: str;
    required user_id: uuid;

    access policy owner_only
      allow all
      using (.user_id ?= global current_user_id);
  };
};
```

### Public Read, Authenticated Write

Anyone can read published content. Only the author can create, update, or delete:

```
module default {
  type Article {
    required author: User;
    required content: str;
    published: bool { default := false; };
    required title: str;

    access policy public_read
      allow select
      using (.published = true);

    access policy author_read_own
      allow select
      using (.author.id ?= global current_user_id);

    access policy author_write
      allow insert, update, delete
      using (.author.id ?= global current_user_id);
  };
};
```

### Multi-Tenant Isolation

Rows are scoped to a tenant using a global:

```
module default {
  global current_tenant_id: uuid;

  type Customer {
    required email: str;
    required name: str;
    required tenant_id: uuid;

    access policy tenant_isolation
      allow all
      using (.tenant_id ?= global current_tenant_id);
  };

  type Invoice {
    required amount: decimal;
    required customer: Customer;
    required tenant_id: uuid;

    access policy tenant_isolation
      allow all
      using (.tenant_id ?= global current_tenant_id);
  };
};
```

Every query against `Customer` or `Invoice` is automatically filtered to only return rows matching the current tenant. No tenant can see or modify another tenant’s data.

### Role-Based Access

Restrict operations based on user roles:

```
module default {
  type AuditLog {
    required action: str;
    required timestamp: datetime;
    required actor: User;

    access policy admins_read
      allow select
      using (global current_role = "admin");

    access policy no_modifications
      deny insert, update, delete;
  };
};
```

---

## Testing Policies

### Unit Testing

Test policy evaluation directly using the `AccessEvaluator`:

```typescript
import { AccessEvaluator } from "./access/evaluator.ts";

const evaluator = new AccessEvaluator({
  defaultAllow: false,
  enableAudit: false,
  enableRLS: true,
  mode: "permissive",
});

// Register a policy
evaluator.registerPolicy({
  actions: [{ allow: true, operations: ["select", "update"] }],
  condition: { kind: "AccessGlobal", name: "current_user" },
  name: "owner_only",
  objectType: "Profile",
  using: {
    kind: "AccessComparison",
    left: { kind: "AccessPath", path: ["user_id"] },
    operator: "=",
    right: { kind: "AccessGlobal", name: "current_user" },
  },
});

// Test with authenticated context
const decision = evaluator.evaluate("Profile", "select", {
  userId: "user-123",
  userRole: "member",
});

console.log(decision.allowed); // true
console.log(decision.sqlConditions); // ["(user_id = 'user-123')"]
```

### Integration Testing

Test the full pipeline with a running Disc server:

```bash
# Start server with access policies enabled
DISC_PG_AUTO=1 disc serve --enable-access-policies --enable-auth --jwt-secret "test-secret"

# Register a user
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "testpass123"}'

# Use the returned token to query
curl -X POST http://localhost:8080/query \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "select Profile { display_name }"}'
```

Run the access module test suite:

```bash
# Unit tests (46 tests)
deno test access/ --allow-all --no-check

# Integration tests with PostgreSQL
DISC_PG_AUTO=1 deno test server/access-pg.test.ts --allow-all --no-check
```

---

## Limitations

The following features are not yet implemented:

- **Column-level policies** -- policies currently apply at the row level only. Column-level restrictions for UPDATE operations are planned.
- **PostgreSQL RLS passthrough** -- policies are currently enforced at the application level via SQL injection. Native PostgreSQL RLS policy generation is implemented (`AccessSQLInjector.generateRLSPolicies()`) but not yet wired into the migration engine.
- **Policy composition across inheritance** -- policies on abstract types are not yet automatically inherited by concrete subtypes.
- **Audit logging** -- the `enableAudit` config flag is accepted but audit logging is not yet implemented.
- **WITH CHECK on INSERT/UPDATE** -- `with check (...)` clauses are parsed by the SDL grammar (`schema/parser.ts`), forwarded to the runtime policy (`access/policy-adapter.ts`), and emitted as `WITH CHECK` on the generated PostgreSQL RLS policy (`access/sql-injector.ts`). Native RLS enforcement requires the migration-engine RLS wiring listed above.

---

## Related

- [Authentication](auth.md) -- JWT auth that provides the identity context
- [Schema](schema.md) -- SDL reference including access policy syntax
- [Extensions](extensions.md) -- the access module is also available as an extension adapter
