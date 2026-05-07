/**
 * Tests for optional link COALESCE wrapping
 *
 * Optional multi-links should produce COALESCE(subquery, '[]'::jsonb)
 * so that missing relations return an empty array instead of null.
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);

function compileEdgeQL(source: string): string {
  const codegen = new SQLCodeGenerator();
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) throw result.error;
  return codegen.generate(result.value);
}

Deno.test("optional multi-link gets COALESCE wrapper", () => {
  const sql = compileEdgeQL("select User { name, posts: { title } }");

  // The posts link is optional (required: false) and multi (multi: true),
  // so the subquery should be wrapped with COALESCE(..., '[]'::jsonb)
  assertEquals(sql.includes("COALESCE"), true, "SQL should contain COALESCE");
  assertEquals(
    sql.includes("'[]'::jsonb"),
    true,
    "SQL should contain '[]'::jsonb fallback",
  );
});

Deno.test("required single link does NOT get COALESCE wrapper", () => {
  const sql = compileEdgeQL("select Post { title, author: { name } }");

  // The author link is required (required: true) and single (multi: false),
  // so the subquery should NOT be wrapped with COALESCE
  assertEquals(
    sql.includes("COALESCE"),
    false,
    "SQL should NOT contain COALESCE for required single link",
  );
});

Deno.test("optional multi-link preserves subquery structure with COALESCE", () => {
  const sql = compileEdgeQL("select User { posts: { title, body } }");

  // Should have COALESCE wrapping the entire subquery
  assertEquals(sql.includes("COALESCE("), true, "SQL should contain COALESCE(");
  // Should still use jsonb_agg inside the subquery
  assertEquals(
    sql.includes("jsonb_agg"),
    true,
    "SQL should contain jsonb_agg inside subquery",
  );
  // Should have the empty array fallback
  assertEquals(
    sql.includes("'[]'::jsonb"),
    true,
    "SQL should contain '[]'::jsonb",
  );
});
