# Schema Definition Language (SDL) Reference

Disc uses a declarative Schema Definition Language to define your data model. Schema files use the `.disc` extension and describe object types, their properties, links between types, constraints, indexes, access policies, and more.

Disc parses SDL into an abstract syntax tree, validates it, and generates the corresponding PostgreSQL DDL. You write your schema once; Disc handles table creation, foreign keys, constraints, and migrations.

---

## Table of Contents

- [Modules](#modules)
- [Scalar Types](#scalar-types)
- [Object Types](#object-types)
- [Properties](#properties)
- [Constraints](#constraints)
- [Links](#links)
- [Indexes](#indexes)
- [Annotations](#annotations)
- [Inheritance](#inheritance)
- [Access Policies](#access-policies)
- [Triggers](#triggers)
- [Rewrite Rules](#rewrite-rules)
- [Globals](#globals)
- [Aliases](#aliases)
- [Collection Types](#collection-types)
- [Range Types](#range-types)
- [Complete Example](#complete-example)

---

## Modules

Every declaration lives inside a module. Modules provide namespacing for types, functions, globals, and aliases.

### The `default` Module

Most schemas use the `default` module. Types in the default module can be referenced without qualification:

```sdl
module default {
  type User {
    required email: str;
    required name: str;
  };
};
```

### Custom Modules

You can define multiple modules to organize your schema. Types in custom modules are referenced with the `module::TypeName` syntax:

```sdl
module default {
  type User {
    required name: str;
    multi payments: payment::Payment;
  };
};

module payment {
  type Payment {
    required amount: decimal;
    required currency: str;
    required merchant: default::User;
  };
};

module api {
  type ApiKey {
    required active: bool;
    required key: str {
      constraint exclusive;
    };
  };
};
```

Within a module, you reference types in the same module without qualification. Cross-module references require the `module::TypeName` form.

### Module Resolution Order

When Disc resolves an unqualified type name, it checks in this order:

1. Exact match (already qualified or known at top level)
2. Current module scope (if set via `WITH MODULE`)
3. `default` module

---

## Scalar Types

Disc supports all standard scalar types. These map directly to PostgreSQL column types.

### String and Boolean

| SDL Type | Description         | PostgreSQL Type |
| -------- | ------------------- | --------------- |
| `bool`   | Boolean true/false  | `boolean`       |
| `str`    | Unicode text string | `text`          |

### Integer Types

| SDL Type | Description           | Range           | PostgreSQL Type |
| -------- | --------------------- | --------------- | --------------- |
| `int16`  | 16-bit signed integer | -32768 to 32767 | `smallint`      |
| `int32`  | 32-bit signed integer | -2^31 to 2^31-1 | `integer`       |
| `int64`  | 64-bit signed integer | -2^63 to 2^63-1 | `bigint`        |

### Floating Point Types

| SDL Type  | Description           | PostgreSQL Type    |
| --------- | --------------------- | ------------------ |
| `float32` | 32-bit IEEE 754 float | `real`             |
| `float64` | 64-bit IEEE 754 float | `double precision` |

### Arbitrary Precision

| SDL Type  | Description                 | PostgreSQL Type |
| --------- | --------------------------- | --------------- |
| `bigint`  | Arbitrary precision integer | `numeric`       |
| `decimal` | Arbitrary precision decimal | `numeric`       |

### Date and Time Types

| SDL Type                 | Description               | PostgreSQL Type |
| ------------------------ | ------------------------- | --------------- |
| `cal::date_duration`     | Date-only interval        | `interval`      |
| `cal::local_date`        | Date without timezone     | `date`          |
| `cal::local_datetime`    | Datetime without timezone | `timestamp`     |
| `cal::local_time`        | Time without timezone     | `time`          |
| `cal::relative_duration` | Relative time interval    | `interval`      |
| `datetime`               | Timezone-aware datetime   | `timestamptz`   |
| `duration`               | Time interval             | `interval`      |

### Other Types

| SDL Type   | Description               | PostgreSQL Type |
| ---------- | ------------------------- | --------------- |
| `bytes`    | Binary data               | `bytea`         |
| `json`     | JSON data                 | `jsonb`         |
| `sequence` | Auto-incrementing integer | `bigint`        |
| `uuid`     | UUID v4 identifier        | `uuid`          |

### Custom Scalar Types

You can define custom scalar types that extend built-in types and add constraints:

```sdl
module default {
  scalar type Username extending str {
    constraint max_length(50);
    constraint min_length(3);
  };

  scalar type PositiveInt extending int64 {
    constraint min_value(0);
  };
};
```

### Enum Types

Enums are scalar types that extend `enum` with a fixed set of values:

```sdl
module default {
  scalar type Status extending enum<active, inactive, pending>;

  scalar type Priority extending enum<low, medium, high, critical>;
};
```

Enum values are stored as text in PostgreSQL and validated by Disc.

---

## Object Types

Object types are the primary building blocks of a Disc schema. Each object type maps to a PostgreSQL table.

### Basic Definition

```sdl
module default {
  type User {
    age: int32;
    bio: str;
    required email: str;
    required name: str;
  };
};
```

Every object type automatically gets an `id` property of type `uuid` with a default value. You never need to declare it.

### Required vs Optional

Properties and links are optional by default. Use `required` to make them mandatory:

```sdl
module default {
  type User {
    # These must be set on insert
    required email: str;
    required name: str;

    # These are optional (can be empty set)
    age: int32;
    avatar_url: str;
    bio: str;
  };
};
```

### Multi vs Single

By default, properties and links hold a single value (or an empty set if optional). Use `multi` for set-valued properties:

```sdl
module default {
  type User {
    required name: str;
    multi phone_numbers: str;
    multi tags: str;
  };
};
```

A `multi` property can hold zero or more values. A `required multi` property must hold at least one value.

### Empty Type Bodies

Types can extend other types without adding new members:

```sdl
module default {
  abstract type Named {
    required name: str;
  };

  # Admin inherits everything from Named
  type Admin extending Named;
};
```

---

## Properties

Properties define the scalar data stored on an object type.

### Basic Properties

```sdl
module default {
  type Product {
    description: str;
    in_stock: bool;
    required name: str;
    required price: decimal;
    sku: str;
    weight: float64;
  };
};
```

### Default Values

Properties can have default values using the `default` keyword:

```sdl
module default {
  type User {
    active: bool {
      default := true;
    };
    created_at: datetime {
      default := datetime_current();
    };
    required email: str;
    required name: str;
    role: str {
      default := "member";
    };
  };
};
```

Default values are expressions evaluated at insert time. You can use function calls like `datetime_current()` or `uuid_generate_v4()`.

### Readonly Properties

Readonly properties cannot be modified after the object is created:

```sdl
module default {
  type AuditLog {
    required action: str;
    required actor_id: uuid;
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
  };
};
```

### Computed Properties

Computed properties derive their value from an expression rather than storing data directly:

```sdl
module default {
  type User {
    required first_name: str;
    required last_name: str;

    # Computed from other properties
    full_name := .first_name ++ " " ++ .last_name;
  };
};
```

Computed properties use the `:=` assignment syntax and reference other properties using the dot prefix (`.property_name`).

### Property Qualifiers Summary

| Qualifier       | Effect                                          |
| --------------- | ----------------------------------------------- |
| `required`      | Must be set on insert (NOT NULL)                |
| `multi`         | Can hold multiple values (set-valued)           |
| `overloaded`    | Overrides an inherited property definition      |
| `:=` (computed) | Derived from an expression, not stored directly |

---

## Constraints

Constraints enforce data integrity rules on properties and types.

### `exclusive`

Ensures uniqueness across all instances of a type. This is the most common constraint:

```sdl
module default {
  type User {
    required email: str {
      constraint exclusive;
    };
    required username: str {
      constraint exclusive;
    };
  };
};
```

### `max_length`

Limits the maximum length of a string:

```sdl
module default {
  type User {
    bio: str {
      constraint max_length(1000);
    };
    required name: str {
      constraint max_length(255);
    };
  };
};
```

### `min_value` and `max_value`

Set bounds on numeric values (inclusive):

```sdl
module default {
  type Product {
    required price: decimal {
      constraint min_value(0);
    };
    required quantity: int32 {
      constraint min_value(0);
      constraint max_value(10000);
    };
  };
};
```

### `min_ex_value` and `max_ex_value`

Exclusive bounds (the bound value itself is not allowed):

```sdl
module default {
  type Measurement {
    required percentage: float64 {
      constraint min_value(0);
      constraint max_ex_value(100);
    };
    required temperature: float64 {
      # Must be strictly above absolute zero
      constraint min_ex_value(-273.15);
    };
  };
};
```

### `one_of`

Restricts a value to a specific set of allowed values:

```sdl
module default {
  type Config {
    required environment: str {
      constraint one_of("development", "staging", "production");
    };
    required log_level: str {
      constraint one_of("debug", "info", "warn", "error");
    };
  };
};
```

### `expression on`

Custom constraint expressions using EdgeQL:

```sdl
module default {
  type Event {
    required start_time: datetime;
    required end_time: datetime;

    # Custom constraint: end must be after start
    constraint expression on (.end_time > .start_time);
  };
};
```

### `regex`

Validates that a string matches a regular expression pattern:

```sdl
module default {
  type User {
    required email: str {
      constraint exclusive;
      constraint regex("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$");
    };
    phone: str {
      constraint regex("^\\+?[1-9]\\d{1,14}$");
    };
  };
};
```

### Custom Error Messages

Constraints can include custom error messages using `errmessage`:

```sdl
module default {
  type User {
    required age: int32 {
      constraint min_value(0) {
        errmessage := "Age must be a non-negative number";
      };
      constraint max_value(150) {
        errmessage := "Age cannot exceed 150";
      };
    };
  };
};
```

### Delegated Constraints

Delegated constraints apply through type hierarchies:

```sdl
module default {
  abstract type Named {
    required name: str {
      delegated constraint exclusive;
    };
  };

  # Each subtype enforces uniqueness independently
  type User extending Named;
  type Group extending Named;
};
```

With `delegated`, the `exclusive` constraint is enforced per-subtype rather than across the entire abstract type.

### Multiple Constraints

Properties can have multiple constraints:

```sdl
module default {
  type User {
    required username: str {
      constraint exclusive;
      constraint min_length(3);
      constraint max_length(30);
      constraint regex("^[a-zA-Z0-9_]+$");
    };
  };
};
```

---

## Links

Links define relationships between object types. Unlike foreign keys in SQL, links are first-class citizens in Disc schemas.

### Single Links

A single link references one object of the target type. It maps to a foreign key column in PostgreSQL:

```sdl
module default {
  type User {
    required email: str;
    required name: str;
  };

  type Post {
    required author: User;
    required body: str;
    required title: str;
  };
};
```

The `author` link creates an `author_id` foreign key column on the `posts` table.

### Multi Links

A multi link references multiple objects. Disc resolves these as backlinks or many-to-many junction tables:

```sdl
module default {
  type User {
    required name: str;
    multi posts: Post;
  };

  type Post {
    required author: User;
    required title: str;
  };
};
```

When a target type has a single link pointing back (like `Post.author -> User`), Disc detects the backlink automatically. The `multi posts` link does not create its own column; it is resolved via `Post.author_id`.

### Backlinks

Backlinks allow traversing relationships in reverse using the `.<linkname` syntax in queries. They are defined implicitly by the forward link:

```sdl
module default {
  type User {
    required name: str;
    # No explicit link to Post needed -- use .<author in queries
  };

  type Post {
    required author: User;  # This creates the relationship
    required title: str;
  };
};
```

In EdgeQL queries, you can then write:

```edgeql
select User {
  name,
  posts := .<author[is Post] { title }
};
```

### Many-to-Many Links

When both sides of a relationship have `multi` links, Disc creates a junction table:

```sdl
module default {
  type Student {
    multi courses: Course;
    required name: str;
  };

  type Course {
    multi students: Student;
    required title: str;
  };
};
```

Disc creates a junction table (e.g., `student_courses`) with `source_id` and `target_id` columns. The canonical ordering ensures only one junction table is created per pair.

### Link Shorthand

Links can be declared without the `link` keyword using arrow syntax:

```sdl
module default {
  type Post {
    required title: str;

    # These are equivalent:
    required link author -> User;
    required author: User;  # Shorthand (arrow inferred)
  };
};
```

Both forms produce identical AST nodes. The shorthand form uses `->` to indicate a link target.

### Deletion Policies

Control what happens when the target or source of a link is deleted.

#### `on target delete`

Specifies behavior when the linked target object is deleted:

```sdl
module default {
  type User {
    required name: str;
  };

  type Post {
    required title: str;

    required author: User {
      # Options:
      on target delete restrict;      # Prevent deletion (default)
      # on target delete cascade;     # Delete this post too
      # on target delete allow;       # Allow, set to empty
      # on target delete deferred restrict;   # Check at transaction end
      # on target delete set empty;   # Set link to empty
    };
  };
};
```

| Policy              | Behavior                                               |
| ------------------- | ------------------------------------------------------ |
| `restrict`          | Prevent deletion of target if any source references it |
| `cascade`           | Delete this object when the target is deleted          |
| `allow`             | Allow deletion, link becomes empty                     |
| `deferred restrict` | Like restrict, but checked at transaction commit       |
| `set empty`         | Set the link to empty when target is deleted           |

#### `on source delete`

Specifies behavior when the source object (the one holding the link) is deleted:

```sdl
module default {
  type User {
    required name: str;
    multi sessions: Session {
      on source delete delete target;
    };
  };

  type Session {
    required token: str;
    required user: User;
  };
};
```

| Policy          | Behavior                                             |
| --------------- | ---------------------------------------------------- |
| `allow`         | Allow source deletion without affecting target       |
| `delete target` | Delete the target objects when the source is deleted |

### Link Properties

Links can carry their own properties to store metadata about the relationship:

```sdl
module default {
  type User {
    multi friends: User {
      property nickname: str;
      property since: datetime {
        default := datetime_current();
      };
    };
    required name: str;
  };
};
```

Link properties are accessed in queries using the `@` prefix:

```edgeql
select User {
  friends: {
    name,
    @since,
    @nickname
  },
  name
};
```

### Abstract Links

Abstract links define reusable link templates with shared properties and constraints:

```sdl
module default {
  abstract link timestamped {
    property created_at: datetime {
      default := datetime_current();
    };
    property updated_at: datetime;
  };

  type User {
    multi friends extending timestamped -> User;
    required name: str;
  };
};
```

Concrete links that extend an abstract link inherit its properties and constraints. Properties defined on the concrete link override inherited ones with the same name.

---

## Indexes

Indexes improve query performance on frequently filtered or sorted properties.

### Property Indexes

```sdl
module default {
  type User {
    required email: str {
      constraint exclusive;
    };
    required name: str;

    # Index on the name property
    index on (.name);
  };
};
```

### Expression Indexes

Indexes can be defined on expressions, not just individual properties:

```sdl
module default {
  type User {
    required last_name: str;
    required first_name: str;

    # Index on a computed expression
    index on (str_lower(.email));

    # Composite index
    index on ((.last_name, .first_name));
  };
};
```

### Named Indexes

Indexes can be given explicit names:

```sdl
module default {
  type Product {
    required category: str;
    required name: str;
    required price: decimal;

    index product_category on (.category);
    index product_price on (.price);
  };
};
```

### Annotated Indexes

Indexes support annotations for documentation:

```sdl
module default {
  type User {
    required email: str;

    index on (.email) {
      annotation description := "Speeds up user lookups by email address";
      annotation title := "Email lookup index";
    };
  };
};
```

---

## Annotations

Annotations attach metadata to schema elements. They do not affect runtime behavior.

### Built-in Annotations

Disc supports three built-in annotations:

```sdl
module default {
  type User {
    annotation deprecated := "Use Account type instead";
    annotation description := "Represents a registered user in the system";
    annotation title := "Application User";

    required name: str {
      annotation description := "The user-visible display name";
      annotation title := "Display Name";
    };
  };
};
```

| Annotation    | Purpose                                       |
| ------------- | --------------------------------------------- |
| `deprecated`  | Marks the element as deprecated with a reason |
| `description` | Detailed description of the element           |
| `title`       | Short human-readable title                    |

### Abstract Annotation Declarations

You can define custom annotations for domain-specific metadata:

```sdl
module default {
  abstract annotation admin_note;
  abstract annotation pii;

  type User {
    annotation admin_note := "Synced from external IdP nightly";

    required email: str {
      annotation pii := "true";
    };
    required name: str {
      annotation pii := "true";
    };
  };
};
```

Abstract annotations are declared at the module level and can then be used on any type, property, link, index, or constraint.

### Annotations on Properties, Links, and Constraints

```sdl
module default {
  type Order {
    required customer: User {
      annotation description := "The customer who placed this order";
    };

    required total: decimal {
      annotation description := "Order total in the base currency";
    };

    constraint expression on (.total >= 0) {
      annotation title := "Non-negative total";
    };
  };
};
```

---

## Inheritance

Disc supports type inheritance, allowing you to share structure across types.

### Abstract Types

Abstract types cannot be instantiated directly. They serve as templates:

```sdl
module default {
  abstract type Timestamped {
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    updated_at: datetime {
      default := datetime_current();
    };
  };

  type User extending Timestamped {
    required email: str;
    required name: str;
  };

  type Post extending Timestamped {
    required body: str;
    required title: str;
  };
};
```

Both `User` and `Post` inherit `created_at` and `updated_at` from `Timestamped`.

> **Production semantics — per-subtype tables.** Disc's migration engine emits one PG table per concrete subtype; abstract types have no physical table. `SELECT <Abstract>` lowers to `UNION ALL` across the subtype tables (each branch projects the abstract's columns), and `IS Type` filters reduce to `__type__ = '<Type>'` over the union. The `__type__` discriminator column is added automatically to every type that participates in a hierarchy. See [EdgeQL → Polymorphic Queries](edgeql.md#polymorphic-queries) for how this affects compiled SQL and what polymorphic shape fields look like at runtime.

### Concrete Inheritance

Non-abstract types can also be extended:

```sdl
module default {
  type User {
    required email: str;
    required name: str;
  };

  type AdminUser extending User {
    required department: str;
    required permissions: json;
  };
};
```

`AdminUser` has all of `User`’s properties plus its own.

### Multiple Inheritance

A type can extend multiple parent types:

```sdl
module default {
  abstract type Timestamped {
    created_at: datetime {
      default := datetime_current();
    };
  };

  abstract type Authored {
    required author_name: str;
  };

  abstract type Slugged {
    required slug: str {
      constraint exclusive;
    };
  };

  type BlogPost extending Timestamped, Authored, Slugged {
    required body: str;
    required title: str;
  };
};
```

When a type extends multiple parents, it inherits properties and links from all of them. If two parents define a property with the same name, the child’s own definition takes precedence.

### Polymorphic Types and Discrimination

When a parent type has subtypes, Disc adds a `__type__` discriminator column to distinguish instances:

```sdl
module default {
  abstract type Shape {
    required color: str;
  };

  type Circle extending Shape {
    required radius: float64;
  };

  type Rectangle extending Shape {
    required height: float64;
    required width: float64;
  };
};
```

You can query polymorphically:

```edgeql
# Get all shapes
select Shape { color };

# Filter to specific subtypes
select Shape {
  color,
  [is Circle].radius,
  [is Rectangle].width,
  [is Rectangle].height
};
```

### Overloaded Properties

Use `overloaded` when redefining an inherited property to add constraints or change the default:

```sdl
module default {
  abstract type Named {
    required name: str;
  };

  type User extending Named {
    overloaded required name: str {
      constraint max_length(100);
    };
  };
};
```

---

## Access Policies

Access policies control which operations are allowed on objects based on runtime conditions. They provide row-level security.

### Basic Allow/Deny

```sdl
module default {
  type User {
    required email: str;
    required is_admin: bool {
      default := false;
    };
    required name: str;

    access policy admin_only {
      allow select, insert, update, delete;
      using (global current_user_is_admin);
    };
  };
};
```

### Policy Structure

An access policy has:

- A **name** for identification
- One or more **actions** (`allow` or `deny`) specifying which operations are affected
- A `using` **condition** expression evaluated at query time

### Supported Operations

| Operation | Description                       |
| --------- | --------------------------------- |
| `select`  | Reading objects                   |
| `insert`  | Creating new objects              |
| `update`  | Modifying existing objects        |
| `delete`  | Removing objects                  |
| `all`     | Shorthand for all four operations |

### Allow and Deny

```sdl
module default {
  type Document {
    required is_public: bool;
    required owner_id: uuid;
    required title: str;

    # Allow everyone to read public documents
    access policy public_read {
      allow select;
      using (.is_public = true);
    };

    # Allow owners full access to their documents
    access policy owner_access {
      allow all;
      using (.owner_id = global current_user_id);
    };

    # Deny delete for non-admins
    access policy no_delete {
      deny delete;
      using (not global current_user_is_admin);
    };
  };
};
```

### Using Globals in Policies

Access policies commonly reference global variables to check the identity of the current user:

```sdl
module default {
  global current_user_id: uuid;

  type User {
    required email: str;
    required name: str;

    access policy self_only {
      allow select, update;
      using (.id = global current_user_id);
    };
  };
};
```

Set the global at the session level before issuing queries:

```edgeql
set global current_user_id := <uuid>"a1b2c3d4-...";
```

### Multiple Policies

When multiple policies exist on a type, they interact as follows:

- If any `deny` policy matches, the operation is denied regardless of `allow` policies
- If no `deny` policy matches and at least one `allow` policy matches, the operation is allowed
- If no policies match at all, behavior depends on the system default

### Annotated Policies

```sdl
module default {
  type Secret {
    required value: str;

    access policy classified {
      annotation description := "Only admins can access secrets";
      allow all;
      using (global current_user_is_admin);
    };
  };
};
```

---

## Triggers

Triggers execute logic automatically in response to data changes.

### Trigger Syntax

```
trigger <name> after <events> for each do (<expression>);
```

### After Insert

```sdl
module default {
  type User {
    required email: str;
    required name: str;

    trigger log_creation after insert for each do (
      insert AuditLog {
        action := "user_created",
        entity_id := __new__.id
      }
    );
  };
};
```

### After Update

```sdl
module default {
  type User {
    required email: str;
    required name: str;

    trigger log_update after update for each do (
      insert AuditLog {
        action := "user_updated",
        entity_id := __new__.id
      }
    );
  };
};
```

### After Delete

```sdl
module default {
  type User {
    required name: str;

    trigger cleanup_sessions after delete for each do (
      delete Session filter .user_id = __old__.id
    );
  };
};
```

### Multiple Events

A single trigger can respond to multiple events:

```sdl
module default {
  type Document {
    required content: str;
    required title: str;

    trigger audit_changes after insert, update, delete for each do (
      insert AuditLog {
        action := "document_changed",
        timestamp := datetime_current()
      }
    );
  };
};
```

### Trigger Scope

| Scope      | Description                                       |
| ---------- | ------------------------------------------------- |
| `for each` | Fires once per affected row                       |
| `for all`  | Fires once per statement, regardless of row count |

```sdl
module default {
  type Order {
    required total: decimal;

    trigger notify_batch after insert for all do (
      select send_notification("new_orders_batch")
    );
  };
};
```

### Trigger Timing

| Timing   | Description                         |
| -------- | ----------------------------------- |
| `after`  | Fires after the operation completes |
| `before` | Fires before the operation executes |

---

## Rewrite Rules

Rewrite rules automatically transform property values during insert or update operations.

### Insert Rewrite

```sdl
module default {
  type User {
    created_at: datetime {
      rewrite insert using (datetime_current());
    };
    required name: str;
    slug: str {
      rewrite insert using (str_lower(.name));
    };
  };
};
```

### Update Rewrite

```sdl
module default {
  type User {
    required name: str;
    updated_at: datetime {
      rewrite update using (datetime_current());
    };
  };
};
```

### Combined Insert and Update

A single rewrite can apply to both operations:

```sdl
module default {
  type Post {
    required body: str;
    required title: str;
    modified_at: datetime {
      rewrite insert, update using (datetime_current());
    };
  };
};
```

Rewrite rules differ from default values in that they always apply, even if the user explicitly provides a value. They enforce invariants like "updated_at is always the current time on any modification."

---

## Globals

Globals are session-scoped variables available to all queries within a session. They are commonly used with access policies.

### Declaring Globals

```sdl
module default {
  global current_user_id: uuid;
  required global current_tenant_id: uuid;
  global debug_mode: bool;
};
```

### Globals with Defaults

```sdl
module default {
  global current_user_id: uuid;
  global page_size: int64 {
    default := 25;
  };
};
```

### Required Globals

A required global must be set before queries that reference it will succeed:

```sdl
module default {
  required global current_user_id: uuid;
};
```

### Readonly Globals

```sdl
module default {
  global server_start_time: datetime {
    default := datetime_current();
    readonly := true;
  };
};
```

### Setting Globals

Globals are set per-session using EdgeQL:

```edgeql
set global current_user_id := <uuid>"550e8400-e29b-41d4-a716-446655440000";
set global page_size := 50;
```

### Using Globals in Queries

```edgeql
select User filter .id = global current_user_id;
```

### Globals in Access Policies

```sdl
module default {
  global current_user_id: uuid;

  type UserProfile {
    required display_name: str;
    required user_id: uuid;

    access policy owner_only {
      allow all;
      using (.user_id = global current_user_id);
    };
  };
};
```

Disc stores each global as a PostgreSQL session setting using the naming convention `disc.global_<module>__<name>` (e.g., `disc.global_default__current_user_id`).

---

## Aliases

Aliases define named computed expressions that can be reused across queries. They act as virtual types or views.

### Basic Aliases

```sdl
module default {
  type User {
    required active: bool;
    required name: str;
  };

  alias ActiveUsers := User;
};
```

### Aliases with Expressions

```sdl
module default {
  type User {
    required active: bool;
    required email: str;
    required name: str;
    required role: str;
  };

  alias Admins := (select User filter .role = "admin");
  alias ActiveAdmins := (select User filter .role = "admin" and .active = true);
};
```

Aliases are resolved at query time. They do not create tables or store data.

---

## Collection Types

### Arrays

Arrays hold ordered sequences of values of a single type:

```sdl
module default {
  type User {
    favorite_colors: array<str>;   # ordered array of strings
    required name: str;
    multi tags: str;               # set of strings (unordered)
  };

  type Matrix {
    required labels: array<str>;
    required values: array<float64>;
  };
};
```

Supported array element types and their PostgreSQL mappings:

| SDL Array Type               | PostgreSQL Type      |
| ---------------------------- | -------------------- |
| `array<bigint>`              | `numeric[]`          |
| `array<bool>`                | `boolean[]`          |
| `array<bytes>`               | `bytea[]`            |
| `array<cal::local_date>`     | `date[]`             |
| `array<cal::local_datetime>` | `timestamp[]`        |
| `array<cal::local_time>`     | `time[]`             |
| `array<datetime>`            | `timestamptz[]`      |
| `array<decimal>`             | `numeric[]`          |
| `array<float32>`             | `real[]`             |
| `array<float64>`             | `double precision[]` |
| `array<int16>`               | `smallint[]`         |
| `array<int32>`               | `integer[]`          |
| `array<int64>`               | `bigint[]`           |
| `array<json>`                | `jsonb[]`            |
| `array<str>`                 | `text[]`             |
| `array<uuid>`                | `uuid[]`             |

### Tuples

Tuples hold fixed-size sequences of mixed types. They are stored as `jsonb` in PostgreSQL:

```sdl
module default {
  type GeoPoint {
    required coordinates: tuple<float64, float64>;
  };
};
```

### Named Tuples

Named tuples have labeled fields:

```sdl
module default {
  type User {
    address: tuple<street: str, city: str, zip: str>;
    required name: str;
  };
};
```

Named tuples are also stored as `jsonb` in PostgreSQL, preserving the field names as JSON keys.

---

## Range Types

Range types represent a continuous span of values. They map directly to PostgreSQL range types.

### Supported Range Types

| SDL Range Type               | PostgreSQL Type |
| ---------------------------- | --------------- |
| `range<cal::local_date>`     | `daterange`     |
| `range<cal::local_datetime>` | `tsrange`       |
| `range<datetime>`            | `tstzrange`     |
| `range<decimal>`             | `numrange`      |
| `range<float64>`             | `numrange`      |
| `range<int32>`               | `int4range`     |
| `range<int64>`               | `int8range`     |

### Using Ranges

```sdl
module default {
  type Event {
    required time_range: range<datetime>;
    required title: str;
  };

  type PriceRange {
    required effective_dates: range<cal::local_date>;
    required price_range: range<decimal>;
    required product_id: uuid;
  };
};
```

### Multirange Types

Multiranges hold multiple non-overlapping ranges:

| SDL Multirange Type               | PostgreSQL Type  |
| --------------------------------- | ---------------- |
| `multirange<cal::local_date>`     | `datemultirange` |
| `multirange<cal::local_datetime>` | `tsmultirange`   |
| `multirange<datetime>`            | `tstzmultirange` |
| `multirange<decimal>`             | `nummultirange`  |
| `multirange<float64>`             | `nummultirange`  |
| `multirange<int32>`               | `int4multirange` |
| `multirange<int64>`               | `int8multirange` |

```sdl
module default {
  type Schedule {
    required available_times: multirange<datetime>;
    required name: str;
  };
};
```

---

## Complete Example

Here is a realistic schema for a project management application that demonstrates many features together:

```sdl
module default {
  # -- Globals --
  global current_user_id: uuid;

  # -- Custom annotations --
  abstract annotation audit_trail;

  # -- Custom scalar types --
  scalar type Priority extending enum<low, medium, high, critical>;

  scalar type EmailAddress extending str {
    constraint regex("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$");
  };

  # -- Abstract types --
  abstract type Timestamped {
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    updated_at: datetime {
      rewrite insert, update using (datetime_current());
    };
  };

  abstract type Authored {
    required author: User;
  };

  # -- Core types --
  type User extending Timestamped {
    avatar_url: str;
    required email: EmailAddress {
      constraint exclusive;
    };
    is_admin: bool {
      default := false;
    };
    required name: str {
      constraint max_length(255);
    };

    # Reverse links (queried via .<author or .<assignee)
    multi assigned_tasks := .<assignee[is Task];
    multi projects := .<owner[is Project];

    # Indexes
    index on (.name);

    # Annotations
    annotation description := "A registered user who can own projects and be assigned tasks";
    annotation title := "Application User";

    # Access policies
    access policy self_read {
      allow select;
      using (.id = global current_user_id);
    };

    access policy admin_full {
      allow all;
      using (.is_admin = true);
    };
  };

  type Project extending Timestamped {
    archived: bool {
      default := false;
    };
    description: str;
    multi members: User {
      property joined_at: datetime {
        default := datetime_current();
      };
      property role: str {
        default := "member";
      };
    };
    required name: str {
      constraint max_length(100);
    };
    required owner: User;

    index on (.name);

    constraint exclusive on ((.owner, .name));

    trigger log_archive after update for each do (
      insert AuditEntry {
        action := "project_updated",
        entity_type := "Project"
      }
    );
  };

  type Task extending Timestamped, Authored {
    assignee: User;
    description: str;
    due_date: cal::local_date;
    estimated_hours: float64 {
      constraint min_value(0);
    };
    required priority: Priority;
    required project: Project;
    required status: str {
      default := "open";
      constraint one_of("open", "in_progress", "review", "done", "cancelled");
    };
    multi tags: str;
    required title: str {
      constraint max_length(500);
    };
    multi depends_on: Task;

    index on (.status);
    index on (.priority);
    index on (.due_date);

    annotation audit_trail := "full";
  };

  type Comment extending Timestamped, Authored {
    required body: str;
    required task: Task {
      on target delete cascade;
    };

    trigger notify_assignee after insert for each do (
      select send_notification(__new__.task)
    );
  };

  type AuditEntry {
    required action: str;
    actor_id: uuid;
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    required entity_type: str;
    entity_id: uuid;
    metadata: json;

    index on (.action);
    index on (.created_at);
  };

  # -- Aliases --
  alias OpenTasks := (
    select Task filter .status = "open"
  );

  alias HighPriorityTasks := (
    select Task filter .priority = Priority.high or .priority = Priority.critical
  );
};
```

This schema demonstrates:

- **Modules**: All types in the `default` module
- **Globals**: `current_user_id` for access policies
- **Custom scalar types**: `Priority` enum and `EmailAddress` with regex constraint
- **Abstract types**: `Timestamped` and `Authored` for shared structure
- **Multiple inheritance**: `Task` extends both `Timestamped` and `Authored`
- **Properties**: Required, optional, computed, readonly, with defaults and rewrites
- **Constraints**: `exclusive`, `max_length`, `min_value`, `one_of`, `regex`, expression-on
- **Links**: Single (`author`), multi (`members` with link properties, `depends_on`), deletion policies
- **Indexes**: On individual properties and multiple properties
- **Annotations**: Built-in and custom abstract annotations
- **Access policies**: Global-based row-level security
- **Triggers**: After insert and after update
- **Rewrite rules**: Auto-updating `updated_at` on insert and update
- **Aliases**: Computed views for common queries

---

## See Also

- [EdgeQL Reference](edgeql.md) -- query language for reading and writing data
- [Functions Reference](functions.md) -- built-in functions available in expressions
- [Migrations](migrations.md) -- generating and applying schema changes
- [Codegen](codegen.md) -- generating TypeScript types from your schema
