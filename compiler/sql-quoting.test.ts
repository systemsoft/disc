/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Names and strings from a query reach the SQL only quoted.
 *
 * A backtick-quoted EdgeQL name can hold any character but a backtick
 * (`` `a"b'c` ``), and can stand for a `with` binding, a `for` variable, a
 * cast's type or a `configure` key. Each query below uses such a name; its SQL
 * must either not compile or hold the name only inside a quoted identifier
 * (`"…"`, `"` doubled) or string literal (`'…'`, `'` doubled). A name spliced
 * into hand-written SQL between its own quotes, without doubling them, would
 * end the quoting early and leave the rest of the name as SQL text.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError, ConfigurationError, DiscError } from "../lib/errors.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();

/*** The SQL of `source`; throws the compile error when it doesn't compile. ***/
function compile(source: string): string {
  const result = new EdgeQLCompiler(schema, { enableAccessControl: false }).compile(new EdgeQLParser(source).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value);
}

/*** `sql` without its quoted identifiers and string literals (`E'…'` ones with backslash escapes). ***/
function unquotedText(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch !== "'" && ch !== "\"") {
      out += ch;
      i++;
      continue;
    }
    const backslashes = ch === "'" && /[eE]$/.test(out) && !/\w[eE]$/.test(out);
    i++;
    while (i < sql.length) {
      if (backslashes && sql[i] === "\\") {
        i += 2;
      } else if (sql[i] === ch && sql[i + 1] === ch) {
        i += 2;
      } else if (sql[i] === ch) {
        break;
      } else {
        i++;
      }
    }
    i++;
    out += " ";
  }
  return out;
}

const NAME = "`inj\"qqq'zzz`";

/*** Whether `sql` has a part of NAME outside quotes, other than inside a longer word (the alias `inj_qqq_zzz_2`). ***/
function leaksName(sql: string): boolean {
  return /(^|\W)(qqq|zzz)/.test(unquotedText(sql));
}

/*** Assert `source` doesn't compile, or its SQL has the name only quoted. ***/
function assertQuoted(source: string): void {
  let sql: string;
  try {
    sql = compile(source);
  } catch (error) {
    assert(error instanceof DiscError, `${source}: ${error}`);
    return;
  }
  assert(!leaksName(sql), `${source} leaves the name unquoted:\n${sql}`);
}

Deno.test("sql quoting: the test's scanner finds a name that ends its quoting early", () => {
  assertEquals(unquotedText(`SELECT "a""b", 'c''d', E'e\\'f'`), "SELECT  ,  , E ");
  assertEquals(leaksName(`SELECT "inj""qqq'zzz", 'inj"qqq''zzz', inj_qqq_zzz_2`), false);
  assertEquals(leaksName(`SELECT "inj"qqq'zzz_2"."id"`), true);
  assertEquals(leaksName(`SELECT 'inj"qqq'zzz'`), true);
});

Deno.test("sql quoting: a with binding's name in correlated subqueries, link paths and backlinks", () => {
  for (
    const body of [
      "select B { name }",
      "select B { name, n := count(.posts) }",
      "select B { name } filter .posts.title = 'x'",
      "select B { name, p := .<author[is Post] }",
      "select B { name } filter count(.<author[is Post]) > 1",
      "select B { name } filter .<author[is Post].title = 'x'",
      "select B { name, posts: { title } }",
      "select B.name",
      "update B set { name := 'z' }",
      "delete B"
    ]
  ) {
    assertQuoted(`with ${NAME} := (select User) ${body.replaceAll("B", NAME)}`);
  }
  for (const body of ["select B { title } filter .author.name = 'a'", "select B { title, n := .author.name }"]) {
    assertQuoted(`with ${NAME} := (select Post) ${body.replaceAll("B", NAME)}`);
  }
});

Deno.test("sql quoting: a with binding that inserts or updates, read back through its CTE", () => {
  assertQuoted(`with ${NAME} := (insert User { name := 'a', email := 'b' }) select ${NAME} { name }`);
  assertQuoted(`with ${NAME} := (insert User { name := 'a', email := 'b' }) select User { name }`);
  assertQuoted(`with ${NAME} := (update User filter .name = 'a' set { name := 'b' }) select ${NAME} { name, posts: { title } }`);
  // The author is read from users as the update leaves it: the rows it didn't
  // touch (`… NOT IN (SELECT "id" FROM <the binding's CTE>)`) and those it did.
  const sql = compile(`with ${NAME} := (update User filter .name = 'a' set { name := 'b' }) select ${NAME} { name, posts: { author: { name } } }`);
  assert(sql.includes(`NOT IN (SELECT "id" FROM "inj""qqq'zzz")`), sql);
  assert(!leaksName(sql), sql);
});

Deno.test("sql quoting: link, backlink, property and type names that aren't in the schema", () => {
  for (
    const query of [
      `select User { name } filter .${NAME}.title = 'x'`,
      `select User { name } filter .<${NAME}[is Post].title = 'x'`,
      `select User { name } filter count(.<${NAME}[is Post]) > 1`,
      `select User { n := count(.${NAME}) }`,
      `select User { p := .<${NAME}[is Post] }`,
      `select User { p := .<author[is ${NAME}] }`,
      `select User { name } filter .${NAME} = 1`,
      `select User { name } order by .${NAME}`,
      `select Post { title } filter .author.${NAME} = 'a'`,
      `select Post { n := .author.${NAME} }`,
      `select User { posts: { @${NAME} } }`,
      `select User [is ${NAME}]`,
      `select User { name } filter User is ${NAME}`,
      `insert User { ${NAME} := 'a' }`,
      `update User set { ${NAME} := 'a' }`,
      `insert User { name := 'a', email := 'b' } unless conflict on .${NAME}`,
      `group User by .${NAME}`,
      `select global ${NAME}`,
      `set global ${NAME} := 1`,
      `select (a := 1).${NAME}`,
      `select User { ${NAME} := .name }`,
      `select <Status>'inj"qqq\\'zzz'`
    ]
  ) {
    assertQuoted(query);
  }
});

Deno.test("sql quoting: for variables and group bindings", () => {
  assertQuoted(`for ${NAME} in (select User) union (select ${NAME} { name })`);
  assertQuoted(`for ${NAME} in {1, 2} union (select ${NAME} + 1)`);
  assertQuoted(`group User { name } using ${NAME} := .name by ${NAME}`);
});

Deno.test("sql quoting: a cast to a type that doesn't exist is an error, never a PostgreSQL type name", () => {
  for (
    const query of [
      `select <${NAME}>1`,
      `select <array<${NAME}>>[1]`,
      `select <${NAME}>$a`,
      `select <optional ${NAME}>$a`,
      `select <array<${NAME}>>$a`,
      `select User { name } filter .name in array_unpack(<array<${NAME}>>$a)`,
      "select <`int4) + (1`>1"
    ]
  ) {
    assertThrows(() => compile(query), CompilationError, undefined, query);
  }
});

Deno.test("sql quoting: a configure key that isn't a configuration parameter's name is an error", () => {
  for (
    const query of [
      "configure session set `x = 1; select 1; --` := 1",
      "configure system reset `x; select 1`",
      "configure database set `a'||'b` := 1",
      "configure database reset `a' or 'b'='b`",
      "configure instance set `a'b` := 1"
    ]
  ) {
    assertThrows(() => compile(query), CompilationError, "configuration parameter", query);
  }
  // A key of the right form is then looked up: only a known one reaches the SQL.
  assertEquals(compile("configure session set lock_timeout := 1").startsWith("SET LOCAL lock_timeout"), true);
  for (const query of ["configure session set custom_setting := 1", "configure session set query.timeout := 1"]) {
    assertThrows(() => compile(query), ConfigurationError, "unrecognized configuration parameter", query);
  }
});
