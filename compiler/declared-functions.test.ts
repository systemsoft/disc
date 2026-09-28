/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL `function` calls are inlined: the call compiles to its body with the
 * arguments in place of the parameters, so nothing is created in PostgreSQL
 * and no call reaches it. Overloads, named-only parameters, defaults and the
 * errors are Gel 7.1's (see compiler/pg-declared-functions.test.ts for the
 * results against PostgreSQL).
 */

import { assertEquals, assertExists, assertInstanceOf, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { InvalidReferenceError } from "../lib/errors.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type User { required name: str; age: int64; }
  type Post { required title: str; score: int64; author: User; }
  function full_name(first: str, last: str) -> str using (first ++ ' ' ++ last);
  function adult(u: User) -> optional bool using (u.age >= 18);
  function top_posts(n: int64) -> set of Post using (select Post order by .score desc limit n);
  function greet(name: optional str = 'world') -> str using ('hi ' ++ (name ?? 'x'));
  function dbl(x: int64) -> int64 using (x * 2);
  function dbl(x: str) -> str using (x ++ x);
  function quad(x: int64) -> int64 using (dbl(dbl(x)));
  function joined(a: str, named only sep: str = ',', named only b: str = 'B') -> str using (a ++ sep ++ b);
  function posts_by(u: User) -> set of Post using (select Post filter .author = u);
  function titled(t: str) -> set of Post using (select Post filter .title = t);
}
module util {
  function twice(n: int64) -> int64 using (n * 2);
}`;

function schemaOf(sdl: string): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(sdl, { validate: true });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return manager.modulesToSchema(parsed.value);
}

const schema = schemaOf(SDL);

function compile(source: string): string {
  const result = new EdgeQLCompiler(schema, { enableAccessControl: false }).compile(new EdgeQLParser(source).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim();
}

function compileError(source: string): Error {
  const result = new EdgeQLCompiler(schema, { enableAccessControl: false }).compile(new EdgeQLParser(source).parse());
  if (result.ok) {
    throw new Error(`expected '${source}' not to compile`);
  }
  return result.error;
}

function sdlError(sdl: string): string {
  const parsed = new SchemaManager({ dryRun: true }).parseSDL(sdl, { validate: true });
  return parsed.ok ? "" : parsed.error.message;
}

Deno.test("declared function: a call is its body, the arguments in place of the parameters", () => {
  assertEquals(compile("select full_name('a', 'b')"), "SELECT ('a' || ' ') || ('b')");
  assertEquals(compile("select User { n := full_name(.name, 'x') }"), `SELECT jsonb_build_object('n', (user_1.name || ' ') || ('x')) FROM "user" AS user_1`);
});

Deno.test("declared function: a query parameter stays a parameter", () => {
  assertEquals(compile("select full_name(<str>$f, 'z')"), "SELECT (CAST($1 AS text) || ' ') || ('z')");
});

Deno.test("declared function: an object parameter's paths are the argument's", () => {
  assertEquals(compile("select User { a := adult(User) }"), `SELECT jsonb_build_object('a', user_1.age >= 18) FROM "user" AS user_1`);
  assertStringIncludes(compile("select User { name } filter adult(User)"), "WHERE user_1.age >= 18");
});

Deno.test("declared function: one returning objects is a select of them, which takes a shape", () => {
  assertEquals(
    compile("select top_posts(2) { title }"),
    "SELECT jsonb_build_object('title', post_1.title) FROM post AS post_1 ORDER BY post_1.score DESC NULLS LAST LIMIT 2"
  );
  assertStringIncludes(compile("select count(top_posts(2))"), "COUNT(*)");
});

Deno.test("declared function: an argument the body reads in a scope of its own is compiled where the call is", () => {
  // `.name` is the User's name, not the Post's.
  assertStringIncludes(compile("select User { n := count(titled(.name)) }"), "post_3.title = user_1.name");
  assertStringIncludes(compile("select User { ps := titled(.name) { title } }"), "post_3.title = user_1.name");
  assertStringIncludes(compile("select User { ps := posts_by(User) { title } }"), "post_2.author_id = user_1.id");
});

Deno.test("declared function: defaults, and named-only parameters passed by name", () => {
  assertEquals(compile("select greet()"), "SELECT 'hi ' || COALESCE('world', 'x')");
  assertEquals(compile("select joined('a', sep := '-')"), "SELECT ('a' || '-') || ('B')");
  assertEquals(compile("select joined('a', b := 'Q', sep := '+')"), "SELECT ('a' || '+') || ('Q')");
});

Deno.test("declared function: the overload is chosen by the argument types, with implicit casts", () => {
  assertEquals(compile("select dbl('ab')"), "SELECT 'ab' || 'ab'");
  assertEquals(compile("select dbl(3)"), "SELECT 3 * 2");
  assertEquals(compile("select dbl(<int32>3)"), "SELECT CAST(3 AS integer) * 2");
});

Deno.test("declared function: a function calling another is inlined through", () => {
  assertEquals(compile("select quad(3)"), "SELECT (3 * 2) * (2)");
});

Deno.test("declared function: one of another module is called by its module", () => {
  assertStringIncludes(compile("select util::twice(2)"), "2 * 2");
  assertEquals(compileError("select twice(2)").message, "function 'default::twice' does not exist");
});

Deno.test("declared function: arguments no overload takes are Gel's error, the overloads its hint", () => {
  const arity = compileError("select full_name('a')");
  assertEquals(arity.message, `function "full_name(arg0: std::str)" does not exist`);
  assertEquals((arity as { context?: { hint?: string; }; }).context?.hint, `Did you want "default::full_name(first: std::str, last: std::str)"?`);
  assertEquals(compileError("select full_name(1, 2)").message, `function "full_name(arg0: std::int64, arg1: std::int64)" does not exist`);
  assertEquals(compileError("select full_name('a', 'b', 'c')").message, `function "full_name(arg0: std::str, arg1: std::str, arg2: std::str)" does not exist`);
  // Parameters not declared `named only` are passed by position only.
  assertEquals(
    compileError("select full_name(last := 'b', first := 'a')").message,
    `function "full_name(NAMED ONLY last: std::str, NAMED ONLY first: std::str)" does not exist`
  );
  assertEquals(compileError("select joined('a', 'b')").message, `function "joined(arg0: std::str, arg1: std::str)" does not exist`);
  assertEquals(compileError("select adult(Post)").message, `function "adult(arg0: default::Post)" does not exist`);
  const overloads = compileError("select dbl(1.5)");
  assertEquals(overloads.message, `function "dbl(arg0: std::float64)" does not exist`);
  assertStringIncludes((overloads as { context?: { hint?: string; }; }).context?.hint ?? "", "default::dbl(x: std::int64)");
  assertStringIncludes((overloads as { context?: { hint?: string; }; }).context?.hint ?? "", "default::dbl(x: std::str)");
  assertEquals(
    (compileError("select greet(1)") as { context?: { hint?: string; }; }).context?.hint,
    `Did you want "default::greet(name: OPTIONAL std::str='world')"?`
  );
});

Deno.test("declared function: an unknown function is Gel's InvalidReferenceError", () => {
  const error = compileError("select nope(1)");
  assertInstanceOf(error, InvalidReferenceError);
  assertEquals(error.message, "function 'default::nope' does not exist");
});

Deno.test("declared function: a computed calling one returning objects is a computed link", () => {
  const withLink = schemaOf(`
    type Post { required title: str; score: int64; }
    type Board { required name: str; top := top_posts(2); }
    function top_posts(n: int64) -> set of Post using (select Post order by .score desc limit n);
  `);
  const top = withLink.types.get("Board")?.links.get("top");
  assertExists(top);
  assertEquals([top.target, top.multi], ["Post", true]);
});

Deno.test("declared function: Gel's schema errors — recursion, a cycle, set of parameters, a repeated signature", () => {
  assertStringIncludes(sdlError("function rec(x: int64) -> int64 using (rec(x - 1));"), "function 'default::rec(x: int64)' is defined recursively");
  assertStringIncludes(
    sdlError("function ra(x: int64) -> int64 using (rb(x)); function rb(x: int64) -> int64 using (ra(x));"),
    "definition dependency cycle between function 'default::rb(x: int64)' and function 'default::ra(x: int64)'"
  );
  assertStringIncludes(
    sdlError("function cnt(x: set of int64) -> int64 using (count(x));"),
    "cannot create the `default::cnt(x: SET OF std::int64)` function: SET OF parameters in user-defined EdgeQL functions are not supported"
  );
  assertStringIncludes(
    sdlError("function dup(x: int64) -> int64 using (x); function dup(y: int64) -> int64 using (y);"),
    "cannot create the `default::dup(y: std::int64)` function: a function with the same signature is already defined"
  );
});

Deno.test("declared function: volatility is accepted in Gel's block form", () => {
  const volatile = schemaOf(`function imm(x: int64) -> int64 { volatility := 'Immutable'; using (x + 1); };`);
  assertEquals(volatile.functions.get("imm")?.declared?.[0].volatility, "immutable");
});
