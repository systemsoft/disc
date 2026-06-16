# EdgeQL Reference

> Looking for a quick reference? See the [EdgeQL Cheat Sheet](edgeql-cheatsheet.md) for one-page copy-pasteable examples.

EdgeQL is the query language for Disc. It compiles to PostgreSQL SQL under the hood, but provides a cleaner syntax for expressing queries against your schema. EdgeQL is set-oriented: every expression produces a set of values, and operations compose naturally over sets.

---

## Table of Contents

- [SELECT](#select)
- [INSERT](#insert)
- [UPDATE](#update)
- [DELETE](#delete)
- [Parameters](#parameters)
- [Type Casts](#type-casts)
- [Operators](#operators)
- [IF/ELSE Expressions](#ifelse-expressions)
- [FOR Loops](#for-loops)
- [WITH Blocks](#with-blocks)
- [GROUP BY](#group-by)
- [Window Functions](#window-functions)
- [Set Operations](#set-operations)
- [Subqueries](#subqueries)
- [DETACHED](#detached)
- [Arrays and Tuples](#arrays-and-tuples)
- [Polymorphic Queries](#polymorphic-queries)
- [DESCRIBE](#describe)
- [EXPLAIN](#explain)
- [CONFIGURE](#configure)
- [SET GLOBAL](#set-global)
- [Functions](#functions)

---

## SELECT

The `select` statement retrieves data from the database. It is the most commonly used query type.

### Basic Select

Select all objects of a type:

```edgeql
select User;
```

This returns the set of all `User` objects. Without a shape, you get the default representation (typically just `id`).

### Select with Shape

Shapes specify which properties and links to include in the result:

```edgeql
select User {
  email,
  name
};
```

Each field in the shape corresponds to a property or link on the type.

### Nested Shapes

Shapes can be nested to traverse links:

```edgeql
select User {
  email,
  name,
  posts: {
    created_at,
    title
  }
};
```

This fetches each user along with their posts, including each post’s title and creation time. The result is a nested JSON structure.

### Deeply Nested Shapes

There is no limit to nesting depth:

```edgeql
select User {
  name,
  posts: {
    comments: {
      author: {
        name
      },
      body
    },
    title
  }
};
```

### Computed Fields

Shapes can include computed fields that do not exist as stored properties:

```edgeql
select User {
  email,
  name,
  name_upper := str_upper(.name),
  post_count := count(.posts)
};
```

Computed fields use the `:=` assignment syntax. The `.property` notation refers to the current object being selected.

### FILTER

Filter results based on a boolean expression:

```edgeql
select User {
  email,
  name
} filter .email = "ada@example.com";
```

Filter with multiple conditions:

```edgeql
select User {
  email,
  name
} filter .active = true and .age >= 18;
```

Filter with string matching:

```edgeql
select User {
  email,
  name
} filter .name like "A%";
```

Filter with link traversal:

```edgeql
select Post {
  body,
  title
} filter .author.name = "Ada";
```

### ORDER BY

Sort results:

```edgeql
select User {
  email,
  name
} order by .name;
```

Specify direction:

```edgeql
select User {
  created_at,
  name
} order by .created_at desc;
```

Multiple sort keys:

```edgeql
select User {
  email,
  name
} order by .last_name asc then .first_name asc;
```

Handle empty values:

```edgeql
select User {
  age,
  name
} order by .age asc empty last;
```

The `empty first` and `empty last` modifiers control where NULL/empty values sort.

### LIMIT and OFFSET

Paginate results:

```edgeql
select User {
  email,
  name
} order by .name
  limit 10;
```

Skip rows:

```edgeql
select User {
  email,
  name
} order by .name
  offset 20
  limit 10;
```

### SELECT DISTINCT

Remove duplicate values from the result set:

```edgeql
select distinct User.name;
```

### Combining Clauses

All clauses can be combined:

```edgeql
select User {
  email,
  name,
  post_count := count(.posts)
} filter .active = true
  order by .name asc
  offset 0
  limit 25;
```

---

## INSERT

The `insert` statement creates new objects.

### Basic Insert

```edgeql
insert User {
  email := "ada@example.com",
  name := "Ada"
};
```

The shape uses `:=` assignment for each property value.

### Insert with Links

```edgeql
insert Post {
  author := (select User filter .email = "ada@example.com"),
  body := "This is my first post.",
  title := "Hello World"
};
```

Link values are set using a subquery that resolves to the target object.

### Insert with Nested Insert

You can insert linked objects in the same statement:

```edgeql
insert User {
  email := "billie@example.com",
  name := "Billie",
  posts := (insert Post {
    body := "Content here.",
    title := "Billie’s First Post"
  })
};
```

### UNLESS CONFLICT (Upsert)

Handle conflicts on unique constraints:

```edgeql
insert User {
  email := "ada@example.com",
  name := "Ada"
} unless conflict on .email
  else (
    update User set {
      name := "Ada"
    }
  );
```

When a conflict on `.email` is detected, the `else` clause runs instead. This implements an upsert pattern: insert if the email does not exist, otherwise update the existing row.

### UNLESS CONFLICT without ELSE

Silently skip the insert if a conflict occurs:

```edgeql
insert User {
  email := "ada@example.com",
  name := "Ada"
} unless conflict on .email;
```

Without an `else` clause, a conflicting insert is simply ignored.

---

## UPDATE

The `update` statement modifies existing objects.

### Basic Update

```edgeql
update User
filter .email = "ada@example.com"
set {
  name := "Ada Smith"
};
```

### Update Multiple Properties

```edgeql
update User
filter .id = <uuid>"550e8400-e29b-41d4-a716-446655440000"
set {
  active := false,
  bio := "New bio text",
  name := "Updated Name"
};
```

### Update with Computed Values

```edgeql
update User
filter .active = true
set {
  last_seen := datetime_current()
};
```

### Update Links

```edgeql
update Post
filter .title = "Hello World"
set {
  author := (select User filter .email = "billie@example.com")
};
```

### Update All Matching Objects

Without a filter, the update applies to all objects of the type:

```edgeql
update User
set {
  active := false
};
```

---

## DELETE

The `delete` statement removes objects.

### Basic Delete

```edgeql
delete User
filter .email = "ada@example.com";
```

### Delete with ORDER BY and LIMIT

Delete a limited number of objects:

```edgeql
delete User
filter .active = false
order by .created_at asc
limit 100;
```

This is useful for batch cleanup operations.

### Delete All

Delete all objects of a type (use with caution):

```edgeql
delete User;
```

---

## Parameters

Parameters allow you to pass values into queries at execution time, preventing SQL injection and enabling prepared statements.

### Typed Parameters

Parameters are prefixed with `$` and require a type annotation using angle brackets:

```edgeql
select User {
  email,
  name
} filter .email = <str>$email;
```

### Multiple Parameters

```edgeql
select User {
  email,
  name
} filter .name = <str>$name and .age >= <int64>$min_age;
```

### Parameters in INSERT

```edgeql
insert User {
  age := <int64>$age,
  email := <str>$email,
  name := <str>$name
};
```

### Parameters in UPDATE

```edgeql
update User
filter .id = <uuid>$user_id
set {
  name := <str>$new_name
};
```

### Supported Parameter Types

Any scalar type can be used as a parameter type:

```edgeql
# String parameter
<str>$name

# Integer parameters
<int16>$small_val
<int32>$int_val
<int64>$big_val

# Float parameters
<float32>$approx
<float64>$precise

# Other types
<bool>$flag
<uuid>$id
<datetime>$timestamp
<json>$data
```

---

## Type Casts

Type casts convert values from one type to another. They use angle bracket syntax.

### Basic Casts

```edgeql
# String to integer
select <int64>"42";

# String to float
select <float64>"3.14";

# String to boolean
select <bool>"true";

# String to datetime
select <datetime>"2024-01-15T10:30:00Z";

# String to UUID
select <uuid>"550e8400-e29b-41d4-a716-446655440000";

# Integer to string
select <str>42;

# Integer to float
select <float64>42;
```

### Casts in Expressions

```edgeql
select User {
  name,
  age_text := <str>.age
} filter .id = <uuid>$user_id;
```

### Calendar Type Casts

```edgeql
select <cal::local_date>"2024-03-15";
select <cal::local_time>"14:30:00";
select <cal::local_datetime>"2024-03-15T14:30:00";
```

### JSON Casts

```edgeql
select <json>{"key": "value"};
select <str><json>"hello";
```

---

## Operators

EdgeQL supports a comprehensive set of operators.

### Arithmetic Operators

| Operator | Description    | Example           |
| -------- | -------------- | ----------------- |
| `+`      | Addition       | `select 2 + 3;`   |
| `-`      | Subtraction    | `select 10 - 4;`  |
| `*`      | Multiplication | `select 3 * 7;`   |
| `/`      | Division       | `select 10 / 3;`  |
| `//`     | Floor division | `select 10 // 3;` |
| `%`      | Modulo         | `select 10 % 3;`  |
| `**`     | Exponentiation | `select 2 ** 10;` |

Unary minus:

```edgeql
select -42;
select -.price;
```

### Comparison Operators

| Operator | Description                         | Example               |
| -------- | ----------------------------------- | --------------------- |
| `=`      | Equal                               | `.name = "Ada"`       |
| `!=`     | Not equal                           | `.status != "active"` |
| `<`      | Less than                           | `.age < 18`           |
| `>`      | Greater than                        | `.price > 100`        |
| `<=`     | Less than or equal                  | `.quantity <= 0`      |
| `>=`     | Greater than or equal               | `.age >= 21`          |
| `?=`     | Equal (treating empty as equal)     | `.value ?= {}`        |
| `?!=`    | Not equal (treating empty as equal) | `.value ?!= {}`       |

The `?=` and `?!=` operators handle empty sets gracefully. `a ?= b` returns `true` when both `a` and `b` are empty, while `a = b` returns an empty set.

### Logical Operators

| Operator | Description | Example                                  |
| -------- | ----------- | ---------------------------------------- |
| `and`    | Logical AND | `.active = true and .age >= 18`          |
| `or`     | Logical OR  | `.role = "admin" or .role = "moderator"` |
| `not`    | Logical NOT | `not .active`                            |

```edgeql
select User filter .active = true and (
  .role = "admin" or .role = "moderator"
);
```

### String Concatenation

The `++` operator concatenates strings:

```edgeql
select "Hello, " ++ "world!";
select User { full_name := .first_name ++ " " ++ .last_name };
```

### Membership Operators

| Operator | Description    | Example                                |
| -------- | -------------- | -------------------------------------- |
| `in`     | Set membership | `.status in {"active", "pending"}`     |
| `not in` | Not in set     | `.role not in {"banned", "suspended"}` |

```edgeql
select User filter .status in {"active", "pending"};
select User filter .email not in {"spam@example.com", "test@example.com"};
```

### Type Check Operators

| Operator | Description        | Example                |
| -------- | ------------------ | ---------------------- |
| `is`     | Type check         | `.author is AdminUser` |
| `is not` | Negated type check | `.shape is not Circle` |

```edgeql
select Shape filter Shape is Circle;
select Shape filter Shape is not Rectangle;
```

### Pattern Matching

| Operator | Description                    | Example               |
| -------- | ------------------------------ | --------------------- |
| `like`   | Case-sensitive pattern match   | `.name like "A%"`     |
| `ilike`  | Case-insensitive pattern match | `.name ilike "%ada%"` |

Pattern wildcards:

- `%` matches any sequence of characters
- `_` matches any single character

```edgeql
select User filter .name like "A%";
select User filter .email ilike "%@example.com";
select User filter .name like "J_n";
```

### Regex Operators

| Operator | Description                        | Example              |
| -------- | ---------------------------------- | -------------------- |
| `~`      | Regex match (case-sensitive)       | `.email ~ "^[a-z]"`  |
| `!~`     | Regex not match (case-sensitive)   | `.name !~ "^test"`   |
| `~*`     | Regex match (case-insensitive)     | `.name ~* "ada"`     |
| `!~*`    | Regex not match (case-insensitive) | `.domain !~* "spam"` |

```edgeql
select User filter .email ~ "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$";
select User filter .name ~* "ada";
```

### Bitwise Operators

| Operator | Description         | Example            |
| -------- | ------------------- | ------------------ |
| `&`      | Bitwise AND         | `select 12 & 10;`  |
| `\|`     | Bitwise OR          | `select 12 \| 10;` |
| `^`      | Bitwise XOR         | `select 12 ^ 10;`  |
| `<<`     | Left shift          | `select 1 << 4;`   |
| `>>`     | Right shift         | `select 16 >> 2;`  |
| `~`      | Bitwise NOT (unary) | `select ~42;`      |

### Coalesce Operator

The `??` operator returns the first non-empty value:

```edgeql
select User {
  display_name := .nickname ?? .name ?? "Anonymous"
};
```

### Set Existence

| Operator   | Description              | Example                                     |
| ---------- | ------------------------ | ------------------------------------------- |
| `exists`   | True if set is non-empty | `exists (select User filter .admin = true)` |
| `distinct` | Remove duplicates        | `select distinct User.name`                 |

```edgeql
# Check if any admin users exist
select exists (select User filter .is_admin = true);

# Get distinct city names
select distinct User.city;
```

### Range Operators

| Operator | Description        |
| -------- | ------------------ |
| `@>`     | Range contains     |
| `<@`     | Range contained by |
| `&&`     | Range overlaps     |
| `-\|-`   | Range adjacent     |

```edgeql
select Event filter .time_range @> <datetime>"2024-06-15T12:00:00Z";
```

### Operator Precedence (highest to lowest)

1. Unary: `+`, `-`, `not`, `exists`, `distinct`, `~`
2. Exponentiation: `**`
3. Multiplicative: `*`, `/`, `//`, `%`
4. Additive: `+`, `-`, `++`
5. Comparison: `=`, `!=`, `<`, `>`, `<=`, `>=`, `?=`, `?!=`
6. Membership: `in`, `not in`, `is`, `is not`, `like`, `ilike`
7. Regex: `~`, `!~`, `~*`, `!~*`
8. Logical AND: `and`
9. Logical OR: `or`
10. Coalesce: `??`

Use parentheses to override precedence when needed.

---

## IF/ELSE Expressions

EdgeQL uses a ternary-style if/else expression. The syntax places the "then" value first:

```
<value_if_true> if <condition> else <value_if_false>
```

### Basic Usage

```edgeql
select User {
  label := "Adult" if .age >= 18 else "Minor",
  name
};
```

### In Filter Expressions

```edgeql
select User {
  name,
  status_label := "Active" if .active else "Inactive"
};
```

### Nested IF/ELSE

```edgeql
select User {
  name,
  tier := "gold" if .points >= 1000
    else "silver" if .points >= 500
    else "bronze" if .points >= 100
    else "basic"
};
```

### In Computed Values

```edgeql
select Product {
  discount_price := .price * 0.8 if .on_sale else .price,
  name,
  price
};
```

---

## FOR Loops

The `for` statement iterates over a set and produces a result for each element.

### Basic FOR Loop

```edgeql
for name in {"Ada", "Billie", "Cher"}
union (
  insert User {
    email := str_lower(name) ++ "@example.com",
    name := name
  }
);
```

### Batch Insert

```edgeql
for item in {
  ("Widget A", 9.99),
  ("Widget B", 19.99),
  ("Widget C", 29.99)
}
union (
  insert Product {
    price := <decimal>item.1,
    name := item.0
  }
);
```

### FOR with Subquery

```edgeql
for user in (select User filter .active = true)
union (
  update user
  set {
    last_checked := datetime_current()
  }
);
```

The `for` variable (`user`) binds to each element of the iterator set. The body query is evaluated once per element, and the results are unioned together.

---

## WITH Blocks

`with` blocks define named subexpressions (Common Table Expressions) that can be referenced in the main query.

### Named Subqueries

```edgeql
with
  active_users := (select User filter .active = true)
select active_users {
  name,
  email
} order by .name;
```

### Multiple Bindings

```edgeql
with
  ada := (select User filter .name = "Ada"),
  ada_posts := (select Post filter .author = ada)
select ada_posts {
  title,
  created_at
};
```

### WITH MODULE

Set the default module for unqualified type names within the query:

```edgeql
with module payment
select Payment {
  amount,
  currency
};
```

This is equivalent to `select payment::Payment { ... }` but avoids repeating the module prefix.

### WITH MODULE and Bindings

```edgeql
with
  module payment,
  recent := (select Payment filter .created_at > <datetime>"2024-01-01T00:00:00Z")
select recent {
  amount,
  currency
};
```

### Recursive CTEs (WITH RECURSIVE)

For hierarchical or graph data, use recursive `WITH` bindings:

```edgeql
with
  recursive categories := (
    select Category filter .parent_id = <uuid>$root_id
    union
    select Category filter .parent_id in categories.id
  )
select categories {
  depth,
  name
};
```

The `recursive` modifier tells Disc to generate a `WITH RECURSIVE` CTE in the compiled SQL.

---

## GROUP BY

The `group` statement groups objects and computes aggregate values.

### Basic Grouping

```edgeql
group User
using status := .status
by status;
```

### Grouping with Aggregates

```edgeql
group User {
  status,
  user_count := count(User)
}
using status := .status
by status;
```

### Multiple Group Keys

```edgeql
group Order {
  status,
  year,
  total_revenue := sum(.amount),
  order_count := count(Order)
}
using
  status := .status,
  year := datetime_get(.created_at, "year")
by status, year;
```

### HAVING (Filter on Groups)

Filter groups after aggregation:

```edgeql
group User {
  city,
  user_count := count(User)
}
using city := .city
by city
filter count(User) > 10;
```

---

## Window Functions

Window functions perform calculations across a set of rows related to the current row, without collapsing them into groups.

### Basic Window Function

```edgeql
select User {
  email,
  name,
  row_num := row_number() over (order by .name)
};
```

### PARTITION BY

Partition the window into groups:

```edgeql
select User {
  department,
  dept_rank := rank() over (
    partition by .department
    order by .salary desc
  ),
  name
};
```

### Available Window Functions

| Function                      | Description                            |
| ----------------------------- | -------------------------------------- |
| `row_number()`                | Sequential row number within partition |
| `rank()`                      | Rank with gaps for ties                |
| `dense_rank()`                | Rank without gaps                      |
| `ntile(n)`                    | Distribute rows into `n` buckets       |
| `lag(expr, offset, default)`  | Value from a previous row              |
| `lead(expr, offset, default)` | Value from a following row             |
| `first_value(expr)`           | First value in the frame               |
| `last_value(expr)`            | Last value in the frame                |

Aggregate functions can also be used as window functions when combined with `over`:

| Function      | Description     |
| ------------- | --------------- |
| `count(expr)` | Running count   |
| `sum(expr)`   | Running sum     |
| `avg(expr)`   | Running average |
| `min(expr)`   | Running minimum |
| `max(expr)`   | Running maximum |

### Frame Clauses

Control which rows are included in the window frame:

```edgeql
select Sale {
  date,
  amount,
  running_total := sum(.amount) over (
    order by .date
    rows between unbounded preceding and current row
  ),
  moving_avg := avg(.amount) over (
    order by .date
    rows between 6 preceding and current row
  )
};
```

#### Frame Modes

| Mode     | Description          |
| -------- | -------------------- |
| `rows`   | Physical row offsets |
| `range`  | Logical value ranges |
| `groups` | Peer group offsets   |

#### Frame Bounds

| Bound                 | Description                  |
| --------------------- | ---------------------------- |
| `unbounded preceding` | Start of partition           |
| `N preceding`         | N rows/values before current |
| `current row`         | The current row              |
| `N following`         | N rows/values after current  |
| `unbounded following` | End of partition             |

#### EXCLUDE Clause

```edgeql
select Sale {
  amount,
  date,
  peers_sum := sum(.amount) over (
    order by .date
    rows between unbounded preceding and current row
    exclude current row
  )
};
```

| Exclude Option        | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `exclude current row` | Exclude the current row                                         |
| `exclude group`       | Exclude the current row’s peer group                            |
| `exclude ties`        | Exclude peers of the current row but not the current row itself |
| `exclude no others`   | Default, exclude nothing                                        |

### Lag and Lead

Access values from neighboring rows:

```edgeql
select Sale {
  amount,
  change := .amount - lag(.amount, 1, 0) over (order by .date),
  date,
  next_amount := lead(.amount, 1) over (order by .date),
  prev_amount := lag(.amount, 1) over (order by .date)
};
```

### Practical Example

Running totals and moving averages:

```edgeql
select MonthlyRevenue {
  month,
  revenue,
  cumulative := sum(.revenue) over (
    order by .month
    rows between unbounded preceding and current row
  ),
  three_month_avg := avg(.revenue) over (
    order by .month
    rows between 2 preceding and current row
  ),
  rank := rank() over (order by .revenue desc)
};
```

---

## Set Operations

EdgeQL supports standard set operations that combine the results of multiple queries.

### UNION

Combine two sets:

```edgeql
select User filter .role = "admin"
union
select User filter .role = "moderator";
```

### INTERSECT

Return only elements present in both sets:

```edgeql
select User filter .active = true
intersect
select User filter .role = "admin";
```

### EXCEPT

Return elements in the first set that are not in the second:

```edgeql
select User filter .active = true
except
select User filter .role = "banned";
```

### Chaining Set Operations

```edgeql
select User filter .department = "Engineering"
union
select User filter .department = "Design"
except
select User filter .active = false;
```

---

## Subqueries

Any query can be used as an expression inside another query.

### Subquery in FILTER

```edgeql
select User {
  email,
  name
} filter .id in (
  select Post.author.id filter .created_at > <datetime>"2024-01-01T00:00:00Z"
);
```

### EXISTS with Subquery

```edgeql
select User {
  name
} filter exists (
  select Post filter .author = User and .published = true
);
```

### Scalar Subquery

A subquery that returns a single scalar value:

```edgeql
select User {
  name,
  post_count := count((select Post filter .author = User))
};
```

### Subquery in INSERT

```edgeql
insert Notification {
  message := "New post published",
  recipients := (select User filter .subscribed = true)
};
```

---

## DETACHED

The `detached` keyword removes an expression from the current scope, allowing you to reference a type independently of the query’s implicit scope.

### Basic Usage

```edgeql
select User {
  name,
  total_users := count(detached User)
};
```

Without `detached`, `count(User)` would be scoped to the current `User` being selected (always 1). With `detached`, it counts all users in the database.

### Self-Referencing Queries

```edgeql
select User {
  name,
  email,
  is_unique_name := not exists (
    select detached User
    filter .name = User.name and .id != User.id
  )
};
```

### Cross-Type Queries

```edgeql
select User {
  global_post_count := count(detached Post),
  name
};
```

---

## Arrays and Tuples

### Array Literals

```edgeql
select [1, 2, 3, 4, 5];
select ["red", "green", "blue"];
```

### Array Indexing

Access individual elements using zero-based indexing:

```edgeql
select [10, 20, 30, 40][0];    # Returns 10
select [10, 20, 30, 40][2];    # Returns 30
select [10, 20, 30, 40][-1];   # Returns 40 (last element)
```

### Array Slicing

Extract sub-arrays with `[start:end]` syntax:

```edgeql
select [10, 20, 30, 40, 50][1:3];   # Returns [20, 30]
select [10, 20, 30, 40, 50][:2];    # Returns [10, 20]
select [10, 20, 30, 40, 50][3:];    # Returns [40, 50]
```

### Array Functions

```edgeql
# Get array length
select len(<array<str>>["a", "b", "c"]);

# Aggregate into array
select array_agg(User.name order by User.name);

# Unpack array to set
select array_unpack([1, 2, 3]);

# Join array elements into string
select array_join(["hello", "world"], " ");

# Split string into array
select str_split("hello,world,foo", ",");
```

### Tuple Literals

```edgeql
select (1, "hello", true);
select (3.14, 42);
```

### Tuple Element Access

Access tuple elements by zero-based index:

```edgeql
select (10, "hello", true).0;    # Returns 10
select (10, "hello", true).1;    # Returns "hello"
select (10, "hello", true).2;    # Returns true
```

### Named Tuples

```edgeql
select (name := "Ada", age := 30, active := true);
```

### Named Tuple Field Access

Access fields by name:

```edgeql
select (name := "Ada", age := 30).name;   # Returns "Ada"
select (name := "Ada", age := 30).age;    # Returns 30
```

### Arrays and Tuples in Shapes

```edgeql
select User {
  info := (name := .name, email := .email, post_count := count(.posts)),
  name
};
```

---

## Polymorphic Queries

Polymorphic queries let you work with type hierarchies and select properties specific to subtypes.

### Type Filtering with `[is Type]`

```edgeql
select Shape {
  color,
  [is Circle].radius,
  [is Rectangle].width,
  [is Rectangle].height
};
```

This selects all `Shape` objects. For objects that are `Circle`, the `radius` field is populated. For `Rectangle` objects, `width` and `height` are populated. For other shapes, those fields are empty.

### Filtering by Type

```edgeql
# Select only circles
select Shape[is Circle] {
  color,
  radius
};

# Select only rectangles
select Shape[is Rectangle] {
  color,
  height,
  width
};
```

### Type Checking with IS

```edgeql
select Shape {
  color,
  shape_type := "circle" if Shape is Circle
    else "rectangle" if Shape is Rectangle
    else "unknown"
};
```

### IS NOT

```edgeql
select Shape filter Shape is not Circle;
```

### How polymorphic SELECT compiles

Disc’s migration engine creates one PG table per concrete subtype — there’s no physical table for the abstract parent. `SELECT <Abstract>` lowers to a `UNION ALL` across the subtype tables; each branch projects the abstract type’s properties (`id`, plus shared columns like `color`) so the outer SELECT can reference the abstract’s alias as if it were a regular table.

When the SELECT shape uses `[is Subtype].property` to access a subtype-specific column, each UNION branch projects either the actual column (when its subtype owns it) or `NULL::<pg-type> AS <colName>` (when it doesn’t), so PG’s UNION column-resolution unifies. The outer compiler emits `CASE WHEN __type__ = '<Subtype>' THEN <alias>.<col> ELSE NULL END` to gate the value on the actual row type.

```sql
-- Compiled shape of `select Shape { color, [is Circle].radius }`:
SELECT
  jsonb_build_object(
    'color', shape_1.color,
    'radius', CASE WHEN shape_1.__type__ = 'Circle' THEN shape_1.radius ELSE NULL END
  )
FROM (
  SELECT id, __type__, color, radius FROM circles
  UNION ALL
  SELECT id, __type__, color, NULL::double precision AS radius FROM rectangles
) AS shape_1;
```

The `__type__` column is emitted automatically on every type that participates in a hierarchy (DDL detail in `migration/ddl.ts:398-412`), defaulting to the type’s own name. The `IS Type` filter (`filter .id IS Circle` or `Shape[IS Circle]`) reduces to `__type__ = '<Type>'` over the same UNION, with `__type__ IN (...)` when the named type has its own subtypes.

---

## DESCRIBE

Introspect schema information at query time.

### DESCRIBE TYPE

Get information about a specific type:

```edgeql
describe type User;
```

Returns a JSON representation of the type’s properties, links, constraints, indexes, and other metadata.

### DESCRIBE SCHEMA

Get information about the entire schema:

```edgeql
describe schema;
```

Returns a JSON representation of all types, functions, globals, and other schema objects.

---

## EXPLAIN

Analyze query execution plans.

### Basic EXPLAIN

```edgeql
explain select User { email, name } filter .active = true;
```

Returns the PostgreSQL query execution plan for the compiled SQL.

### EXPLAIN ANALYZE

Execute the query and include actual timing information:

```edgeql
explain analyze select User { email, name } filter .active = true;
```

### EXPLAIN Options

```edgeql
# Include buffer usage information
explain (analyze, buffers) select User { email, name };

# Output as JSON
explain (format json) select User { email, name };

# Available formats: TEXT, JSON, YAML, XML
explain (format yaml) select User { email, name };
```

---

## CONFIGURE

Set configuration parameters at various scopes.

### Session Configuration

Settings that apply to the current connection:

```edgeql
configure session set query_execution_timeout := "30s";
```

### Database Configuration

Settings that apply to the entire database:

```edgeql
configure database set work_mem := "256MB";
```

### System/Instance Configuration

Settings that apply to the entire Disc instance:

```edgeql
configure system set max_connections := 200;
configure instance set shared_buffers := "1GB";
```

### Reset Configuration

Reset a setting to its default value:

```edgeql
configure session reset query_execution_timeout;
```

### Available Configuration Keys

| Key                                   | Description                           |
| ------------------------------------- | ------------------------------------- |
| `effective_cache_size`                | Planner’s estimate of available cache |
| `idle_in_transaction_session_timeout` | Timeout for idle transactions         |
| `listen_addresses`                    | Network interfaces to listen on       |
| `lock_timeout`                        | Maximum wait time for locks           |
| `maintenance_work_mem`                | Memory for maintenance operations     |
| `max_connections`                     | Maximum concurrent connections        |
| `query_execution_timeout`             | Maximum query execution time          |
| `shared_buffers`                      | Shared memory for caching             |
| `work_mem`                            | Memory for sort and hash operations   |

These map to PostgreSQL GUC parameters under the hood.

---

## SET GLOBAL

Set global session variables. These are used by access policies and can be referenced in queries.

### Setting a Global

```edgeql
set global current_user_id := <uuid>"550e8400-e29b-41d4-a716-446655440000";
```

### Setting Globals in Different Modules

```edgeql
set global default::current_user_id := <uuid>"550e8400-e29b-41d4-a716-446655440000";
set global auth::session_token := "abc123";
```

### Using Globals in Queries

```edgeql
select User filter .id = global current_user_id;
```

Globals are stored as PostgreSQL session settings using the naming convention `disc.global_<module>__<name>`.

---

## Functions

EdgeQL includes a standard library of built-in functions. This section provides a brief overview. See the [Functions Reference](functions.md) for complete documentation.

### Aggregate Functions

```edgeql
select count(User);
select sum(Order.amount);
select avg(User.age);
select min(Product.price);
select max(Product.price);
select array_agg(User.name);
select stddev(Measurement.value);
```

### String Functions

```edgeql
select len("hello");                       # 5
select str_lower("HELLO");                 # "hello"
select str_upper("hello");                 # "HELLO"
select str_trim("  hello  ");              # "hello"
select str_replace("hello world", "world", "disc"); # "hello disc"
select str_split("a,b,c", ",");            # ["a", "b", "c"]
select str_starts_with("hello", "hel");    # true
select str_ends_with("hello", "llo");      # true
select contains("hello world", "world");   # true
select find("hello world", "world");       # 6
select str_pad_start("42", 5, "0");        # "00042"
select str_pad_end("hi", 5, "!");          # "hi!!!"
select str_repeat("ha", 3);                # "hahaha"
select str_title("hello world");           # "Hello World"
```

### Math Functions

```edgeql
select math_abs(-42);          # 42
select math_ceil(3.2);         # 4
select math_floor(3.8);        # 3
select round(3.5);             # 4
select math_sqrt(16);          # 4
select math_pow(2, 10);        # 1024
select math_log(10, 100);      # 2
select math_ln(2.718281828);   # ~1
select math_pi();              # 3.14159...
```

### Datetime Functions

```edgeql
select datetime_current();
select datetime_of_statement();
select datetime_of_transaction();
select datetime_get(<datetime>"2024-06-15T10:30:00Z", "hour"); # 10
select datetime_truncate(<datetime>"2024-06-15T10:30:45Z", "hour");
```

### Type Conversion Functions

```edgeql
select to_str(42);
select to_int64("42");
select to_float64("3.14");
select to_bool("true");
select to_uuid("550e8400-e29b-41d4-a716-446655440000");
select to_datetime("2024-01-15T00:00:00Z");
select to_json('{"key": "value"}');
```

### JSON Functions

```edgeql
select json_typeof(<json>"42");          # "number"
select json_get(<json>'{"a":1}', "a");   # 1
select json_array_unpack(<json>"[1,2,3]");
```

### Regex Functions

```edgeql
select re_test("^[a-z]+$", "hello");      # true
select re_match("[0-9]+", "abc123def");   # ["123"]
select re_replace("[0-9]+", "NUM", "abc123def"); # "abcNUMdef"
```

### Array Functions

```edgeql
select array_agg(User.name);
select array_unpack([1, 2, 3]);
select array_join(["a", "b", "c"], ",");   # "a,b,c"
select array_get([10, 20, 30], 1);         # 20
```

### Range Functions

```edgeql
select range(1, 10);
select range_get_lower(range(1, 10));            # 1
select range_get_upper(range(1, 10));            # 10
select range_is_empty(range(1, 1));              # true
select range_is_inclusive_lower(range(1, 10));   # true
select range_is_inclusive_upper(range(1, 10));   # false
select overlaps(range(1, 5), range(3, 8));       # true
```

### UUID Functions

```edgeql
select uuid_generate_v4();
```

### Assertion Functions

```edgeql
# Raises an error if the result is empty
select assert_exists(
  (select User filter .email = "ada@example.com")
);

# Raises an error if the result contains more than one element
select assert_single(
  (select User filter .email = "ada@example.com")
);
```

### Schema Introspection Functions

```edgeql
# List all types in the schema
select schema::types();

# Get info about a specific type
select schema::get_type("User");

# List all functions
select schema::functions();
```

For the complete function reference with all parameters and return types, see [Functions Reference](functions.md).

---

## Query Composition Examples

### Complex Select with Multiple Features

```edgeql
with
  active_users := (select User filter .active = true),
  recent_cutoff := <datetime>"2024-01-01T00:00:00Z"
select active_users {
  email,
  is_prolific := count(.posts) > 10,
  latest_post_date := max(.posts.created_at),
  name,
  recent_posts := (
    select .posts {
      comment_count := count(.comments),
      created_at,
      title
    }
    filter .created_at > recent_cutoff
    order by .created_at desc
    limit 5
  ),
  total_posts := count(.posts)
}
filter count(.posts) > 0
order by count(.posts) desc
limit 20;
```

### Upsert Pattern

```edgeql
with
  email := <str>$email,
  name := <str>$name
insert User {
  email := email,
  name := name
} unless conflict on .email
  else (
    update User set {
      last_login := datetime_current(),
      name := name
    }
  );
```

### Batch Operations with FOR

```edgeql
with
  user_data := <json>$users
for item in json_array_unpack(user_data)
union (
  insert User {
    email := <str>json_get(item, "email"),
    name := <str>json_get(item, "name")
  }
);
```

### Recursive Category Tree

```edgeql
with
  recursive tree := (
    select Category filter .parent_id = <uuid>$root_id
    union
    select Category filter .parent_id in tree.id
  )
select tree {
  name,
  parent_id,
  depth
} order by .name;
```

### Analytics Query

```edgeql
with
  module default,
  start := <datetime>$start_date,
  end := <datetime>$end_date
group Order {
  avg_order := avg(.amount),
  month := datetime_truncate(.created_at, "month"),
  order_count := count(Order),
  top_product := (
    select .items.product.name
    order by .items.quantity desc
    limit 1
  ),
  total_revenue := sum(.amount)
}
using month := datetime_truncate(.created_at, "month")
by month
filter .created_at >= start and .created_at < end;
```

---

## See Also

- [Schema Reference](schema.md) -- defining your data model
- [Functions Reference](functions.md) -- complete function documentation
- [Migrations](migrations.md) -- schema change management
- [Client SDK](client-sdk.md) -- using EdgeQL from TypeScript
