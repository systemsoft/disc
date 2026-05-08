/**
 * Tests for IndexExpression and SliceExpression
 * Covers EdgeQL array indexing, string slicing, and JSON access compilation.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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
// Parser: IndexExpression
// =========================================================================

Deno.test("indexing-slicing - parser produces IndexExpression for expr[0]", () => {
  const ast = parseEdgeQL("SELECT [10, 20, 30][0]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "IndexExpression");
  }
});

Deno.test("indexing-slicing - IndexExpression carries correct index literal", () => {
  const ast = parseEdgeQL("SELECT [10, 20, 30][2]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "IndexExpression");
    if (expr.kind === "IndexExpression") {
      assertEquals(expr.index.kind, "Literal");
      if (expr.index.kind === "Literal") {
        assertEquals(expr.index.value, 2);
      }
    }
  }
});

Deno.test("indexing-slicing - IndexExpression base expr is the array literal", () => {
  const ast = parseEdgeQL("SELECT ['a', 'b', 'c'][1]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "IndexExpression");
    if (expr.kind === "IndexExpression") {
      assertEquals(expr.expr.kind, "ArrayExpr");
    }
  }
});

Deno.test("indexing-slicing - IndexExpression with string key index", () => {
  const ast = parseEdgeQL(`SELECT <json>'{"x":1}'['x']`);

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "IndexExpression");
    if (expr.kind === "IndexExpression") {
      assertEquals(expr.index.kind, "Literal");
      if (expr.index.kind === "Literal") {
        assertEquals(expr.index.type, "string");
        assertEquals(expr.index.value, "x");
      }
    }
  }
});

// =========================================================================
// Parser: SliceExpression
// =========================================================================

Deno.test("indexing-slicing - parser produces SliceExpression for expr[1:3]", () => {
  const ast = parseEdgeQL("SELECT 'hello'[1:3]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "SliceExpression");
  }
});

Deno.test("indexing-slicing - SliceExpression [1:3] has start and end", () => {
  const ast = parseEdgeQL("SELECT 'hello'[1:3]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "SliceExpression");
    if (expr.kind === "SliceExpression") {
      assertEquals(expr.start !== undefined, true);
      assertEquals(expr.end !== undefined, true);
      if (expr.start?.kind === "Literal") {
        assertEquals(expr.start.value, 1);
      }
      if (expr.end?.kind === "Literal") {
        assertEquals(expr.end.value, 3);
      }
    }
  }
});

Deno.test("indexing-slicing - SliceExpression [2:] has start only", () => {
  const ast = parseEdgeQL("SELECT 'hello'[2:]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "SliceExpression");
    if (expr.kind === "SliceExpression") {
      assertEquals(expr.start !== undefined, true);
      assertEquals(expr.end, undefined);
      if (expr.start?.kind === "Literal") {
        assertEquals(expr.start.value, 2);
      }
    }
  }
});

Deno.test("indexing-slicing - SliceExpression [:4] has end only", () => {
  const ast = parseEdgeQL("SELECT 'hello'[:4]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "SliceExpression");
    if (expr.kind === "SliceExpression") {
      assertEquals(expr.start, undefined);
      assertEquals(expr.end !== undefined, true);
      if (expr.end?.kind === "Literal") {
        assertEquals(expr.end.value, 4);
      }
    }
  }
});

Deno.test("indexing-slicing - SliceExpression [:] has neither start nor end", () => {
  const ast = parseEdgeQL("SELECT 'hello'[:]");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "SliceExpression");
    if (expr.kind === "SliceExpression") {
      assertEquals(expr.start, undefined);
      assertEquals(expr.end, undefined);
    }
  }
});

// =========================================================================
// Parser: [IS Type] regression
// =========================================================================

Deno.test("indexing-slicing - [IS Type] still produces Path with type_intersection step", () => {
  const ast = parseEdgeQL("SELECT User.posts[IS Post].title");

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const expr = ast.expr;
    assertEquals(expr.kind, "Path");
    if (expr.kind === "Path") {
      const intersectionStep = expr.steps.find(
        s => s.type === "type_intersection"
      );
      assertEquals(intersectionStep !== undefined, true);
      if (intersectionStep) {
        assertEquals(intersectionStep.name, "Post");
      }
    }
  }
});

// =========================================================================
// Compiler: Array indexing
// =========================================================================

Deno.test("indexing-slicing - positive array index compiles to CASE WHEN ... ELSE ... END", () => {
  const sql = compileEdgeQL("SELECT [10, 20, 30][0]");

  assertStringIncludes(sql, "CASE WHEN");
  assertStringIncludes(sql, "CARDINALITY(");
  assertStringIncludes(sql, "END");
});

Deno.test("indexing-slicing - negative array index uses CARDINALITY for end-relative access", () => {
  const sql = compileEdgeQL("SELECT [10, 20, 30][-1]");

  assertStringIncludes(sql, "CASE WHEN");
  assertStringIncludes(sql, "CARDINALITY(");
  assertStringIncludes(sql, "-1");
  assertStringIncludes(sql, "+ 1");
});

Deno.test("indexing-slicing - array index in SELECT context produces valid SQL", () => {
  const sql = compileEdgeQL("SELECT [1, 2, 3][1]");

  assertStringIncludes(sql, "SELECT");
  assertStringIncludes(sql, "ARRAY[");
  assertStringIncludes(sql, "CASE WHEN");
  assertStringIncludes(sql, "ELSE");
  assertStringIncludes(sql, "+ 1");
});

// =========================================================================
// Compiler: JSON access
// =========================================================================

Deno.test("indexing-slicing - string key index compiles to jsonb -> operator", () => {
  const sql = compileEdgeQL(`SELECT <json>'{"key":"val"}'['key']`);

  assertStringIncludes(sql, "->");
  assertStringIncludes(sql, "'key'");
});

Deno.test("indexing-slicing - json type cast with integer index compiles to jsonb -> operator", () => {
  const sql = compileEdgeQL("SELECT <json>'[1,2,3]'[0]");

  assertStringIncludes(sql, "->");
  assertStringIncludes(sql, "0");
});

// =========================================================================
// Compiler: String slicing
// =========================================================================

Deno.test("indexing-slicing - slice [1:3] compiles to SUBSTRING FROM start+1 FOR end-start", () => {
  const sql = compileEdgeQL("SELECT 'hello'[1:3]");

  assertStringIncludes(sql, "SUBSTRING(");
  assertStringIncludes(sql, "FROM");
  assertStringIncludes(sql, "FOR");
  assertStringIncludes(sql, "+ 1");
  assertStringIncludes(sql, "- 1");
});

Deno.test("indexing-slicing - slice [2:] compiles to SUBSTRING FROM start+1 without FOR", () => {
  const sql = compileEdgeQL("SELECT 'hello'[2:]");

  assertStringIncludes(sql, "SUBSTRING(");
  assertStringIncludes(sql, "FROM");
  assertStringIncludes(sql, "2 + 1");
  assertEquals(sql.includes(" FOR "), false);
});

Deno.test("indexing-slicing - slice [:3] compiles to SUBSTRING FROM 1 FOR end", () => {
  const sql = compileEdgeQL("SELECT 'hello'[:3]");

  assertStringIncludes(sql, "SUBSTRING(");
  assertStringIncludes(sql, "FROM 1 FOR");
  assertStringIncludes(sql, "3");
});

Deno.test("indexing-slicing - slice [:] passes through the base expression unchanged", () => {
  const sql = compileEdgeQL("SELECT 'hello'[:]");

  // The identity slice produces no SUBSTRING wrapper
  assertEquals(sql.includes("SUBSTRING"), false);
  assertStringIncludes(sql, "'hello'");
});

// =========================================================================
// Compiler: Chained indexing
// =========================================================================

Deno.test("indexing-slicing - chained index expr[0:3][0] produces nested CASE inside SUBSTRING", () => {
  const sql = compileEdgeQL("SELECT 'hello'[0:3][0]");

  // The outer index wraps the SUBSTRING result in a CASE WHEN expression
  assertStringIncludes(sql, "CASE WHEN");
  assertStringIncludes(sql, "SUBSTRING(");
});
