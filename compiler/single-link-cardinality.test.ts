/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A single link holds one object. As in Gel, an insert or update assigning
 * it a select that may keep several objects is a compile error: a select of
 * a type's objects with neither `limit 1` nor a filter of `.id` or an
 * exclusive property on one value (Gel 7.1: "possibly more than one element
 * returned by an expression for a link 'author' declared as 'single'").
 * `assert_single(…)` accepts any select and checks it at run time.
 *
 * Real-PG coverage: `compiler/pg-set-semantics.test.ts`.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type User {
    required name: str;
    email: str {
      constraint exclusive;
    };
  }
  type Post {
    title: str;
    author: User;
  }
}
`;

function schema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(SDL, { validate: false });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return manager.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim();
}

const MESSAGE = "possibly more than one element returned by an expression for a link 'author' declared as 'single'";

Deno.test("single link - a select that may keep several objects is a compile error, in an insert and an update", () => {
  const rejected = [
    "insert Post { author := (select User) }",
    "insert Post { author := (select User filter .name = 'ann') }",
    "insert Post { author := (select User filter .email in {'a', 'b'}) }",
    "insert Post { author := (select User filter .email = 'a' or .name = 'b') }",
    "insert Post { author := (select User order by .name) }",
    "update Post set { author := (select User filter .name = 'ann') }",
    "with u := (select User filter .name = 'ann') insert Post { author := u }"
  ];
  for (const query of rejected) {
    assertThrows(() => compile(query), CompilationError, MESSAGE, query);
  }
  const error = assertThrows(() => compile("insert Post { author := (select User) }"), CompilationError);
  assertEquals(error.context?.location?.line, 1);
});

Deno.test("single link - a select of at most one object compiles, as in Gel", () => {
  const accepted = [
    "insert Post { author := (select User filter .email = 'a') }",
    "insert Post { author := (select User filter .name = 'ann' and .email = <str>$e) }",
    "insert Post { author := (select User filter .id = <uuid>$id) }",
    "insert Post { author := (select User limit 1) }",
    "insert Post { author := (select User order by .name limit 1) }",
    "insert Post { author := <uuid>$id }",
    "update Post set { author := (select User filter .email = 'a') }",
    "with u := (select User filter .email = 'a') insert Post { author := u }"
  ];
  for (const query of accepted) {
    assertStringIncludes(compile(query), "author_id", query);
  }
});

Deno.test("single link - assert_single() accepts any select and checks it at run time", () => {
  assertStringIncludes(
    compile("insert Post { author := assert_single((select User filter .name = 'ann')) }"),
    "VALUES (( SELECT disc_assert_single(__set.value, COUNT(*) OVER ()) FROM ( SELECT user_1.id FROM \"user\" AS user_1 WHERE user_1.name = 'ann' ) AS __set(value) LIMIT 1 ))"
  );
  assertStringIncludes(compile("update Post set { author := assert_single(User) }"), "disc_assert_single(__set.value, COUNT(*) OVER ())");
  // Elsewhere too: a set's rows, and a single value is itself.
  assertStringIncludes(compile("select assert_single((select User.name))"), "disc_assert_single(__set.value, COUNT(*) OVER ())");
  assertEquals(compile("select assert_single(1)"), "SELECT 1");
});
