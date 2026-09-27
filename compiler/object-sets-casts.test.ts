/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * With bindings of objects and object casts, as Gel 7.1 treats them:
 *
 *   - `with n := assert_single((select T …))` is one object: a path from it
 *     is one value, and the binding raises Gel's CardinalityViolationError
 *     when it holds more than one (`disc_assert_single`).
 *   - An object compared with a binding of several objects is compared with
 *     each (`EXISTS` over the binding's ids); `?=` and `?!=` compare an
 *     empty binding as the empty set (one NULL row).
 *   - `<T><uuid>x` checks that an object of `T` has the id
 *     (`disc_object_cast`, Gel's CardinalityViolationError otherwise), and
 *     `in` one object cast is `=` it.
 *
 * See server/object-sets-casts-pg.test.ts for the same queries against PostgreSQL.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type User {
    required name: str {
      constraint exclusive;
    };
    active: bool;
  };

  type Post {
    required title: str;
    author: User;
  };

  type Counter {
    required name: str;
    last: int64;
  };

  type Tracker {
    required label: str;
    number: int64;
    owner: User;
  };
}
`;

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return cachedSchema;
}

async function sqlOf(edgeql: string): Promise<string> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  assert(result.ok, `expected '${edgeql}' to compile: ${result.ok ? "" : result.error.message}`);
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("object sets - with n := assert_single((select …)) is one object, asserted when read", async () => {
  const one = "with n := assert_single((select Counter filter .name = 'a'))";
  const assertion = "WITH n AS ( WITH __rows AS ( SELECT * FROM counter AS counter_1 WHERE counter_1.name = 'a' ) " +
    "SELECT * FROM __rows WHERE disc_assert_single(TRUE, ( SELECT COUNT(*) FROM __rows )) )";

  assertStringIncludes(await sqlOf(`${one} select n.last`), assertion);
  assertStringIncludes(await sqlOf(`${one} update Tracker set { number := n.last }`), "UPDATE tracker SET number = ( SELECT n_2.last FROM n AS n_2");
  assertStringIncludes(await sqlOf("with n := assert_single(Counter) select n { name }"), "SELECT jsonb_build_object('name', n_2.name) FROM n AS n_2");

  const owner = await sqlOf("with n := assert_single((select User filter .name = 'ann')) update Tracker set { owner := n }");
  assertStringIncludes(owner, "UPDATE tracker SET owner_id = ( SELECT id FROM n )");
});

Deno.test("object sets - an object compared with a binding of several objects is compared with each of their ids", async () => {
  const several = "with us := (select User filter .active) select Post { title } filter";

  assertStringIncludes(
    await sqlOf(`${several} .author = us`),
    "WHERE EXISTS ( SELECT 1 FROM ( SELECT us_4.id FROM us AS us_4 ) AS __arg_3(value) WHERE (post_2.author_id IS NOT NULL) AND (post_2.author_id = __arg_3.value) )"
  );
  // Under `not`, the link is still the current post's.
  assertStringIncludes(await sqlOf(`${several} not (.author = us)`), "SELECT post_2.author_id = __arg_4.value FROM");

  // One object at most: its id, as before.
  const one = await sqlOf("with u := (select User filter .name = 'bob') select Post { title } filter .author = u");
  assertStringIncludes(one, "WHERE post_2.author_id = ( SELECT id FROM u )");
});

Deno.test("object sets - ?= and ?!= read an empty set operand as the empty set", async () => {
  const sql = await sqlOf("with us := (select User filter .active) select Post { title } filter .author ?!= us");

  assertStringIncludes(sql, "FROM ( SELECT __rows.value FROM ( SELECT 1 ) AS __one LEFT JOIN ( SELECT us_4.id FROM us AS us_4 ) AS __rows(value) ON TRUE )");
  assertStringIncludes(sql, "WHERE post_2.author_id IS DISTINCT FROM __arg_3.value");
});

Deno.test("object casts - <T><uuid>x checks that an object of T has the id", async () => {
  const cast = "disc_object_cast(CAST($1 AS uuid), EXISTS ( SELECT user_3.id FROM \"user\" AS user_3 WHERE user_3.id = CAST($1 AS uuid) ), 'default::User')";

  assertStringIncludes(await sqlOf("select Post { title } filter .author = <User><uuid>$u"), `WHERE post_1.author_id = ${cast}`);
  // `in` one object is `=` it.
  assertStringIncludes(await sqlOf("select Post { title } filter .author in <User><uuid>$u"), `WHERE post_1.author_id = ${cast}`);
  assertStringIncludes(
    await sqlOf("insert Post { title := 'x', author := <User><uuid>$u }"),
    "VALUES ('x', disc_object_cast(CAST($1 AS uuid), EXISTS ( SELECT user_2.id FROM \"user\" AS user_2 WHERE user_2.id = CAST($1 AS uuid) ), 'default::User'))"
  );
});
