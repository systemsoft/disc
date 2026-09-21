/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `bytes` inside a shape leaves the database as base64 (D9).
 *
 * A shape compiles to `jsonb_build_object(…)`, and jsonb renders a bytea as
 * PostgreSQL hex text (`"\\x1f8b…"`). Every shape element whose value is
 * `bytes` is therefore wrapped as
 *
 *   translate(encode(<value>, 'base64'), E'\n', '')
 *
 * (`encode` breaks lines every 76 characters; RFC 4648 base64 has none), and an
 * `array<bytes>` element-wise. Only the value a shape SHIPS is wrapped: filters,
 * inserted values, function arguments and unshaped selects keep the bytea (the
 * latter are encoded by `server/row-normalizer.ts`).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { buildParameterTypeMap } from "./compiler-base.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const SDL = `
module default {
  type Program { required name: str; }
  abstract type Asset { required name: str; }
  type Blob extending Asset { data: bytes; }
  type GitObject {
    chunks: array<bytes>;
    content: bytes;
    digest := std::sha256(.content);
    required object_id: str;
    required link program -> Program;
    same := .content;
    required size: int64;
  }
  type Holder {
    multi link objs -> GitObject;
    required link obj -> GitObject;
  }
}`;

let cachedSchema: Schema | undefined;

async function sqlOf(edgeql: string): Promise<string> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return compileEdgeQL(edgeql, cachedSchema).replace(/\s+/g, " ");
}

function base64(value: string): string {
  return `translate(encode(${value}, 'base64'), E'\\n', '')`;
}

function base64Array(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN NULL ELSE ARRAY(SELECT ${base64("b")} FROM unnest(${value}) WITH ORDINALITY AS u(b, ord) ORDER BY ord) END`;
}

Deno.test("bytes shape - a bytes property is shipped as base64 without line breaks", async () => {
  assertStringIncludes(
    await sqlOf("select GitObject { object_id, content }"),
    `'object_id', gitobject_1.object_id, 'content', ${base64("gitobject_1.content")}`
  );
});

Deno.test("bytes shape - splat and the implicit shape encode bytes and leave the other columns alone", async () => {
  for (const query of ["select GitObject { * }", "select GitObject"]) {
    const sql = await sqlOf(query);
    assertStringIncludes(sql, `'content', ${base64("gitobject_1.content")}`, query);
    assertStringIncludes(sql, `'chunks', ${base64Array("gitobject_1.chunks")}`, query);
    assertStringIncludes(sql, "'size', gitobject_1.size", query);
    assertEquals(sql.split("encode(").length - 1, 2, query);
  }
});

Deno.test("bytes shape - array<bytes> is encoded element-wise, in order, keeping NULL and the empty array apart", async () => {
  assertStringIncludes(await sqlOf("select GitObject { chunks }"), `'chunks', ${base64Array("gitobject_1.chunks")}`);
});

Deno.test("bytes shape - an aliased or computed element that yields bytes is encoded", async () => {
  assertStringIncludes(await sqlOf("select GitObject { c := .content }"), `'c', ${base64("gitobject_1.content")}`);
  assertStringIncludes(await sqlOf("select GitObject { h := std::sha256(.content) }"), `'h', ${base64("SHA256(gitobject_1.content)")}`);
  assertStringIncludes(await sqlOf("select GitObject { d := std::base64_decode(.object_id) }"), `'d', ${base64("std_base64_decode(gitobject_1.object_id)")}`);
  assertStringIncludes(await sqlOf("select Holder { c := .obj.content }"), "'c', translate(encode(");
});

Deno.test("bytes shape - a schema-computed bytes property is encoded", async () => {
  const sql = await sqlOf("select GitObject { digest, same }");
  assertStringIncludes(sql, `'digest', ${base64("SHA256(gitobject_1.content)")}`);
  assertStringIncludes(sql, `'same', ${base64("gitobject_1.content")}`);
});

Deno.test("bytes shape - a <bytes> parameter echoed in a shape is encoded and keeps its bytea type for binding", async () => {
  assertStringIncludes(await sqlOf("select GitObject { x := <bytes>$p }"), `'x', ${base64("CAST($1 AS bytea)")}`);
  assertStringIncludes(await sqlOf("select GitObject { x := <array<bytes>>$p }"), `'x', ${base64Array("CAST($1 AS bytea[])")}`);

  // prepareParameters decodes base64 for the slots this map types as bytea.
  for (const [query, pgType] of [["select GitObject { x := <bytes>$p }", "bytea"], ["select GitObject { x := <array<bytes>>$p }", "bytea[]"]]) {
    const result = new EdgeQLCompiler(cachedSchema!, { enableAccessControl: false }).compile(new EdgeQLParser(query).parse());
    assert(result.ok);
    assertEquals(buildParameterTypeMap(result.value).get(1), pgType, query);
  }
});

Deno.test("bytes shape - bytes inside a nested link shape, single and multi", async () => {
  assertStringIncludes(await sqlOf("select Holder { obj: { content } }"), `jsonb_agg(jsonb_build_object('content', ${base64("git_object.content")}))`);
  assertStringIncludes(await sqlOf("select Holder { objs: { object_id, content } }"), `'content', ${base64("git_object.content")}`);
});

Deno.test("bytes shape - a shape over a mutation CTE, both spellings, and over a select binding", async () => {
  const update = "update GitObject filter .object_id = 'x' set { size := 1 }";

  for (const query of [`select (${update}) { content }`, `with m := (${update}) select m { content }`, "with m := (select GitObject) select m { content }"]) {
    const sql = await sqlOf(query);
    assert(/jsonb_build_object\('content', translate\(encode\(m_\d+\.content, 'base64'\), E'\\n', ''\)\) FROM m AS m_\d+/.test(sql), `${query}: ${sql}`);
  }
});

Deno.test("bytes shape - a polymorphic [is T].bytes element is encoded inside its CASE", async () => {
  assertStringIncludes(await sqlOf("select Asset { name, [is Blob].data }"), `WHEN asset_1.__type__ = 'Blob' THEN ${base64("asset_1.data")}`);
});

Deno.test("bytes shape - only the shipped value is encoded: filters, inserts, arguments and str results are not", async () => {
  const filtered = await sqlOf("select GitObject { object_id } filter .content = <bytes>$c");
  assertStringIncludes(filtered, "gitobject_1.content = CAST($1 AS bytea)");
  assert(!filtered.includes("encode("), filtered);

  const inserted = await sqlOf(
    "insert GitObject { object_id := 'x', size := 1, program := <Program><uuid>$p, content := <bytes>$c, chunks := <array<bytes>>$cs }"
  );
  assertStringIncludes(inserted, "CAST($2 AS bytea), CAST($3 AS bytea[])");
  assert(!inserted.includes("encode("), inserted);

  const hex = await sqlOf("select GitObject { h := std::hex_encode(.content), n := .size }");
  assertStringIncludes(hex, "'h', std_hex_encode(gitobject_1.content), 'n', gitobject_1.size");

  const unshaped = await sqlOf("select GitObject.content");
  assert(!unshaped.includes("encode("), unshaped);
});
