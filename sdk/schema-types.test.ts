/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for `defineSchema()` and the typed query-builder overload.
 *
 * Mix of runtime tests (validation, type registry, schema-aware proxy)
 * and type-level tests. The type-level tests use `Expect<Equal<A, B>>`
 * style helpers — they fail to compile if the inference is wrong, so
 * they double as regression coverage when run under `deno check`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { createQueryBuilder } from "./query-builder.ts";
import type { TypedQueryBuilder, TypedSelectChain } from "./query-builder.ts";
import { defineSchema, t } from "./schema-types.ts";
import type { ResolveSelected, ResolveType } from "./schema-types.ts";

// --- Type-level helpers (compile-time-only) ---

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true :
  false;
type Expect<T extends true> = T;

// --- Schema fixtures ---

const blogSchema = defineSchema({
  User: {
    email: t.str(),
    name: t.str(),
    active: t.bool(),
    createdAt: t.datetime(),
    bio: t.optional(t.str()),
    manager: t.optional(t.single("User")),
    posts: t.multi("Post")
  },
  Post: {
    title: t.str(),
    body: t.str(),
    score: t.int64(),
    author: t.single("User"),
    publishedAt: t.optional(t.datetime())
  }
});

// --- Runtime: defineSchema() validation ---

Deno.test("defineSchema returns a wrapper carrying the spec", () => {
  assertEquals(Object.keys(blogSchema.spec).sort(), ["Post", "User"]);
  assertEquals(blogSchema.spec.User.email.kind, "scalar");
  assertEquals(
    (blogSchema.spec.User.email as { typeName: string; }).typeName,
    "str"
  );
});

Deno.test("defineSchema rejects non-PascalCase type names", () => {
  assertThrows(
    () => defineSchema({ user: { name: t.str() } }),
    Error,
    "PascalCase"
  );
  assertThrows(
    () => defineSchema({ "User; drop": { name: t.str() } }),
    Error,
    "PascalCase"
  );
});

Deno.test("defineSchema rejects invalid field names", () => {
  assertThrows(
    () => defineSchema({ User: { "name; drop": t.str() } }),
    Error,
    "field name"
  );
});

Deno.test("defineSchema rejects malformed markers", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineSchema({ User: { name: { kind: "wat" } as any } }),
    Error,
    "Invalid field marker"
  );
});

Deno.test("defineSchema catches links to undefined types", () => {
  assertThrows(
    () => defineSchema({ User: { posts: t.multi("MissingType") } }),
    Error,
    "Link target not found"
  );
  // Inside an Optional wrapper still works (we walk through it).
  assertThrows(
    () => defineSchema({ User: { manager: t.optional(t.single("Ghost")) } }),
    Error,
    "Link target not found"
  );
});

Deno.test("defineSchema accepts self-referential and mutual links", () => {
  const recursive = defineSchema({
    Node: {
      label: t.str(),
      parent: t.optional(t.single("Node")),
      children: t.multi("Node")
    }
  });
  assertEquals(Object.keys(recursive.spec.Node).sort(), [
    "children",
    "label",
    "parent"
  ]);
});

// --- Runtime: schema-aware createQueryBuilder ---

Deno.test("typed createQueryBuilder refuses access to types not in the schema", () => {
  const fakeClient = {
    query: <T = unknown>(): Promise<T> => Promise.resolve([] as T)
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);
  // Defined types resolve to a chain.
  const chain = qb.User;
  assertEquals(typeof chain.select, "function");
  // Undeclared types throw immediately.
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => (qb as any).Ghost,
    Error,
    "not defined in the schema"
  );
});

Deno.test("typed createQueryBuilder runtime emits the same EdgeQL as the untyped path", () => {
  const fakeClient = {
    query: <T = unknown>(): Promise<T> => Promise.resolve([] as T)
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);
  // deno-lint-ignore no-explicit-any
  const compiled = (qb.User.select({ email: true, name: true }) as any)
    .toEdgeQL();
  assertEquals(compiled.query, "select User { email, name }");
});

// --- Type-level assertions ---
//
// The `declare const _x: [...]` pattern keeps each `Expect<Equal<...>>`
// evaluated at compile time without producing runtime code. Failure
// shows up as a type error in `deno check`.

type UserRow = ResolveType<typeof blogSchema.spec, typeof blogSchema.spec.User>;
type PostRow = ResolveType<typeof blogSchema.spec, typeof blogSchema.spec.Post>;
type FlatRow = ResolveSelected<
  typeof blogSchema.spec,
  "User",
  { email: true; name: true; }
>;
type NestedRow = ResolveSelected<
  typeof blogSchema.spec,
  "Post",
  { title: true; author: { email: true; }; }
>;
type MultiRow = ResolveSelected<
  typeof blogSchema.spec,
  "User",
  { name: true; posts: { title: true; }; }
>;
type OptionalNestedRow = ResolveSelected<
  typeof blogSchema.spec,
  "User",
  { manager: { name: true; }; }
>;
type DeepRow = ResolveSelected<
  typeof blogSchema.spec,
  "Post",
  { author: { manager: { name: true; }; }; }
>;
type SingleInMultiRow = ResolveSelected<
  typeof blogSchema.spec,
  "User",
  { posts: { author: { name: true; }; }; }
>;
type LinkIdRow = ResolveSelected<
  typeof blogSchema.spec,
  "User",
  { manager: true; posts: true; }
>;
type RequiredLinkIdRow = ResolveSelected<
  typeof blogSchema.spec,
  "Post",
  { author: true; }
>;
type Builder = TypedQueryBuilder<typeof blogSchema.spec>;

declare const _resolveTypeChecks: [
  Expect<Equal<UserRow["email"], string>>,
  Expect<Equal<UserRow["active"], boolean>>,
  Expect<Equal<UserRow["createdAt"], Date>>,
  Expect<Equal<UserRow["bio"], string | null>>,
  // A select without a shape returns `id` and the properties, no links.
  Expect<Equal<UserRow["id"], string>>,
  Expect<Equal<"posts" extends keyof UserRow ? true : false, false>>,
  Expect<Equal<"manager" extends keyof UserRow ? true : false, false>>,
  Expect<Equal<"author" extends keyof PostRow ? true : false, false>>,
  Expect<Equal<PostRow["publishedAt"], Date | null>>,
  // An int64 can exceed 2^53, so it is a bigint, as in the generated client.
  Expect<Equal<PostRow["score"], bigint>>
];

declare const _resolveSelectedChecks: [
  Expect<Equal<FlatRow, { email: string; name: string; }>>,
  // A single link arrives as a one-element array (null when an optional one
  // is empty), not the object itself — a divergence from Gel.
  Expect<Equal<NestedRow, { title: string; author: [{ email: string; }]; }>>,
  Expect<Equal<MultiRow, { name: string; posts: { title: string; }[]; }>>,
  Expect<Equal<OptionalNestedRow, { manager: [{ name: string; }] | null; }>>,
  Expect<Equal<DeepRow, { author: [{ manager: [{ name: string; }] | null; }]; }>>,
  Expect<Equal<SingleInMultiRow, { posts: { author: [{ name: string; }]; }[]; }>>,
  // A link without a sub-shape is its target's id: a single link's (null when
  // an optional one is unset), a multi link's ids ([] when it is empty).
  Expect<Equal<RequiredLinkIdRow, { author: string; }>>,
  Expect<Equal<LinkIdRow, { manager: string | null; posts: string[]; }>>
];

Deno.test("typed link without a sub-shape is its target's id, not an object", () => {
  const row: RequiredLinkIdRow = { author: "00000000-0000-0000-0000-000000000000" };
  // @ts-expect-error a link without a sub-shape is an id string
  assertEquals(row.author.id, undefined);
  assertEquals(row.author.length, 36);
});

Deno.test("typed single link is read through its one-element array, not as an object", () => {
  const row: NestedRow = { author: [{ email: "a@b.c" }], title: "x" };
  // @ts-expect-error a single link is a one-element array
  assertEquals(row.author.email, undefined);
  assertEquals(row.author[0].email, "a@b.c");
});

declare const _builderShapeCheck: Expect<
  Equal<Builder["User"], TypedSelectChain<typeof blogSchema.spec, "User">>
>;

Deno.test("typed select narrows the awaited row type (compile-time check)", async () => {
  const fakeClient = {
    query: <T = unknown>(
      _q: string,
      _v?: Record<string, unknown>
    ): Promise<T> => Promise.resolve([{ email: "a@b.c", name: "alice" }] as T)
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);

  // The await result is typed as `{ email: string; name: string }[]`
  // (the row-shape assertion is in `_resolveSelectedChecks` above; here
  // we just verify the runtime resolves to the same data).
  const rows = await qb.User.select({ email: true, name: true });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].email, "a@b.c");
});

Deno.test("typed first() returns row | null with the inferred shape", async () => {
  const fakeClient = {
    query: <T = unknown>(
      _q: string,
      _v?: Record<string, unknown>
    ): Promise<T> => Promise.resolve([{ title: "hello" }] as T)
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);
  const row = await qb.Post.select({ title: true }).first();
  assertEquals(row, { title: "hello" });
});

Deno.test("typed filter predicate gets a typed FieldRef per field", async () => {
  const calls: Array<{ query: string; variables: unknown; }> = [];
  const fakeClient = {
    query: <T = unknown>(
      query: string,
      variables?: Record<string, unknown>
    ): Promise<T> => {
      calls.push({ query, variables: variables ?? {} });
      return Promise.resolve([] as T);
    }
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);
  // p.title.eq("hello") — string accepted; p.score.gt(10n) — bigint accepted,
  // cast as the schema declares the field (`int64`), not as a JS bigint.
  await qb
    .Post
    .select({ title: true })
    .filter(p => p.score.gt(10n))
    .filter(p => p.title.eq("hello"));
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].query,
    "select Post { title } filter (.score > <int64>$p0) and (.title = <str>$p1)"
  );
  assertEquals(calls[0].variables, { p0: 10n, p1: "hello" });
});

Deno.test("typed results hold the declared types: int64 as bigint, datetime as Date, through links", async () => {
  const fakeClient = {
    query: <T = unknown>(): Promise<T> =>
      Promise.resolve([{
        author: [{ createdAt: "2026-01-15T10:20:30+00:00" }],
        publishedAt: null,
        score: "9007199254740993",
        title: "x"
      }] as T)
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);
  const rows = await qb.Post.select({ author: { createdAt: true }, publishedAt: true, score: true, title: true });
  assertEquals(rows, [{
    author: [{ createdAt: new Date("2026-01-15T10:20:30Z") }],
    publishedAt: null,
    score: 9007199254740993n,
    title: "x"
  }]);
  const first = await qb.Post.select({ score: true }).first();
  assertEquals(first?.score, 9007199254740993n);
});

Deno.test("typed orderBy + limit + offset chain compose without losing type info", async () => {
  const fakeClient = {
    query: <T = unknown>(): Promise<T> => Promise.resolve([{ title: "x", score: 5 }] as T)
  };
  const qb = createQueryBuilder(fakeClient, blogSchema);
  const rows = await qb
    .Post
    .select({ title: true, score: true })
    .orderBy(p => p.score.desc())
    .limit(10)
    .offset(0);
  assertEquals(rows[0].title, "x");
});
