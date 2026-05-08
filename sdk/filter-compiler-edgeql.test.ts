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
 * NOTE: Disc's EdgeQL parser/compiler still has four Gel-compat gaps
 * that intersect with this filter API. Tests below are organised so the
 * first group exercises only what's supported *today* and is expected
 * to pass; the second group uses `assertThrows` to pin the remaining
 * gaps so the next person to close one knows which test to flip on.
 * The remaining gaps:
 *
 *   - `limit N offset M` together — parser stops after `limit`.
 *   - `order by .a then .b` multi-key — `then` keyword unknown.
 *   - `<array<str>>` nested generic types — used by `in` / `not_in`.
 *   - `.link.field` multi-step path expressions — compiler errors with
 *      "Multi-step path expressions not yet implemented".
 *
 * Gap #1 (`{ * }` splat) was closed — the wrapper below now uses `{ * }`
 * by default, matching what the generated `client.<type>.filter()`
 * actually emits.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { createTestSchema } from "../compiler/context.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { and, not, or } from "./query-builder.ts";
import { compileFilter, type TypeInfo } from "./filter-compiler.ts";

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
  if (compiled.clause)
    parts.push(`filter ${compiled.clause}`);
  if (compiled.orderBy)
    parts.push(compiled.orderBy);
  if (compiled.limit !== null)
    parts.push(`limit ${compiled.limit}`);
  if (compiled.offset !== null)
    parts.push(`offset ${compiled.offset}`);
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

Deno.test("Stage E — GAP: in/not_in needs <array<T>> nested-generic parser support", () => {
  // What the filter compiler emits today:
  const compiled = compileFilter(
    "User",
    { name: { in: ["alice", "bob"] } },
    userInfo
  );
  assertEquals(
    compiled.clause,
    ".name in array_unpack(<array<str>>$p0)"
  );
  // Disc's parser rejects nested generic types like <array<str>>:
  assertThrows(
    () => compileAndRun({ name: { in: ["alice", "bob"] } }),
    Error,
    "Expected '>' after type"
  );
});

Deno.test("Stage E — GAP: link traversal needs multi-step path expressions in compiler", () => {
  // The filter compiler walks `.posts.title` correctly:
  const compiled = compileFilter(
    "User",
    { posts: { title: "first" } },
    userInfo
  );
  assertEquals(compiled.clause, "(.posts.title = <str>$p0)");
  // Disc's compiler hasn't implemented multi-step paths yet:
  assertThrows(
    () => compileAndRun({ posts: { title: "first" } }),
    Error,
    "Multi-step path expressions not yet implemented"
  );
});

Deno.test("Stage E — GAP: limit + offset together rejected by parser", () => {
  // Each clause works alone (covered above). The combination doesn't:
  assertThrows(
    () => compileAndRun({ active: true, limit: 10, offset: 20 }),
    Error,
    "Expected ';' or end of input"
  );
});

Deno.test("Stage E — GAP: multi-key order_by needs `then` keyword in parser", () => {
  // The filter compiler emits `order by .a desc then .b`:
  const compiled = compileFilter(
    "User",
    { order_by: ["-createdAt", "name"] },
    userInfo
  );
  assertEquals(compiled.orderBy, "order by .createdAt desc then .name");
  // Disc's parser doesn't know `then`:
  assertThrows(
    () => compileAndRun({ order_by: ["-createdAt", "name"] }),
    Error,
    "Expected ';' or end of input"
  );
});
