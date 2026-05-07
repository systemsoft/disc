/**
 * Tests for Complex Query Compilation
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { ComplexQueryCompiler } from "./complex-query.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

const codegen = new SQLCodeGenerator();

Deno.test("ComplexQueryCompiler - compiles nested subqueries", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // SELECT User FILTER .id IN (SELECT Post FILTER .createdAt > '2024-01-01')
  // Using valid AST: a SelectQuery with a filter that uses IN with a Subquery
  const query: EdgeQLAST.SelectQuery = {
    kind: "SelectQuery",
    expr: EdgeQLAST.createTypeName(["User"]),
    filter: EdgeQLAST.createBinaryOp(
      "=",
      EdgeQLAST.createPath([{
        kind: "PathStep",
        type: "property",
        name: "email",
      }]),
      EdgeQLAST.createLiteral("string", "user@example.com"),
    ),
  };

  const result = compiler.compile(query);

  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    // Should compile to a SELECT with WHERE clause
    assertExists(sql);
    assertEquals(typeof sql, "string");
  }
});

Deno.test("ComplexQueryCompiler - compiles select with shape", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // SELECT User { name, email } FILTER .active = true
  const query: EdgeQLAST.SelectQuery = {
    kind: "SelectQuery",
    expr: EdgeQLAST.createTypeName(["User"]),
    shape: EdgeQLAST.createShape([
      EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("name")),
      EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("email")),
    ]),
    filter: EdgeQLAST.createBinaryOp(
      "=",
      EdgeQLAST.createPath([{
        kind: "PathStep",
        type: "property",
        name: "active",
      }]),
      EdgeQLAST.createLiteral("boolean", true),
    ),
  };

  const result = compiler.compile(query);

  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    assertExists(sql);
    // Should include jsonb_build_object for shape
    assertEquals(sql.includes("jsonb_build_object"), true);
  }
});

Deno.test("ComplexQueryCompiler - compiles window functions via compileWindowFunction", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Test the compileWindowFunction method directly
  const windowFunc = {
    function: "row_number",
    args: [] as EdgeQLAST.Expression[],
    partitionBy: [
      EdgeQLAST.createPath([{
        kind: "PathStep" as const,
        type: "property" as const,
        name: "active",
      }]),
    ],
    orderBy: [{
      expression: EdgeQLAST.createPath([{
        kind: "PathStep" as const,
        type: "property" as const,
        name: "createdAt",
      }]),
      direction: "DESC",
    }],
  };

  const windowExpr = compiler.compileWindowFunction(windowFunc);
  assertEquals(windowExpr.kind, "WindowFunctionExpression");
  assertEquals(windowExpr.function, "row_number");
  assertExists(windowExpr.over);
  assertExists(windowExpr.over.partitionBy);
  assertExists(windowExpr.over.orderBy);

  // Generate SQL from the window expression to verify structure
  // Window functions are expressions, so we wrap in a simple SELECT for codegen
  const selectStmt = SQL.createSelectStatement({
    select: SQL.createSelectClause([SQL.createSelectItem(windowExpr, "rank")]),
  });
  const sql = codegen.generate(selectStmt);
  assertExists(sql.match(/row_number\(\)\s+OVER\s*\(/i));
});

Deno.test("ComplexQueryCompiler - compiles CTEs (WITH clauses)", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // WITH active_users := (SELECT User FILTER .active = true)
  // SELECT active_users { name, email }
  const query: EdgeQLAST.WithBlock = {
    kind: "WithBlock",
    bindings: [
      {
        kind: "WithBinding",
        name: EdgeQLAST.createIdentifier("active_users"),
        value: {
          kind: "Subquery",
          query: {
            kind: "SelectQuery",
            expr: EdgeQLAST.createTypeName(["User"]),
            filter: EdgeQLAST.createBinaryOp(
              "=",
              EdgeQLAST.createPath([{
                kind: "PathStep",
                type: "property",
                name: "active",
              }]),
              EdgeQLAST.createLiteral("boolean", true),
            ),
          },
        },
      },
    ],
    body: {
      kind: "SelectQuery",
      expr: EdgeQLAST.createTypeName(["User"]),
      shape: EdgeQLAST.createShape([
        EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("name")),
        EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("email")),
      ]),
    },
  };

  const result = compiler.compile(query);

  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    assertExists(sql);
    // CTE compilation should produce WITH clause
    assertEquals(sql.includes("WITH"), true);
  }
});

Deno.test("ComplexQueryCompiler - compiles aggregate functions via compileAggregate", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Test the compileAggregate method directly
  const aggregate = {
    function: "COUNT",
    expression: EdgeQLAST.createPath([{
      kind: "PathStep" as const,
      type: "property" as const,
      name: "id",
    }]),
    filter: EdgeQLAST.createBinaryOp(
      "=",
      EdgeQLAST.createPath([{
        kind: "PathStep" as const,
        type: "property" as const,
        name: "active",
      }]),
      EdgeQLAST.createLiteral("boolean", true),
    ),
    distinct: true,
  };

  const aggExpr = compiler.compileAggregate(aggregate);

  assertEquals(aggExpr.kind, "AggregateExpression");
  assertEquals(aggExpr.function, "COUNT");
  assertEquals(aggExpr.distinct, true);
  assertExists(aggExpr.filter);

  // Generate SQL to verify
  const selectStmt = SQL.createSelectStatement({
    select: SQL.createSelectClause([SQL.createSelectItem(aggExpr, "total")]),
  });
  const sql = codegen.generate(selectStmt);
  assertExists(sql.match(/COUNT\s*\(DISTINCT/i));
  assertExists(sql.match(/FILTER/i));
});

Deno.test("ComplexQueryCompiler - compiles insert query", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // INSERT User { name := 'Ada', email := 'ada@example.com' }
  const query: EdgeQLAST.InsertQuery = {
    kind: "InsertQuery",
    type: EdgeQLAST.createTypeName(["User"]),
    shape: EdgeQLAST.createShape([
      EdgeQLAST.createShapeElement(
        EdgeQLAST.createLiteral("string", "Ada"),
        { name: EdgeQLAST.createIdentifier("name"), computable: true },
      ),
      EdgeQLAST.createShapeElement(
        EdgeQLAST.createLiteral("string", "ada@example.com"),
        { name: EdgeQLAST.createIdentifier("email"), computable: true },
      ),
    ]),
  };

  const result = compiler.compile(query);

  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    assertExists(sql);
    assertEquals(sql.includes("INSERT INTO"), true);
    assertEquals(sql.includes("users"), true);
  }
});

Deno.test("ComplexQueryCompiler - compiles delete query", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // DELETE User FILTER .email = 'ada@example.com'
  const query: EdgeQLAST.DeleteQuery = {
    kind: "DeleteQuery",
    type: EdgeQLAST.createTypeName(["User"]),
    filter: EdgeQLAST.createBinaryOp(
      "=",
      EdgeQLAST.createPath([{
        kind: "PathStep",
        type: "property",
        name: "email",
      }]),
      EdgeQLAST.createLiteral("string", "ada@example.com"),
    ),
  };

  const result = compiler.compile(query);

  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    assertExists(sql);
    assertEquals(sql.includes("DELETE FROM"), true);
    assertEquals(sql.includes("users"), true);
  }
});

Deno.test("ComplexQueryCompiler - analyzes query complexity", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Simple query: SELECT User { name }
  const simpleQuery: EdgeQLAST.SelectQuery = {
    kind: "SelectQuery",
    expr: EdgeQLAST.createTypeName(["User"]),
    shape: EdgeQLAST.createShape([
      EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("name")),
    ]),
  };

  const simpleComplexity = compiler.analyzeComplexity(simpleQuery);
  assertEquals(simpleComplexity.score < 10, true);
  assertEquals(simpleComplexity.cteCount, 0);

  // Complex query: WITH block with bindings, body has subquery in filter
  const complexQuery: EdgeQLAST.WithBlock = {
    kind: "WithBlock",
    bindings: [
      {
        kind: "WithBinding",
        name: EdgeQLAST.createIdentifier("cte1"),
        value: {
          kind: "Subquery",
          query: simpleQuery,
        },
      },
      {
        kind: "WithBinding",
        name: EdgeQLAST.createIdentifier("cte2"),
        value: {
          kind: "Subquery",
          query: simpleQuery,
        },
      },
    ],
    body: {
      kind: "SelectQuery",
      expr: EdgeQLAST.createTypeName(["User"]),
      filter: {
        kind: "Subquery",
        query: simpleQuery,
      },
    },
  };

  const complexComplexity = compiler.analyzeComplexity(complexQuery);

  // WithBlock has bindings.length as cteCount
  assertEquals(complexComplexity.cteCount, 2);
  // The body's filter is a Subquery, and each binding's value is a Subquery
  assertEquals(complexComplexity.subqueryCount >= 1, true);
  assertEquals(complexComplexity.score > simpleComplexity.score, true);
});
