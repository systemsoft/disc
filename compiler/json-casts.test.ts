/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Casts from a json operand (D8).
 *
 * `CAST(jsonb AS text)` keeps the JSON quotes, and jsonb → bytea / text[] are
 * not valid PostgreSQL. A cast whose operand is json extracts the value as
 * text first (`#>> '{}'`, which also turns JSON null into NULL) and then casts
 * that; an array is rebuilt element by element, in order.
 *
 * The compiler has no expression type inference, so "the operand is json" is
 * read from the operand's syntax — see `isJsonExpression`. Each recognized form
 * has a test below.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { buildParameterTypeMap, EdgeQLCompiler } from "./compiler.ts";

const SDL = `
module default {
  scalar type Level extending enum<low, high>;

  type Event {
    required name: str;
    meta: json;
    tags: array<str>;
  }
}
`;

async function compileStatement(edgeql: string) {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SDL);
  if (!parsed.ok) {
    throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
  }

  const compiler = new EdgeQLCompiler(manager.modulesToSchema(parsed.value), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function compile(edgeql: string): Promise<string> {
  return new SQLCodeGenerator().generate(await compileStatement(edgeql)).replace(/\s+/g, " ").trim();
}

const J = "CAST($1 AS jsonb)";

Deno.test("json cast: <str> of a subscript extracts the text, without JSON quotes", async () => {
  assertEquals(await compile("select <str>(<json>$j)['k']"), `SELECT (${J} -> 'k') #>> '{}'`);
});

Deno.test("json cast: <str> of a json cast itself", async () => {
  assertEquals(await compile("select <str><json>$j"), `SELECT ${J} #>> '{}'`);
});

Deno.test("json cast: numeric, bool and uuid cast the extracted text", async () => {
  assertEquals(await compile("select <int64>(<json>$j)['n']"), `SELECT CAST((${J} -> 'n') #>> '{}' AS bigint)`);
  assertEquals(await compile("select <float64>(<json>$j)['n']"), `SELECT CAST((${J} -> 'n') #>> '{}' AS double precision)`);
  assertEquals(await compile("select <bool>(<json>$j)['b']"), `SELECT CAST((${J} -> 'b') #>> '{}' AS boolean)`);
  assertEquals(await compile("select <uuid>(<json>$j)['id']"), `SELECT CAST((${J} -> 'id') #>> '{}' AS uuid)`);
});

Deno.test("json cast: an enum casts the extracted text", async () => {
  const sql = await compile("select <Level>(<json>$j)['level']");

  assertStringIncludes(sql, `CAST((${J} -> 'level') #>> '{}' AS`);
  assert(/AS "?disc_enum_level"?\)/i.test(sql), sql);
});

Deno.test("json cast: <json> of json stays a plain cast", async () => {
  assertEquals(await compile("select <json>(<json>$j)['k']"), `SELECT CAST(${J} -> 'k' AS jsonb)`);
});

Deno.test("json cast: <array<str>> rebuilds the array in order; [] gives an empty array, JSON null gives NULL", async () => {
  const sql = await compile("select <array<str>>(<json>$j)['parents']");
  const operand = `${J} -> 'parents'`;

  assertEquals(
    sql,
    `SELECT CASE WHEN (${operand} IS NULL) OR (JSONB_TYPEOF(${operand}) = 'null') THEN NULL ELSE ` +
      `CAST(ARRAY(SELECT e.v FROM jsonb_array_elements_text(${operand}) WITH ORDINALITY AS e(v, ord) ORDER BY e.ord) AS text[]) END`
  );
});

Deno.test("json cast: <array<int64>> casts the rebuilt array", async () => {
  assertStringIncludes(await compile("select <array<int64>>(<json>$j)['sizes']"), "ORDER BY e.ord) AS bigint[]) END");
});

Deno.test("json cast: <array<json>> keeps the elements as json", async () => {
  const sql = await compile("select <array<json>>(<json>$j)['items']");

  assertStringIncludes(sql, "FROM jsonb_array_elements(CAST($1 AS jsonb) -> 'items')");
  assertStringIncludes(sql, "AS jsonb[]) END");
});

Deno.test("json cast: <bytes> from json is a compile error naming base64_decode", async () => {
  for (const query of ["select <bytes>(<json>$j)['content']", "select <array<bytes>>(<json>$j)['chunks']"]) {
    let message = "";
    try {
      await compile(query);
    } catch (error) {
      message = (error as Error).message;
    }

    assertStringIncludes(message, "std::base64_decode(<str>", query);
  }
});

Deno.test("json cast: the json parameter stays typed jsonb for the binding layer", async () => {
  for (const query of ["select <str>(<json>$j)['k']", "select <array<str>>(<json>$j)['parents']", "select <int64>(<json>$j)['n']"]) {
    assertEquals(buildParameterTypeMap(await compileStatement(query)).get(1), "jsonb", query);
  }
});

// ── Recognized operand forms ─────────────────────────────────────────────

Deno.test("json operand: a string-keyed subscript, whatever its base", async () => {
  assertStringIncludes(await compile("select Event { k := <str>.meta['k'] }"), "(event_1.meta -> 'k') #>> '{}'");
});

Deno.test("json operand: an integer subscript on a json operand", async () => {
  assertStringIncludes(await compile("select <str>(<json>$j)['items'][0]"), `((${J} -> 'items') -> 0) #>> '{}'`);
});

Deno.test("json operand: a call to a function that returns json", async () => {
  assertEquals(await compile("select <str>json_get(<json>$j, 'k')"), `SELECT (${J} -> 'k') #>> '{}'`);
  assertStringIncludes(await compile("select <str>to_json('1')"), "#>> '{}'");
});

Deno.test("json operand: a with-bound name whose binding is json", async () => {
  assertEquals(await compile("with row := <json>$j select <str>row['k']"), `SELECT (${J} -> 'k') #>> '{}'`);
  assertEquals(await compile("with row := <json>$j select <int64>row"), `SELECT CAST(${J} #>> '{}' AS bigint)`);
});

Deno.test("json operand: a json property", async () => {
  assertStringIncludes(await compile("select Event { m := <str>.meta }"), "'m', event_1.meta #>> '{}'");
});

Deno.test("json operand: anything else keeps the plain cast", async () => {
  assertEquals(await compile("select <str>$s"), "SELECT CAST($1 AS text)");
  assertStringIncludes(await compile("select Event { n := <str>.name }"), "CAST(event_1.name AS text)");
  assertStringIncludes(await compile("select Event { t := <array<str>>.tags }"), "CAST(event_1.tags AS text[])");
  assertEquals(await compile("select <int64>(<str>$s)"), "SELECT CAST(CAST($1 AS text) AS bigint)");
});
