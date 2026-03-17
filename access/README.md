# Access Control Module

The access module provides object-level access policies and row-level security for Disc, similar to Gel's access control features. It allows you to define fine-grained permissions for database operations.

## Features

- **Object-level access policies**: Define who can perform what operations on which types
- **Row-level security (RLS)**: Filter data at the row level based on user context
- **Column-level restrictions**: Control access to specific fields
- **Flexible policy modes**: Permissive or restrictive evaluation
- **SQL injection**: Automatically apply access conditions to queries
- **PostgreSQL RLS integration**: Generate native PostgreSQL row-level security policies

## Usage

### Defining Access Policies in SDL

Access policies can be defined directly in your schema:

```sdl
module default {
  type User {
    required email: str;
    required name: str;
    posts: multi Post;

    access policy owner_only {
      allow select, update when .id = current_user;
      deny delete;
    }
  }

  type Post {
    required author: User;
    required body: str;
    published: bool {
      default := false;
    };
    required title: str;

    access policy public_read {
      allow select when .published = true;
    }

    access policy author_write {
      allow insert, update, delete when .author.id = current_user;
    }
  }
}
```

### Standalone Policy Files

You can also define policies in separate files:

```
# policies/admin.esdl
access policy admin_override {
  allow all when has_role("admin");
}

access policy audit_protection for AuditLog {
  deny delete;
  allow select when current_role = "auditor";
}
```

### Policy Syntax

#### Basic Structure

```
access policy <name> [for <type>] {
  <rules>
  [using (<expression>);]
  [with check (<expression>);]
}
```

#### Rules

Rules specify allow or deny actions for operations:

```
allow <operations> [when <condition>];
deny <operations> [when <condition>];
```

Operations can be:

- `all` - All operations
- `delete` - Remove records
- `insert` - Create new records
- `select` - Read data
- `update` - Modify existing records (can specify columns)

#### Column Restrictions

For UPDATE operations, you can specify which columns are allowed:

```
allow update(name, bio);
deny update(email, password);
```

#### Using Clause

The `using` clause adds row-level filtering for SELECT operations:

```
using (.tenant_id = current_session.tenant_id);
```

#### With Check Clause

The `with check` clause validates data for INSERT/UPDATE operations:

```
with check (.status in ["draft", "published"]);
```

### Programmatic Usage

```typescript
import {
  AccessConfig,
  AccessEvaluator,
  AccessSQLInjector,
} from "./access/mod.ts";

// Configure access control
const config: AccessConfig = {
  defaultAllow: false, // Default when no policies match
  enableAudit: false, // Enable audit logging
  enableRLS: true, // Enable row-level security
  mode: "permissive", // or "restrictive"
};

// Create evaluator
const evaluator = new AccessEvaluator(config);

// Register policies
evaluator.registerPolicy({
  actions: [{ allow: true, operations: ["select"] }],
  name: "user_read",
  objectType: "User",
});

// Evaluate access
const context = {
  sessionData: { tenant_id: "tenant1" },
  userId: "user123",
  userRole: "member",
};

const decision = evaluator.evaluate("User", "select", context);

if (decision.allowed) {
  console.log("Access granted");

  if (decision.sqlConditions) {
    console.log("Apply conditions:", decision.sqlConditions);
  }
} else {
  console.log("Access denied:", decision.reason);
}

// Inject into SQL queries
const injector = new AccessSQLInjector(evaluator);

const query = {
  params: [],
  text: "SELECT * FROM users",
};

const securedQuery = injector.injectSelect(
  query,
  "users",
  "User",
  context,
);
```

### Global Variables

These variables are available in policy expressions:

- `current_role` - The role of the current user
- `current_session` - Session data object
- `current_user` - The ID of the current user

### Built-in Functions

- `has_role(role)` - Check if user has a specific role
- `is_owner()` - Check if user owns the resource (requires implementation)

## Policy Evaluation

### Permissive Mode

In permissive mode:

- Any `allow` rule grants access
- Explicit `deny` rules override allows
- If no rules match, use `defaultAllow` setting

### Restrictive Mode

In restrictive mode:

- Requires explicit `allow` to grant access
- Any `deny` rule immediately denies access
- More secure but requires comprehensive policies

## PostgreSQL Integration

The module can generate native PostgreSQL RLS policies:

```typescript
const statements = injector.generateRLSPolicies("users", "User");
// Outputs:
// ALTER TABLE users ENABLE ROW LEVEL SECURITY;
// CREATE POLICY users_owner_only ON users ...
```

## Testing

Run the test suite:

```bash
deno test access/
```

## Architecture

- `ast.ts` - AST nodes for access policy expressions
- `evaluator.ts` - Policy evaluation engine
- `mod.ts` - Module exports
- `parser.ts` - Parser for access policy syntax
- `sql-injector.ts` - SQL query modification for access control
- `types.ts` - Type definitions and interfaces

## Future Enhancements

- [ ] Integration with schema parser for inline policies
- [ ] Policy inheritance and composition
- [ ] Time-based policies (temporal access control)
- [ ] Dynamic policy loading from database
- [ ] Audit logging integration
- [ ] Performance optimizations for large policy sets
- [ ] Policy simulation and testing tools
