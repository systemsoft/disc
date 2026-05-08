# EdgeQL Cheat Sheet

One-page reference of the EdgeQL forms you reach for daily. For full prose and edge cases, see [EdgeQL](edgeql.md).

---

## SELECT

```edgeql
# All objects, default shape
select User;

# With a shape
select User { email, name };

# Nested shape (link traversal)
select User {
  email,
  name,
  posts: { title, created_at }
};

# Computed fields
select User {
  name,
  post_count := count(.posts),
  upper_name := str_upper(.name)
};

# Filter
select User { name } filter .email = "ada@example.com";

# Multiple conditions
select User { name } filter .active = true and .age >= 18;

# String matching
select User { name } filter .email like "%@example.com";

# Order, limit, offset
select User { name }
  order by .name
  limit 10
  offset 20;

# Multiple sort keys
select User { name }
  order by .last_name asc then .first_name asc;
```

## INSERT

```edgeql
# Single insert
insert User {
  email := "ada@example.com",
  name := "Ada"
};

# Insert with link (single)
insert Post {
  title := "Hello",
  body := "World",
  author := (select User filter .email = "ada@example.com")
};

# Insert with nested insert
insert Post {
  title := "Hello",
  author := (insert User {
    email := "billie@example.com",
    name := "Billie"
  })
};

# Upsert (insert or no-op)
insert User { email := "ada@example.com", name := "Ada" }
unless conflict on .email;

# Upsert with else (insert or update)
insert User { email := "ada@example.com", name := "Ada" }
unless conflict on .email
else (update User set { name := "Ada" });
```

## UPDATE

```edgeql
# Single property
update User
filter .email = "ada@example.com"
set { name := "Ada Lovelace" };

# Multiple properties
update User
filter .id = <uuid>$id
set {
  name := "Ada",
  active := true,
  updated_at := datetime_current()
};

# Computed values
update User
filter .id = <uuid>$id
set { login_count := .login_count + 1 };

# Update link target
update Post
filter .id = <uuid>$post_id
set { author := (select User filter .email = "new@example.com") };

# Update all matching
update User filter .active = false set { archived := true };
```

## DELETE

```edgeql
# Single
delete User filter .id = <uuid>$id;

# All matching
delete User filter .archived = true;

# Ordered with limit (delete oldest 10)
delete User
  filter .active = false
  order by .created_at asc
  limit 10;
```

## Parameters

```edgeql
# Typed parameter — required at compile time
select User filter .email = <str>$email;

# Multiple parameters
select Post
filter .author = <uuid>$author_id and .published = <bool>$published;

# Parameter in INSERT
insert User {
  email := <str>$email,
  name := <str>$name
};

# Optional parameter (use <optional T>)
select Post filter .title = <optional str>$search ?? .title;
```

Common parameter types: `str`, `int32`, `int64`, `bigint`, `float32`, `float64`, `bool`, `uuid`, `datetime`, `decimal`, `bytes`, `json`, `array<...>`, `tuple<...>`.

## Computed Properties (in shape)

```edgeql
select User {
  name,

  # Computed scalar
  display_name := .first_name ++ " " ++ .last_name,

  # Computed link traversal
  recent_posts := (
    select .posts
    order by .created_at desc
    limit 5
  )
};
```

## FOR Loops

```edgeql
# Insert many from a literal set
for name in {"Ada", "Billie", "Cher"}
union (
  insert User {
    email := str_lower(name) ++ "@example.com",
    name := name
  }
);

# Update each row in a query
for u in (select User filter .active = true)
union (
  update u set { last_checked := datetime_current() }
);

# Tuple iteration for batch insert
for item in {
  ("Widget A", 9.99),
  ("Widget B", 19.99)
}
union (
  insert Product { name := item.0, price := <decimal>item.1 }
);
```

## WITH Blocks

```edgeql
# Name a subquery, reference it later
with
  active := (select User filter .active = true),
  count_active := count(active)
select { total := count_active, users := active { name } };
```

## Transactions

Wrap a multi-statement unit via the SDK (the `disc shell` REPL also exposes `start transaction;` / `commit;` / `rollback;`):

```typescript
const result = await client.transaction(async tx => {
  const post = await tx.querySingle(
    `
    insert Post { title := <str>$t, body := <str>$b, author := <User>$a }
  `,
    { t: title, b: body, a: authorId }
  );

  await tx.execute(
    `
    update User filter .id = <uuid>$id
    set { post_count := .post_count + 1 }
  `,
    { id: authorId }
  );

  return post;
});
```

If the callback throws, Disc rolls back. If it returns, Disc commits.

## Aggregates

```edgeql
# count, sum, avg, min, max, all, any
select count(User);
select sum(User.age);
select avg(Post.score);

# Aggregation in a shape
select User {
  name,
  total_posts := count(.posts),
  highest_score := max(.posts.score)
};
```

## Operators (most-used)

| Operator      | Meaning                               |
| ------------- | ------------------------------------- |
| `=`           | Equality                              |
| `!=`          | Inequality                            |
| `<`, `<=`     | Less-than, less-or-equal              |
| `>`, `>=`     | Greater-than, greater-or-equal        |
| `++`          | String / array concatenation          |
| `??`          | Coalesce (fallback when set is empty) |
| `if … else …` | Conditional expression                |
| `like`        | SQL `LIKE` pattern match              |
| `ilike`       | Case-insensitive `like`               |
| `in`          | Membership test                       |
| `not`         | Logical negation                      |
| `and`, `or`   | Logical conjunction / disjunction     |
| `exists`      | True when set is non-empty            |

## Type Casts

```edgeql
# Cast literals
select <int64>"42";
select <decimal>"19.99";
select <uuid>"d290f1ee-6c54-4b01-90e6-d701748f0851";

# Cast in expressions
select User filter .id = <uuid>$id;
select Post { age_days := <int64>(datetime_current() - .created_at) / 86400 };
```

## EXPLAIN

```edgeql
analyze select User filter .email = "ada@example.com";
```

Returns the underlying PostgreSQL plan. Use it to verify an index is used. See [Performance → EXPLAIN](performance.md#explain).

## REPL meta-commands

In `disc shell`:

```
\?              # Show help
\d              # List object types in the schema (grouped by module)
\d User         # Detailed type info: properties, links, indexes, policies
\timing         # Toggle query timing
\i query.eql    # Execute statements from a file
\c another_db   # Connect to a different database
\q              # Quit
```

---

For longer prose, edge cases, and topics not covered here (window functions, polymorphic shapes, GROUP BY, set operations, DESCRIBE, CONFIGURE, globals), see [EdgeQL](edgeql.md).
