/**
 * Tests for IF/ELSE expression compilation (EdgeQL → SQL CASE/WHEN)
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) throw result.error;
  return codegen.generate(result.value);
}

Deno.test("IF/ELSE - simple literal conditional", () => {
  const source = `SELECT "yes" IF true ELSE "no"`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("CASE"), true, "SQL should contain CASE");
  assertEquals(sql.includes("WHEN"), true, "SQL should contain WHEN");
  assertEquals(sql.includes("TRUE"), true, "SQL should contain TRUE condition");
  assertEquals(
    sql.includes("THEN"),
    true,
    "SQL should contain THEN",
  );
  assertEquals(
    sql.includes("'yes'"),
    true,
    "SQL should contain 'yes' as THEN value",
  );
  assertEquals(sql.includes("ELSE"), true, "SQL should contain ELSE");
  assertEquals(
    sql.includes("'no'"),
    true,
    "SQL should contain 'no' as ELSE value",
  );
  assertEquals(sql.includes("END"), true, "SQL should contain END");
});

Deno.test("IF/ELSE - computed property in shape", () => {
  const source = `
    SELECT User {
      name,
      status := "active" IF .active ELSE "inactive"
    }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("CASE"), true, "SQL should contain CASE");
  assertEquals(sql.includes("WHEN"), true, "SQL should contain WHEN");
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference active column",
  );
  assertEquals(
    sql.includes("'active'"),
    true,
    "SQL should contain 'active' string literal",
  );
  assertEquals(
    sql.includes("'inactive'"),
    true,
    "SQL should contain 'inactive' string literal",
  );
  assertEquals(sql.includes("END"), true, "SQL should contain END");
});

Deno.test("IF/ELSE - nested conditional", () => {
  const source = `SELECT "a" IF true ELSE "b" IF false ELSE "c"`;
  const sql = compileEdgeQL(source);

  // The nested IF/ELSE should produce a nested CASE
  // Outer: CASE WHEN TRUE THEN 'a' ELSE (inner CASE) END
  // Inner: CASE WHEN FALSE THEN 'b' ELSE 'c' END
  assertEquals(sql.includes("CASE"), true, "SQL should contain CASE");
  assertEquals(
    sql.includes("'a'"),
    true,
    "SQL should contain 'a'",
  );
  assertEquals(
    sql.includes("'b'"),
    true,
    "SQL should contain 'b'",
  );
  assertEquals(
    sql.includes("'c'"),
    true,
    "SQL should contain 'c'",
  );

  // Count occurrences of CASE — should have two nested CASEs
  const caseCount = (sql.match(/CASE/g) || []).length;
  assertEquals(
    caseCount,
    2,
    "Nested IF/ELSE should produce two CASE expressions",
  );
});

Deno.test("IF/ELSE - in filter expression", () => {
  const source = `
    SELECT User
    FILTER .name = ("admin" IF .active ELSE "guest")
  `;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("WHERE"), true, "SQL should contain WHERE clause");
  assertEquals(sql.includes("CASE"), true, "SQL should contain CASE in WHERE");
  assertEquals(sql.includes("WHEN"), true, "SQL should contain WHEN");
  assertEquals(
    sql.includes("'admin'"),
    true,
    "SQL should contain 'admin' literal",
  );
  assertEquals(
    sql.includes("'guest'"),
    true,
    "SQL should contain 'guest' literal",
  );
  assertEquals(sql.includes("END"), true, "SQL should contain END");
});
