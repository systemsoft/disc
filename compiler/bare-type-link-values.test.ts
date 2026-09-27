/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A bare object type assigned to a link (`insert Post { tags := Tag }`) is,
 * as in Gel, the set of all its objects: it compiles like `(select Tag)`,
 * which the target type's select policies narrow like any other read, in
 * `:=`, `+=` and `-=` alike. A single link can hold only one object, so Gel
 * rejects a type there (its cardinality is many), and so does Disc.
 *
 * See server/bare-type-link-values-pg.test.ts for what PostgreSQL answers.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Tag {
    required name: str;
    visible: bool;
    access policy see {
      allow all;
      using (.visible ?= true);
    };
  }
  type User {
    required name: str;
  }
  type Post {
    title: str;
    author: User;
    multi tags: Tag {
      weight: int64;
    };
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

function compile(edgeql: string, policies = false): string {
  const typed = schema();
  const compiler = new EdgeQLCompiler(typed, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    enableAccessControl: policies
  });
  for (const typeDef of typed.types.values()) {
    for (const policy of typeDef.accessPolicies ?? []) {
      compiler.registerAccessPolicy(policy);
    }
  }
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("bare type link values - a type assigned to a multi link is the set of all its objects", () => {
  const pairs: [string, string][] = [
    ["insert Post { tags := Tag }", "insert Post { tags := (select Tag) }"],
    ["update Post set { tags := Tag }", "update Post set { tags := (select Tag) }"],
    ["update Post set { tags += Tag }", "update Post set { tags += (select Tag) }"],
    ["update Post set { tags -= Tag }", "update Post set { tags -= (select Tag) }"],
    ["insert Post { tags := default::Tag }", "insert Post { tags := (select default::Tag) }"],
    ["insert Post { tags := Tag { @weight := 2 } }", "insert Post { tags := (select Tag) { @weight := 2 } }"]
  ];
  for (const [bare, selected] of pairs) {
    assertEquals(compile(bare), compile(selected), bare);
  }
});

Deno.test("bare type link values - the target type's select policies narrow the objects linked", () => {
  const sql = compile("insert Post { tags := Tag }", true);
  assertStringIncludes(sql, "visible");
  assertEquals(sql, compile("insert Post { tags := (select Tag) }", true));
  assert(compile("update Post set { tags += Tag }", true).includes("visible"));
});

Deno.test("bare type link values - a type assigned to a single link is rejected, as in Gel", () => {
  for (const query of ["insert Post { author := User }", "update Post set { author := User }"]) {
    const error = assertThrows(() => compile(query));
    assertStringIncludes(
      (error as Error).message,
      "possibly more than one element returned by an expression for a link 'author' declared as 'single'",
      query
    );
  }
});

Deno.test("bare type link values - the subject of an update is still its current object", () => {
  // `Post` in its own update's filter is the updated object, not every post.
  assertStringIncludes(compile("update Post filter Post.title = 'a' set { title := 'b' }"), "WHERE");
});
