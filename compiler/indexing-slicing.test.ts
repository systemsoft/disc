/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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
  const ast = parseEdgeQL(`SELECT (<json>'{"x":1}')['x']`);

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
// Parser: an element's field
// =========================================================================

Deno.test("indexing-slicing - a field after an index is a tuple element access", () => {
  for (const [query, base] of [["SELECT [(n := 1)][0].n", "IndexExpression"], ["SELECT ([(a := (b := 5))][0]).a.b", "TupleAccessExpr"]]) {
    const ast = parseEdgeQL(query);
    assertEquals(ast.kind, "SelectQuery");
    if (ast.kind === "SelectQuery" && ast.expr.kind === "TupleAccessExpr") {
      assertEquals(ast.expr.accessType, "name");
      assertEquals(ast.expr.tuple.kind, base);
    } else {
      throw new Error(`${query}: expected a TupleAccessExpr`);
    }
  }
});

// =========================================================================
// Compiler: Array, str and bytes indexing (disc_index, lib/stdlib-sql.ts)
// =========================================================================

Deno.test("indexing-slicing - an array index is disc_index, which takes Gel's 0-based index and raises out of bounds", () => {
  assertStringIncludes(compileEdgeQL("SELECT [10, 20, 30][0]"), "disc_index(ARRAY[10, 20, 30], 0)");
  assertStringIncludes(compileEdgeQL("SELECT [10, 20, 30][-1]"), "disc_index(ARRAY[10, 20, 30], -1)");
});

Deno.test("indexing-slicing - str and bytes indexes are disc_index too", () => {
  assertStringIncludes(compileEdgeQL("SELECT 'abc'[1]"), "disc_index('abc', 1)");
  assertStringIncludes(compileEdgeQL("SELECT (<bytes>$b)[-1]"), "disc_index(CAST($1 AS bytea), -1)");
});

// =========================================================================
// Compiler: JSON access
// =========================================================================

Deno.test("indexing-slicing - string key index compiles to jsonb -> operator", () => {
  const sql = compileEdgeQL(`SELECT (<json>'{"key":"val"}')['key']`);

  assertStringIncludes(sql, "->");
  assertStringIncludes(sql, "'key'");
});

Deno.test("indexing-slicing - json type cast with integer index compiles to jsonb -> operator", () => {
  const sql = compileEdgeQL("SELECT (<json>'[1,2,3]')[0]");

  assertStringIncludes(sql, "->");
  assertStringIncludes(sql, "0");
});

// =========================================================================
// Compiler: Array, str and bytes slicing (disc_slice, lib/stdlib-sql.ts)
// =========================================================================

Deno.test("indexing-slicing - slice [1:3] is disc_slice with both bounds", () => {
  assertStringIncludes(compileEdgeQL("SELECT 'hello'[1:3]"), "disc_slice('hello', 1, 3)");
  assertStringIncludes(compileEdgeQL("SELECT [10, 20, 30][1:-1]"), "disc_slice(ARRAY[10, 20, 30], 1, -1)");
});

Deno.test("indexing-slicing - slice [2:] is disc_slice to the end", () => {
  assertStringIncludes(compileEdgeQL("SELECT 'hello'[2:]"), "disc_slice('hello', 2)");
});

Deno.test("indexing-slicing - slice [:3] is disc_slice from 0", () => {
  assertStringIncludes(compileEdgeQL("SELECT 'hello'[:3]"), "disc_slice('hello', 0, 3)");
});

Deno.test("indexing-slicing - slice [:] passes through the base expression unchanged", () => {
  const sql = compileEdgeQL("SELECT 'hello'[:]");

  assertEquals(sql.includes("disc_slice"), false);
  assertStringIncludes(sql, "'hello'");
});

// =========================================================================
// Compiler: Chained indexing
// =========================================================================

Deno.test("indexing-slicing - chained index expr[0:3][0] indexes the slice", () => {
  assertStringIncludes(compileEdgeQL("SELECT 'hello'[0:3][0]"), "disc_index(disc_slice('hello', 0, 3), 0)");
});
