/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stage E — end-to-end validation of compileFilter output against the
 * real Disc EdgeQL parser + compiler.
 *
 * Filter-compiler unit tests pin the *string* output. These tests close
 * the loop by feeding that string into Disc's EdgeQL pipeline and
 * confirming it parses, type-checks, and compiles to SQL without
 * raising. If the filter compiler ever emits something that *looks*
 * like EdgeQL but Disc's compiler can't handle, this suite catches it.
 *
 * Validation only — these don't talk to PostgreSQL. Real PG round-trips
 * live in a future test pass; this one runs in any environment.
 *
 * NOTE: All five Gel-compat gaps that originally blocked the new
 * codegen filter API are now closed. The full surface — equality,
 * operators (incl. in/not_in), implicit-AND, combinators, link
 * traversal, select narrowing, order_by (single + multi-key), limit,
 * offset — compiles cleanly through Disc's parser and compiler.
 *
 * Closed gaps: #1 splat, #2 limit+offset, #3 multi-key order_by, #4
 * `<array<T>>` nested generics, #5 multi-step path expressions
 * (single-link, 2-step — `.link.id` short-circuits to FK, `.link.<f>`
 * lowers to a correlated subquery).
 */

import { assertEquals } from "@std/assert";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { createTestSchema } from "../compiler/context.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { compileFilter, type TypeInfo } from "./filter-compiler.ts";
import { and, not, or } from "./query-builder.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

function edgeqlToSql(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw new Error(
      `EdgeQL compile failed: ${result.error.message}\nSource: ${source}`
    );
  }
  return codegen.generate(result.value);
}

const postInfo: TypeInfo = {
  casts: { id: "<uuid>", title: "<str>" },
  links: {}
};

const userInfo: TypeInfo = {
  casts: {
    id: "<uuid>",
    name: "<str>",
    email: "<str>",
    createdAt: "<datetime>",
    active: "<bool>",
    age: "<int32>",
    postCount: "<int32>"
  },
  links: {
    posts: () => postInfo
  }
};

/** Assemble + parse + compile, matching the generated `filter()` method. */
function compileAndRun(filter: Parameters<typeof compileFilter>[1]): string {
  const compiled = compileFilter("User", filter, userInfo);
  const shape = compiled.selectShape ?? "{ * }";
  const parts: string[] = [`select User ${shape}`];
  if (compiled.clause) {
    parts.push(`filter ${compiled.clause}`);
  }
  if (compiled.orderBy) {
    parts.push(compiled.orderBy);
  }
  if (compiled.limit !== null) {
    parts.push(`limit ${compiled.limit}`);
  }
  if (compiled.offset !== null) {
    parts.push(`offset ${compiled.offset}`);
  }
  return edgeqlToSql(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Group 1 — supported today, must pass
// ---------------------------------------------------------------------------

Deno.test("Stage E — equality filter compiles to SQL", () => {
  const sql = compileAndRun({ email: "user@example.com" });
  assertEquals(sql.length > 0, true);
  assertEquals(/email/i.test(sql), true);
});

Deno.test("Stage E — operator object (gte/lt) compiles to SQL", () => {
  const sql = compileAndRun({ age: { gte: 18, lt: 65 } });
  assertEquals(sql.length > 0, true);
  assertEquals(/age/i.test(sql), true);
});

Deno.test("Stage E — like / ilike pattern operators compile to SQL", () => {
  const sql = compileAndRun({ name: { ilike: "alice%" } });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — implicit AND across multiple keys compiles to SQL", () => {
  const sql = compileAndRun({
    email: "user@example.com",
    active: true,
    age: { gte: 21 }
  });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — or() across two Filter objects compiles to SQL", () => {
  const sql = compileAndRun(or({ name: "alice" }, { name: "bob" }));
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — and() nested inside or() compiles to SQL", () => {
  const sql = compileAndRun(
    or(and({ active: true, age: { gte: 21 } }), { name: "admin" })
  );
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — not() wrapping a Filter object compiles to SQL", () => {
  const sql = compileAndRun(not({ active: false }));
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — select shape narrowing compiles to SQL", () => {
  const sql = compileAndRun({
    active: true,
    select: { id: true, email: true, name: true }
  });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — single-key order_by compiles to SQL", () => {
  const sql = compileAndRun({ active: true, order_by: "-createdAt" });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — limit alone compiles to SQL", () => {
  const sql = compileAndRun({ active: true, limit: 10 });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — offset alone compiles to SQL", () => {
  const sql = compileAndRun({ active: true, offset: 20 });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — empty filter (no predicate) compiles to SQL", () => {
  const sql = compileAndRun({});
  assertEquals(sql.length > 0, true);
});

// ---------------------------------------------------------------------------
// Group 2 — currently blocked on Disc parser/compiler gaps. The filter
// compiler emits the correct EdgeQL; the parser/compiler can't yet
// consume it. These tests exist to (a) confirm the gap is still real
// and (b) flip back to passing assertions the moment each gap closes.
// ---------------------------------------------------------------------------

Deno.test("Stage E — in/not_in with <array<T>> compiles to SQL (was Gap #4, closed 2026-05-08)", () => {
  const sql = compileAndRun({ name: { in: ["alice", "bob"] } });
  assertEquals(sql.length > 0, true);
  // PG side: array_unpack(<array<str>>$p0) lowers to UNNEST over a text[].
  assertEquals(/text\[\]|UNNEST/i.test(sql), true);
});

Deno.test("Stage E — single-link 2-step path compiles to SQL (Gap #5 single-link case)", () => {
  // Post → author (single link) traversal — both `.author.id` and
  // `.author.<other>` work; here we use the FK-shortcut form.
  const sql = edgeqlToSql(
    "select Post { id } filter .author.id = <uuid>$id"
  );
  assertEquals(sql.length > 0, true);
  assertEquals(/author_id/.test(sql), true);
});

Deno.test("Stage E — multi-link 2-step path through codegen filter compiles to SQL (EXISTS)", () => {
  // The filter compiler emits `.posts.title = <str>$p0` for `posts: { title }`.
  // The compiler now lowers that to an EXISTS subquery on the posts table.
  const sql = compileAndRun({ posts: { title: "first post" } });
  assertEquals(sql.length > 0, true);
  assertEquals(/EXISTS/i.test(sql), true);
  assertEquals(sql.includes("posts"), true);
});

Deno.test("Stage E — limit + offset together compile to SQL (was Gap #2, closed 2026-05-08)", () => {
  const sql = compileAndRun({ active: true, limit: 10, offset: 20 });
  assertEquals(sql.length > 0, true);
});

Deno.test("Stage E — multi-key order_by compiles to SQL (was Gap #3, closed 2026-05-08)", () => {
  const sql = compileAndRun({ order_by: ["-createdAt", "name"] });
  assertEquals(sql.length > 0, true);
});
