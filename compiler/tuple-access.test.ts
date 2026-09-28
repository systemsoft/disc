/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Tuple and Named Tuple Element Access
 * Phase 23.2: Tuple index access (.0, .1) and named field access (.name)
 */

import { assertEquals } from "@std/assert";
import type { SelectQuery } from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }

  return codegen.generate(result.value);
}

function parseEdgeQL(source: string) {
  const parser = new EdgeQLParser(source);
  return parser.parse();
}

// =========================================================================
// Parser Tests: Numeric Tuple Index Access
// =========================================================================

Deno.test("Tuple Access - Parse numeric index .0 on tuple", () => {
  const ast = parseEdgeQL("SELECT (1, 2, 3).0") as SelectQuery;

  assertEquals(ast.kind, "SelectQuery");
  const expr = ast.expr;
  assertEquals(expr.kind, "TupleAccessExpr");
  if (expr.kind === "TupleAccessExpr") {
    assertEquals(expr.accessType, "index");
    assertEquals(expr.index, 0);
    assertEquals(expr.tuple.kind, "TupleExpr");
  }
});

Deno.test("Tuple Access - Parse numeric index .2 on tuple", () => {
  const ast = parseEdgeQL("SELECT (10, 20, 30).2") as SelectQuery;

  assertEquals(ast.kind, "SelectQuery");
  const expr = ast.expr;
  assertEquals(expr.kind, "TupleAccessExpr");
  if (expr.kind === "TupleAccessExpr") {
    assertEquals(expr.accessType, "index");
    assertEquals(expr.index, 2);
  }
});

// =========================================================================
// Parser Tests: Named Tuple Field Access
// =========================================================================

Deno.test("Tuple Access - Parse named field access .name", () => {
  const ast = parseEdgeQL("SELECT (name := 'foo').name") as SelectQuery;

  assertEquals(ast.kind, "SelectQuery");
  const expr = ast.expr;
  assertEquals(expr.kind, "TupleAccessExpr");
  if (expr.kind === "TupleAccessExpr") {
    assertEquals(expr.accessType, "name");
    assertEquals(expr.fieldName, "name");
    assertEquals(expr.tuple.kind, "NamedTuple");
  }
});

Deno.test("Tuple Access - Parse named field access .age", () => {
  const ast = parseEdgeQL(
    "SELECT (name := 'foo', age := 30).age"
  ) as SelectQuery;

  assertEquals(ast.kind, "SelectQuery");
  const expr = ast.expr;
  assertEquals(expr.kind, "TupleAccessExpr");
  if (expr.kind === "TupleAccessExpr") {
    assertEquals(expr.accessType, "name");
    assertEquals(expr.fieldName, "age");
  }
});

// =========================================================================
// Compiler Tests: Numeric Index Access
// =========================================================================

Deno.test("Tuple Access - Compile .0 on tuple reads element 0 as its type", () => {
  const sql = compileEdgeQL("SELECT (1, 2, 3).0");

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array("
  );
  assertEquals(
    sql.includes("->> 0 AS bigint)"),
    true,
    "SQL should cast ->> 0 to bigint for index access"
  );
});

Deno.test("Tuple Access - Compile .2 on tuple for third element", () => {
  const sql = compileEdgeQL("SELECT (10, 20, 30).2");

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array("
  );
  assertEquals(
    sql.includes("->> 2 AS bigint)"),
    true,
    "SQL should cast ->> 2 to bigint for third element access"
  );
});

// =========================================================================
// Compiler Tests: Named Field Access
// =========================================================================

Deno.test("Tuple Access - Named tuple .name access produces ->> 'name'", () => {
  const sql = compileEdgeQL("SELECT (name := 'foo').name");

  assertEquals(
    sql.includes("jsonb_build_object("),
    true,
    "SQL should contain jsonb_build_object( for named tuple"
  );
  assertEquals(
    sql.includes("->> 'name'"),
    true,
    "SQL should contain ->> 'name' for named field access"
  );
});

Deno.test("Tuple Access - Named tuple .age access produces ->> 'age'", () => {
  const sql = compileEdgeQL("SELECT (name := 'foo', age := 30).age");

  assertEquals(
    sql.includes("jsonb_build_object("),
    true,
    "SQL should contain jsonb_build_object("
  );
  assertEquals(
    sql.includes("->> 'age'"),
    true,
    "SQL should contain ->> 'age' for named field access"
  );
});

Deno.test("Tuple Access - a named element reads as its type, a str element as text", () => {
  assertEquals(compileEdgeQL("SELECT (a := 1).a").includes("CAST((jsonb_build_object('a', 1)) ->> 'a' AS bigint)"), true);
  assertEquals(compileEdgeQL("SELECT (a := 1, b := 'x').b").includes("(jsonb_build_object('a', 1, 'b', 'x')) ->> 'b'"), true);
  // By position, a named tuple's element is read by its name.
  assertEquals(compileEdgeQL("SELECT (a := 1, b := 'x').1").includes("->> 'b'"), true);
});

Deno.test("Tuple Access - an element read inside an operator binding tighter than ->> is grouped", () => {
  assertEquals(compileEdgeQL("SELECT 'y' ++ (a := 'x').a").includes("'y' || ((jsonb_build_object('a', 'x')) ->> 'a')"), true);
  // A comparison binds looser, and needs none.
  assertEquals(compileEdgeQL("SELECT 'x' = (a := 'x').a").includes("'x' = (jsonb_build_object('a', 'x')) ->> 'a'"), true);
});

Deno.test("Tuple Access - '??' and 'if … else' over differently named tuples read them by position", () => {
  assertEquals(compileEdgeQL("SELECT (a := 1) ?? (b := 2)").includes("jsonb_build_array((jsonb_build_object('a', 1)) -> 'a')"), true);
  assertEquals(compileEdgeQL("SELECT (a := 1) if true else (b := 2)").includes("jsonb_build_array((jsonb_build_object('b', 2)) -> 'b')"), true);
  assertEquals(compileEdgeQL("SELECT (a := 1) ?? (a := 2)").includes("jsonb_build_array"), false);
});

// =========================================================================
// Integration Tests: Tuple Access in SELECT
// =========================================================================

Deno.test("Tuple Access - Tuple access in SELECT expression", () => {
  const sql = compileEdgeQL("SELECT (1, 2, 3).1");

  assertEquals(
    sql.includes("SELECT"),
    true,
    "SQL should contain SELECT"
  );
  assertEquals(
    sql.includes("jsonb_build_array(1, 2, 3)"),
    true,
    "SQL should contain the full jsonb_build_array call"
  );
  assertEquals(
    sql.includes("->> 1 AS bigint)"),
    true,
    "SQL should cast ->> 1 to bigint for second element access"
  );
});

Deno.test("Tuple Access - Nested tuple access: outer tuple first element", () => {
  const sql = compileEdgeQL("SELECT ((1, 2), (3, 4)).0");

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array( for nested tuples"
  );
  assertEquals(
    sql.includes("-> 0"),
    true,
    "SQL should contain -> 0 for outer tuple first element access"
  );
});

// =========================================================================
// Codegen Unit Tests: JsonbAccessExpression
// =========================================================================

Deno.test("Tuple Access - Codegen: JsonbAccessExpression with ->", () => {
  const gen = new SQLCodeGenerator();
  const sql = gen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "JsonbAccessExpression",
          expression: {
            kind: "FunctionCall",
            name: "jsonb_build_array",
            args: [
              { kind: "LiteralExpression", type: "number", value: 1 },
              { kind: "LiteralExpression", type: "number", value: 2 }
            ]
          },
          operator: "->",
          accessor: { kind: "LiteralExpression", type: "number", value: 0 }
        }
      }]
    }
  });

  assertEquals(
    sql.includes("jsonb_build_array(1, 2)") && sql.includes("-> 0"),
    true,
    "Codegen should render jsonb_build_array(...) -> 0"
  );
});

Deno.test("Tuple Access - Codegen: JsonbAccessExpression with ->>", () => {
  const gen = new SQLCodeGenerator();
  const sql = gen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "JsonbAccessExpression",
          expression: {
            kind: "FunctionCall",
            name: "jsonb_build_object",
            args: [
              { kind: "LiteralExpression", type: "string", value: "name" },
              { kind: "LiteralExpression", type: "string", value: "test" }
            ]
          },
          operator: "->>",
          accessor: {
            kind: "LiteralExpression",
            type: "string",
            value: "name"
          }
        }
      }]
    }
  });

  assertEquals(
    sql.includes("->> 'name'"),
    true,
    "Codegen should render ->> 'name' for named field access"
  );
});

// =========================================================================
// Stored named-tuple property fields: `.stamp.when`
// =========================================================================

Deno.test("Tuple Access - field of a stored named-tuple property reads as the field's type", async () => {
  const { SchemaManager } = await import("../migration/schema-manager.ts");
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(
    "module default { type Evt { stamp: tuple<n: int64, when: datetime, tags: array<str>, note: str>; } }",
    { validate: false }
  );
  if (!parsed.ok) {
    throw parsed.error;
  }
  const evtCompiler = new EdgeQLCompiler(manager.modulesToSchema(parsed.value), { enableAccessControl: false });
  const compile = (source: string): string => {
    const result = evtCompiler.compile(new EdgeQLParser(source).parse());
    if (!result.ok) {
      throw result.error;
    }
    return codegen.generate(result.value).replace(/\s+/g, " ");
  };

  const filtered = compile("select Evt filter .stamp.when > <datetime>'2024-06-01T00:00:00Z' order by .stamp.n");
  assertEquals(/CAST\(evt_\d+\.stamp ->> 'when' AS timestamptz\) >/.test(filtered), true, filtered);
  assertEquals(/ORDER BY CAST\(evt_\d+\.stamp ->> 'n' AS bigint\)/.test(filtered), true, filtered);

  const shaped = compile("select Evt { tags := .stamp.tags, note := .stamp.`note` }");
  assertEquals(/'tags', evt_\d+\.stamp -> 'tags'/.test(shaped), true, shaped);
  assertEquals(/'note', evt_\d+\.stamp ->> 'note'/.test(shaped), true, shaped);
});
