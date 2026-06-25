# Filter API

The generated `client.<type>.filter()` method takes a single object whose shape mirrors your schema. Object keys are implicit-AND across fields, scalar fields accept either a bare value (equality) or a Mongo-style operator object, links recurse into the target type, and reserved keys (`select`, `order_by`, `limit`, `offset`) shape the query result.

The API is designed so most queries read like data — no string EdgeQL, no expression DSL, no `.run()` step. For the cases that do need composition (`OR`, negation, mixed predicates), three combinators (`and`, `or`, `not`) wrap Filter objects.

Related documentation: [Codegen](codegen.md) | [Client SDK](client-sdk.md) | [EdgeQL](edgeql.md)

---

## The shape

```ts
import DiscClient from "./dbschema/disc-client";

const client = new DiscClient(/* config */);

const merchants = await client.merchant.filter({
  email: "user@example.com",
  active: true
});
```

That object compiles to roughly `select Merchant { * } filter .email = <str>$p0 and .active = <bool>$p1` and runs against your PostgreSQL instance.

Multiple keys at the top level are implicit AND. Each scalar field is typed against your schema, so a typo or wrong-type value is a TypeScript error before runtime.

---

## Operators

Per-field operators are nested objects. The supported set covers the common cases:

| Operator                 | EdgeQL                             | Notes                                                        |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------ |
| `eq`                     | `.f = $p`                          | Equivalent to a bare value (`{ f: x }` ≡ `{ f: { eq: x } }`) |
| `ne`                     | `.f != $p`                         |                                                              |
| `gt`, `gte`, `lt`, `lte` | `.f > $p` etc.                     | Numbers, dates, durations, strings                           |
| `like`, `ilike`          | `.f like $p`, `.f ilike $p`        | String pattern matching                                      |
| `in`, `not_in`           | `.f in array_unpack(<array<T>>$p)` | Array of values, lowers to `UNNEST`                          |

```ts
await client.payment.filter({
  amount: { gte: 100, lt: 1000 }, // range
  status: { in: ["paid", "refunded"] }, // membership
  email: { ilike: "%@example.com" } // pattern
});
```

Range queries on one field stay grouped (`{ amount: { gte, lt } }`) instead of being split into two unrelated keys.

### `undefined` vs `null`

A field whose value is `undefined` is **skipped** — it adds no constraint. This lets you pass optional predicates without branching:

```ts
// Filter by id OR slug — whichever is set. The undefined one is ignored.
await client.video.filter({ id: maybeId, slug: maybeSlug, limit: 1 });
```

`null` is a real value (`.f = <T>$p` with a null binding), so use `undefined`, not `null`, to mean "no constraint."

---

## Boolean composition

Top-level keys are AND. For everything else, three combinators import from your generated client:

```ts
import DiscClient, { and, not, or } from "./dbschema/disc-client";

const client = new DiscClient(/* config */);

await client.payment.filter(
  or({ status: "paid" }, { status: "refunded" })
);

await client.user.filter(
  and({ active: true }, or({ tier: "gold" }, { spend: { gte: 1000 } }))
);

await client.user.filter(not({ active: false }));
```

The combinators accept either Filter objects or other combinators, so they nest freely. A bare Filter object never needs `and(...)` since its keys already AND together.

---

## Shape narrowing

By default `filter()` returns every scalar field of the type (the EdgeQL `{ * }` splat). Pass `select` to narrow:

```ts
await client.merchant.filter({
  active: true,
  select: {
    id: true,
    email: true,
    name: true
  }
});
```

`select` follows the schema shape: `field: true` includes a scalar, `link: true` pulls all of the linked object's fields, `link: { ... }` narrows the linked object too.

```ts
await client.payment.filter({
  select: {
    id: true,
    amount: true,
    merchant: { name: true, tier: true }
  }
});
```

### Computed properties are opt-in

The `{ * }` splat (and `link: true`, which expands to `{ * }`) returns **stored columns only** — computed properties are excluded. Select them explicitly, including inside a nested link:

```ts
await client.channel.filter({
  select: {
    "*": true, // stored columns
    counts: true, // computed — must be named explicitly
    owner: { name: true, counts: true } // computed on a linked object, too
  }
});
```

### Ordering a linked set

A link sub-shape can carry its own `order_by` to sort that link's rows. Same convention as the top-level key: a string or array of strings, `-` prefix for descending.

```ts
await client.channel.filter({
  select: {
    "*": true,
    videos: { "*": true, order_by: ["-created"] } // newest videos first
  }
});
// → ... { *, videos: { * } order by .created desc }
```

The ordering applies to that link only (it compiles to an `ORDER BY` inside the link's `jsonb_agg`) and nests to any depth. An `order_by` placed at the **top level** of `select` is ignored — top-level result ordering uses the sibling `order_by` (see [Ordering, limit, offset](#ordering-limit-offset)). Capping a linked set (`limit`/`offset` on a sub-shape) is not yet supported; see [Not yet supported](#not-yet-supported).

---

## Link traversal

Linked objects are nested filter objects. The link's name in your schema is the key.

### Single link, terminal `id` — no subquery

```ts
await client.payment.filter({
  merchant: { id: merchantId }
});
// → ... filter .merchant_id = $1
```

When the path ends at `.id`, the foreign-key column on the source table _is_ the target's id, so the SQL collapses to a plain column comparison — no subquery, no JOIN.

### Single link, terminal property — correlated subquery

```ts
await client.payment.filter({
  merchant: { email: "x@y.com" }
});
// → ... filter (SELECT email FROM merchants WHERE id = p.merchant_id) = $1
```

### N-hop chain — nested correlated subqueries

```ts
await client.payment.filter({
  merchant: { owner: { email: "owner@y.com" } }
});
// → ... filter (SELECT email FROM owners WHERE id =
//                 (SELECT owner_id FROM merchants WHERE id = p.merchant_id)) = $1
```

Any number of single-link hops compose by recursive subquery wrapping. When the terminal step is `id`, one nesting layer is elided.

### Multi-link (one-to-many) — EXISTS

For `multi` links with a backlink (e.g., `User` has `multi posts: Post` linked back via `Post.author`):

```ts
await client.user.filter({
  posts: { title: "hello world" }
});
// → ... filter EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id AND p.title = $1)
```

EdgeQL set-comparison semantics say `set OP scalar` is true if any element matches. The compiler rewrites the whole comparison to `EXISTS` — no need for ANY/SOME juggling.

### Junction table (many-to-many) — EXISTS + JOIN

For `multi tags: Tag` linked through `user_tags(user_id, tag_id)`:

```ts
await client.user.filter({
  tags: { name: "important" }
});
// → ... filter EXISTS (
//      SELECT 1 FROM user_tags j
//      INNER JOIN tags t ON t.id = j.tag_id
//      WHERE j.user_id = u.id AND t.name = $1)
```

When the terminal step is `id`, the JOIN is elided since the junction's target column already holds the target's id:

```ts
await client.user.filter({ tags: { id: tagId } });
// → ... filter EXISTS (SELECT 1 FROM user_tags j WHERE j.user_id = u.id AND j.tag_id = $1)
```

Operators work through the link too. Membership (`in`) over a multi-link means "has a related row whose field is in the set" — e.g. videos sharing any tag with a set of ids:

```ts
await client.video.filter({ tags: { id: { in: tagIds } } });
// → ... filter EXISTS (SELECT 1 FROM video_tags j WHERE j.video_id = v.id AND j.tag_id = ANY($1))
```

### Multi-link chain — nested EXISTS

Nested filter objects can descend through **more than one** multi link. Each multi hop adds an EXISTS layer, correlated to the one above it:

```ts
await client.customer.filter({
  channels: { videos: { isDraft: 0n } }
});
// → ... filter EXISTS (SELECT 1 FROM channels c WHERE c.customer_id = cu.id
//      AND EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.id AND v.is_draft = $1))
```

This composes to any depth, and the hops can mix junction-table, backlink, and a trailing single-FK link freely. The one rule: the **first** hop must be a multi link — a chain that starts with a single link and only later reaches a multi link still needs raw EdgeQL (see [Not yet supported](#not-yet-supported)).

Sibling keys each become their own nested EXISTS, AND-ed together, so `{ channels: { videos: { isDraft: 0n, isPrivate: 0n } } }` matches a customer that has a channel with a non-draft video **and** a channel with a non-private video (standard EdgeQL set semantics — not necessarily the same video).

---

## Computed field filters

You can filter on a field of a computed **named-tuple** property. Given:

```
type Channel {
  counts := ( videos := count(.<channel[is Video]), posts := count(.<channel[is Post]) );
}
```

filter on `counts.videos` with the same operator objects as any scalar — the field is typed (`count`/`sum` → `bigint`):

```ts
await client.channel.filter({
  counts: { videos: { gte: 5n } } // channels with ≥ 5 videos
});
// → ... filter (SELECT count(*) FROM video WHERE video.channel_id = channel.id) >= <int64>$p
```

The compiler inlines the named field's underlying expression, so `counts.videos` becomes the same correlated aggregate it computes on read — no stored column, no extra query. Only named-tuple computeds whose fields are aggregates/simple scalars are exposed in the typed filter; anything else stays reachable via raw EdgeQL (`filter count(.<channel[is Video]) >= 5`).

---

## Ordering, limit, offset

Reserved keys `order_by`, `limit`, `offset` sit alongside your predicates at the top level.

```ts
await client.payment.filter({
  status: "paid",
  order_by: "-created", // `-` prefix means desc
  limit: 10,
  offset: 20
});
```

`order_by` accepts either a string or an array of strings for multi-key sort. The `-` prefix on any field flips that key to descending; otherwise it ascends.

```ts
await client.payment.filter({
  order_by: ["-created", "amount"] // newest first, then amount asc
});
// → ... order by .created desc then .amount
```

For a random ordering, pass `"random()"` as an `order_by` entry. It compiles to SQL `order by random()` and can be combined with field keys (later keys break ties). `random()` is the only function form accepted here; any other value must be a plain field name.

```ts
await client.payment.filter({
  order_by: "random()", // random row order
  limit: 1
});

await client.payment.filter({
  order_by: ["-created", "random()"] // newest first, ties broken randomly
});
// → ... order by .created desc then random()
```

`limit` and `offset` work together or alone, in either order at the EdgeQL level.

---

## Single-row queries

`filter()` always returns an array. For single-row lookups, set `limit: 1` and destructure:

```ts
const [merchant] = await client.merchant.filter({
  email: this.query.email,
  limit: 1
});
```

This intentionally avoids a separate `findOne()` method on every type — one mental model, one method.

---

## Putting it all together

Every feature in one query:

```ts
import DiscClient, { or } from "./dbschema/disc-client";

const client = new DiscClient(/* config */);

const [PAYMENT] = await client.payment.filter({
  // Predicate fields
  merchant: { id: this.query.merchantId },
  status: { in: ["pending", "active"] },
  amount: { gte: 100 },

  // Boolean composition mid-object stays clean — outer keys AND
  // these together, but you can also nest combinators where
  // they're needed:
  // ...or({ tier: "gold" }, { spend: { gte: 1000 } }),

  // Shape narrowing (links can recurse and order their own set)
  select: {
    id: true,
    amount: true,
    merchant: { name: true, tier: true },
    refunds: { "*": true, order_by: ["-created"] }
  },

  // Result shaping
  order_by: "-created",
  limit: 1
});
```

That object lowers to one EdgeQL query, one round-trip to PostgreSQL, with parameters bound through the wire codec — no string interpolation, no SQL escape hatch needed for the common case.

---

## Escape hatches

When the object form doesn't fit (deeply custom EdgeQL, schema features the filter compiler doesn't yet cover):

- **Raw EdgeQL:** `await client.query<T>("select X { ... } filter ...", { params })` is always available. The codegen is a layer on top, never in the way.
- **Codegen-free runtime DSL:** `from("X").select({...}).filter(u => u.email.eq("x")).toEdgeQL()` is the Phase 1 builder for ad-hoc queries. See [Client SDK → Codegen-free query builder](client-sdk.md#codegen-free-query-builder).

---

## Not yet supported

A few patterns lower to compiler errors today and should fall back to raw EdgeQL until they land:

- **A multi link reached _after_ a single link in the same chain** (e.g. `.author.posts.title`, where `author` is single and `posts` is multi). Chains that **start** with a multi link work to any depth — including a trailing single-FK hop — but when the first hop is single and a later hop is multi, the compiler can't yet place the EXISTS.
- **`filter` / `limit` / `offset` on a `select` link sub-shape.** Only `order_by` is supported inside a linked set today; narrowing or capping it (e.g. "the latest 5 videos") needs raw EdgeQL.
- **Explicit `<-` backlink syntax** (e.g. `.<author[is Post]`). When the source type doesn't pre-declare the back-link as a schema field, the explicit Gel syntax isn't yet plumbed through the parser.

These are tracked alongside the closed gaps in the test suite at `sdk/filter-compiler-edgeql.test.ts` and `compiler/compiler.test.ts`.
