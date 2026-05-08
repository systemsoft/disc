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
  const ast = parseEdgeQL("SELECT (name := 'foo', age := 30).age") as SelectQuery;

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

Deno.test("Tuple Access - Compile .0 on tuple produces jsonb_build_array -> 0", () => {
  const sql = compileEdgeQL("SELECT (1, 2, 3).0");

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array("
  );
  assertEquals(
    sql.includes("-> 0"),
    true,
    "SQL should contain -> 0 for index access"
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
    sql.includes("-> 2"),
    true,
    "SQL should contain -> 2 for third element access"
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
    sql.includes("-> 1"),
    true,
    "SQL should contain -> 1 for second element access"
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
