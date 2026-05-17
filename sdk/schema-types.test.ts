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
import type { LinkStub, ResolveSelected, ResolveType } from "./schema-types.ts";

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
type Builder = TypedQueryBuilder<typeof blogSchema.spec>;

declare const _resolveTypeChecks: [
  Expect<Equal<UserRow["email"], string>>,
  Expect<Equal<UserRow["active"], boolean>>,
  Expect<Equal<UserRow["createdAt"], Date>>,
  Expect<Equal<UserRow["bio"], string | null>>,
  // Links resolve to a shallow stub — circular schemas wouldn't type
  // otherwise. Full expansion happens via `ResolveSelected` instead.
  Expect<Equal<UserRow["posts"], LinkStub[]>>,
  Expect<Equal<PostRow["author"], LinkStub | null>>,
  Expect<Equal<PostRow["publishedAt"], Date | null>>
];

declare const _resolveSelectedChecks: [
  Expect<Equal<FlatRow, { email: string; name: string; }>>,
  Expect<Equal<NestedRow, { title: string; author: { email: string; } | null; }>>,
  Expect<Equal<MultiRow, { name: string; posts: { title: string; }[]; }>>
];

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
  // u.email.eq("a@b.c") — string accepted; u.score.gt(10) — number accepted.
  await qb
    .Post
    .select({ title: true })
    .filter(p => p.score.gt(10))
    .filter(p => p.title.eq("hello"));
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].query,
    "select Post { title } filter (.score > <int64>$p0) and (.title = <str>$p1)"
  );
  assertEquals(calls[0].variables, { p0: 10, p1: "hello" });
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
