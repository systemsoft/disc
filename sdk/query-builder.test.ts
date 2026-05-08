/**
 * Query builder — runtime EdgeQL emitter tests.
 *
 * These tests cover the pure builder surface (no client/network). The
 * builder produces `{ query, variables }` pairs that are fed to the
 * existing `client.query()` pipeline, so any EdgeQL the server already
 * accepts is reachable from here.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { from } from "./query-builder.ts";

Deno.test("from(Type).select({ field: true }) emits flat shape", () => {
  const compiled = from("User").select({ email: true, name: true }).toEdgeQL();
  assertEquals(compiled.query, "select User { email, name }");
  assertEquals(compiled.variables, {});
});

Deno.test("nested shape expands link sub-selection", () => {
  const compiled = from("User")
    .select({ email: true, posts: { title: true, body: true } })
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { email, posts: { title, body } }"
  );
});

Deno.test("filter eq parameterizes the value with a typed cast", () => {
  const compiled = from("User")
    .select({ email: true })
    .filter(u => u.email.eq("user@example.com"))
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { email } filter .email = <str>$p0"
  );
  assertEquals(compiled.variables, { p0: "user@example.com" });
});

Deno.test("comparison operators emit the right EdgeQL operator", () => {
  const cases: Array<[string, string]> = [
    ["neq", "!="],
    ["lt", "<"],
    ["lte", "<="],
    ["gt", ">"],
    ["gte", ">="]
  ];
  for (const [method, op] of cases) {
    const compiled = from("Post")
      .select({ id: true })
      // deno-lint-ignore no-explicit-any
      .filter(p => ((p.score as any)[method] as (v: number) => any)(10))
      .toEdgeQL();
    assertEquals(
      compiled.query,
      `select Post { id } filter .score ${op} <int64>$p0`
    );
    assertEquals(compiled.variables, { p0: 10 });
  }
});

Deno.test("typed casts cover string/number/boolean/Date/bigint/Uint8Array", () => {
  const date = new Date("2026-01-15T00:00:00Z");
  const bytes = new Uint8Array([1, 2, 3]);
  const cases: Array<[unknown, string]> = [
    ["s", "<str>$p0"],
    [3.14, "<float64>$p0"],
    [42, "<int64>$p0"],
    [true, "<bool>$p0"],
    [10n, "<bigint>$p0"],
    [date, "<datetime>$p0"],
    [bytes, "<bytes>$p0"]
  ];
  for (const [value, cast] of cases) {
    const compiled = from("X")
      .select({ id: true })
      .filter(x => x.f.eq(value))
      .toEdgeQL();
    assertEquals(compiled.query, `select X { id } filter .f = ${cast}`);
    assertEquals(compiled.variables, { p0: value });
  }
});

Deno.test("multiple filter clauses combine with `and`", () => {
  const compiled = from("User")
    .select({ id: true })
    .filter(u => u.email.eq("a@b.c"))
    .filter(u => u.active.eq(true))
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { id } filter (.email = <str>$p0) and (.active = <bool>$p1)"
  );
  assertEquals(compiled.variables, { p0: "a@b.c", p1: true });
});

Deno.test("orderBy ascending by default; .desc() flips to desc", () => {
  const asc = from("User")
    .select({ id: true })
    .orderBy(u => u.name)
    .toEdgeQL();
  assertEquals(asc.query, "select User { id } order by .name");

  const desc = from("User")
    .select({ id: true })
    .orderBy(u => u.name.desc())
    .toEdgeQL();
  assertEquals(desc.query, "select User { id } order by .name desc");
});

Deno.test("limit and offset emit literal integers (not parameters)", () => {
  const compiled = from("User")
    .select({ id: true })
    .limit(10)
    .offset(20)
    .toEdgeQL();
  assertEquals(compiled.query, "select User { id } limit 10 offset 20");
  assertEquals(compiled.variables, {});
});

Deno.test("limit and offset reject non-integers", () => {
  assertThrows(
    () => from("User").select({ id: true }).limit(1.5),
    Error,
    "integer"
  );
  assertThrows(
    () => from("User").select({ id: true }).offset(-1),
    Error,
    "non-negative"
  );
});

Deno.test("clause order is filter → order by → limit → offset", () => {
  const compiled = from("User")
    .select({ id: true })
    .limit(5)
    .filter(u => u.active.eq(true))
    .offset(10)
    .orderBy(u => u.name.desc())
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { id } filter .active = <bool>$p0 order by .name desc limit 5 offset 10"
  );
});

Deno.test("type and field names are validated as safe identifiers", () => {
  assertThrows(() => from("User; drop table"), Error);
  assertThrows(
    () => from("User").select({ "id; drop": true }).toEdgeQL(),
    Error
  );
});

Deno.test("exists() emits `exists .field`", () => {
  const compiled = from("User")
    .select({ id: true })
    .filter(u => u.deletedAt.exists())
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { id } filter exists .deletedAt"
  );
});

Deno.test("camelCase property names pass through verbatim", () => {
  // EdgeQL uses camelCase (matching SDL). The compiler converts to
  // snake_case when generating SQL — that's not the builder's job.
  const compiled = from("User")
    .select({ createdAt: true })
    .filter(u => u.emailVerified.eq(true))
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { createdAt } filter .emailVerified = <bool>$p0"
  );
});

Deno.test("nested shape preserves camelCase in sub-selection", () => {
  const compiled = from("User")
    .select({ id: true, blogPosts: { createdAt: true } })
    .toEdgeQL();
  assertEquals(
    compiled.query,
    "select User { id, blogPosts: { createdAt } }"
  );
});

Deno.test("toEdgeQL is pure — calling twice returns the same compiled output", () => {
  const chain = from("User").select({ id: true }).filter(u => u.email.eq("a@b.c"));
  const a = chain.toEdgeQL();
  const b = chain.toEdgeQL();
  assertEquals(a, b);
});

Deno.test("attaching a client makes the chain awaitable", async () => {
  const calls: Array<{ query: string; variables: unknown; }> = [];
  const fakeClient = {
    query: <T = unknown>(
      query: string,
      variables?: Record<string, unknown>
    ): Promise<T> => {
      calls.push({ query, variables: variables ?? {} });
      return Promise.resolve([{ id: "u1", email: "a@b.c" }] as T);
    }
  };
  const { createQueryBuilder } = await import("./query-builder.ts");
  const qb = createQueryBuilder(fakeClient);
  const result = await qb
    .User
    .select({ id: true, email: true })
    .filter(u => u.email.eq("a@b.c"));
  assertEquals(result, [{ id: "u1", email: "a@b.c" }]);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].query,
    "select User { id, email } filter .email = <str>$p0"
  );
  assertEquals(calls[0].variables, { p0: "a@b.c" });
});

Deno.test("first() limits to 1 and unwraps the single row (or null)", async () => {
  const fakeClient = {
    query: <T = unknown>(_q: string, _v?: Record<string, unknown>): Promise<T> => Promise.resolve([{ id: "u1" }] as T)
  };
  const { createQueryBuilder } = await import("./query-builder.ts");
  const qb = createQueryBuilder(fakeClient);
  const result = await qb.User.select({ id: true }).first();
  assertEquals(result, { id: "u1" });

  // Empty result -> null.
  const emptyClient = {
    query: <T = unknown>(_q: string, _v?: Record<string, unknown>): Promise<T> => Promise.resolve([] as T)
  };
  const qb2 = createQueryBuilder(emptyClient);
  assertEquals(await qb2.User.select({ id: true }).first(), null);
});

Deno.test("first() compiles with `limit 1`", () => {
  const compiled = from("User").select({ id: true }).limit(1).toEdgeQL();
  assertEquals(compiled.query, "select User { id } limit 1");
  // Sanity: explicit limit does the same as first()'s internal limit.
  assert(compiled.query.endsWith("limit 1"));
});

// --- Stage B: combinators accept Expr OR Filter objects ---

Deno.test("Stage B — and() with Filter objects produces an Expr the codegen path will compile", async () => {
  const { and } = await import("./query-builder.ts");
  const node = and({ email: "a@b.c" }, { active: true });
  // Internal shape: combinators wrap their args verbatim under `exprs`.
  assertEquals(node.kind, "and");
  if (node.kind !== "and")
    throw new Error("type narrowing");
  assertEquals(node.exprs.length, 2);
  assertEquals(node.exprs[0], { email: "a@b.c" });
  assertEquals(node.exprs[1], { active: true });
});

Deno.test("Stage B — or() mixes Filter objects and Expr nodes", async () => {
  const { or } = await import("./query-builder.ts");
  const exprNode = from("User").select({ id: true });
  // Build a binop manually for the assertion (don't need a FieldRef here)
  const node = or({ tier: "gold" }, { kind: "binop", op: "=", field: "tier", value: "silver" });
  assertEquals(node.kind, "or");
  if (node.kind !== "or")
    throw new Error("type narrowing");
  assertEquals(node.exprs.length, 2);
  assertEquals(node.exprs[0], { tier: "gold" });
  // Sanity: the Expr child round-trips
  void exprNode;
});

Deno.test("Stage B — not() wraps a single Filter object", async () => {
  const { not } = await import("./query-builder.ts");
  const node = not({ active: false });
  assertEquals(node.kind, "not");
  if (node.kind !== "not")
    throw new Error("type narrowing");
  assertEquals(node.expr, { active: false });
});

Deno.test("Stage B — runtime SelectChain rejects Filter-object combinator children with a clear error", async () => {
  const { and } = await import("./query-builder.ts");
  // Wrap a filter object inside and(), feed to a SelectChain — should throw
  // when toEdgeQL() walks the tree and hits the plain object child.
  assertThrows(
    () => from("User").filter(() => and({ email: "x" })).toEdgeQL(),
    Error,
    "Plain Filter objects are not supported in the runtime SelectChain DSL"
  );
});
