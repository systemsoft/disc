/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `multi` scalar properties compile against their array column
 * (`multi scopes: str` → `text[]`):
 *
 * - an assigned set becomes one array value (`{"a", "b"}` → ARRAY[…],
 *   `array_unpack(arr)` → arr, `{}` → `'{}'`, a single value → a
 *   one-element array), so an insert writes one row;
 * - `+=` / `-=` append to / remove from the array;
 * - set comparisons test any element (`.scopes = x`, `x in .scopes` →
 *   `x = ANY(scopes)`), `count` is `cardinality`, `exists` is non-empty.
 *
 * Real-PG coverage lives in `server/multi-property-pg.test.ts`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";

const SDL = `
module default {
  scalar type Level extending enum<low, high>;
  type Token {
    required name: str;
    multi scopes: str;
    multi ports: int64;
    multi levels: Level;
  }
}
`;

function schema() {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema()).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok)
    throw result.error;
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("multi property - the compiler schema types it as an array column", () => {
  const token = schema().types.get("Token")!;
  assertEquals(token.properties.get("scopes")!.type, "text[]");
  assertEquals(token.properties.get("scopes")!.edgeqlType, "str");
  assertEquals(token.properties.get("ports")!.type, "bigint[]");
});

Deno.test("multi property - insert a set literal as one array", () => {
  const sql = compile(`insert Token { name := "a", scopes := {"read", "write"} }`);
  assertStringIncludes(sql, "CAST(ARRAY['read', 'write'] AS text[])");
});

Deno.test("multi property - insert array_unpack(<array<str>>$s) as the array itself", () => {
  const sql = compile(`insert Token { name := "a", scopes := array_unpack(<array<str>>$s) }`);
  assertStringIncludes(sql, "VALUES ('a', CAST($1 AS text[]))");
  assertEquals(sql.includes("UNNEST"), false, sql);
});

Deno.test("multi property - insert a single value as a one-element array", () => {
  const sql = compile(`insert Token { name := "a", scopes := <str>$one }`);
  assertStringIncludes(sql, "CAST(ARRAY_REMOVE(ARRAY[CAST($1 AS text)], NULL) AS text[])");
});

Deno.test("multi property - insert the empty set as an empty array", () => {
  const sql = compile(`insert Token { name := "a", scopes := {} }`);
  assertStringIncludes(sql, "CAST('{}' AS text[])");
});

Deno.test("multi property - an enum multi property casts to the enum array type", () => {
  const sql = compile(`insert Token { name := "a", levels := {"low"} }`);
  assertStringIncludes(sql, "CAST(ARRAY['low'] AS disc_enum_level[])");
});

Deno.test("multi property - update := replaces, += appends, -= removes", () => {
  assertStringIncludes(compile(`update Token set { scopes := {"a"} }`), "scopes = CAST(ARRAY['a'] AS text[])");
  assertStringIncludes(compile(`update Token set { scopes += "a" }`), "scopes = scopes || CAST(ARRAY_REMOVE(ARRAY['a'], NULL) AS text[])");
  assertStringIncludes(compile(`update Token set { scopes -= {"a", "b"} }`), "scopes = disc_array_except(scopes, CAST(ARRAY['a', 'b'] AS text[]))");
});

Deno.test("multi property - membership and equality test any element", () => {
  assertStringIncludes(compile(`select Token { name } filter "read" in .scopes`), "'read' = ANY(token_1.scopes)");
  assertStringIncludes(compile(`select Token { name } filter "read" not in .scopes`), "'read' <> ALL(token_1.scopes)");
  assertStringIncludes(compile(`select Token { name } filter .scopes = "read"`), "'read' = ANY(token_1.scopes)");
  assertStringIncludes(compile(`select Token { name } filter .ports > 10`), "10 < ANY(token_1.ports)");
  assertStringIncludes(
    compile(`select Token { name } filter .scopes in array_unpack(<array<str>>$s)`),
    "token_1.scopes && CAST($1 AS text[])"
  );
});

Deno.test("multi property - count is cardinality, exists is non-empty", () => {
  assertStringIncludes(compile(`select Token { name } filter count(.scopes) = 2`), "CARDINALITY(token_1.scopes) = 2");
  assertStringIncludes(compile(`select Token { name } filter exists .scopes`), "CARDINALITY(token_1.scopes) > 0");
  assertStringIncludes(compile(`select Token { name } filter not exists .scopes`), "NOT CARDINALITY(token_1.scopes) > 0");
});
