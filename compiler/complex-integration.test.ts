/**
 * Integration tests for complex query compilation
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { ComplexQueryCompiler } from "./complex-query.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

const codegen = new SQLCodeGenerator();

Deno.test("Complex query integration - parse and compile select with filter", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Parse a simple SELECT query with filter
  const edgeql = `SELECT User { name, email } FILTER .name = 'Ada'`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");

  const compileResult = compiler.compile(ast);
  assertEquals(compileResult.ok, true);

  if (compileResult.ok) {
    const sql = codegen.generate(compileResult.value);

    // Verify basic structure
    assertExists(sql);
    assertEquals(sql.includes("jsonb_build_object"), true);
    assertEquals(sql.includes("users"), true);
    assertEquals(sql.includes("WHERE"), true);
  }
});

Deno.test("Complex query integration - parse and compile select with order and limit", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  const edgeql = `SELECT User { name, email } ORDER BY .name ASC LIMIT 10`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");

  const compileResult = compiler.compile(ast);
  assertEquals(compileResult.ok, true);

  if (compileResult.ok) {
    const sql = codegen.generate(compileResult.value);

    assertExists(sql);
    assertEquals(sql.includes("ORDER BY"), true);
    assertEquals(sql.includes("LIMIT"), true);
  }
});

Deno.test("Complex query integration - parse and compile insert", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  const edgeql = `INSERT User { name := 'Billie', email := 'billie@example.com' }`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  assertEquals(ast.kind, "InsertQuery");

  const compileResult = compiler.compile(ast);
  assertEquals(compileResult.ok, true);

  if (compileResult.ok) {
    const sql = codegen.generate(compileResult.value);

    assertExists(sql);
    assertEquals(sql.includes("INSERT INTO"), true);
    assertEquals(sql.includes("users"), true);
    assertEquals(sql.includes("RETURNING"), true);
  }
});

Deno.test("Complex query integration - parse and compile update", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  const edgeql = `UPDATE User FILTER .email = 'billie@example.com' SET { name := 'Robert' }`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  assertEquals(ast.kind, "UpdateQuery");

  const compileResult = compiler.compile(ast);
  assertEquals(compileResult.ok, true);

  if (compileResult.ok) {
    const sql = codegen.generate(compileResult.value);

    assertExists(sql);
    assertEquals(sql.includes("UPDATE"), true);
    assertEquals(sql.includes("users"), true);
    assertEquals(sql.includes("SET"), true);
    assertEquals(sql.includes("WHERE"), true);
  }
});

Deno.test("Complex query integration - parse and compile delete", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  const edgeql = `DELETE User FILTER .email = 'billie@example.com'`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  assertEquals(ast.kind, "DeleteQuery");

  const compileResult = compiler.compile(ast);
  assertEquals(compileResult.ok, true);

  if (compileResult.ok) {
    const sql = codegen.generate(compileResult.value);

    assertExists(sql);
    assertEquals(sql.includes("DELETE FROM"), true);
    assertEquals(sql.includes("users"), true);
    assertEquals(sql.includes("WHERE"), true);
  }
});

Deno.test("Complex query integration - parse and compile WITH block", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // WITH block: bind a subquery then SELECT from the main type
  const edgeql = `WITH active := (SELECT User FILTER .active = true) SELECT User { name, email }`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  assertEquals(ast.kind, "WithBlock");

  const compileResult = compiler.compile(ast);
  assertEquals(compileResult.ok, true);

  if (compileResult.ok) {
    const sql = codegen.generate(compileResult.value);

    assertExists(sql);
    // Should produce a CTE-based SQL
    assertEquals(sql.includes("WITH"), true);
  }
});

Deno.test("Query complexity analysis - simple vs complex ASTs", () => {
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
  assertEquals(simpleComplexity.subqueryCount, 0);

  // Complex query: WithBlock with multiple bindings and subqueries in body
  const complexQuery: EdgeQLAST.WithBlock = {
    kind: "WithBlock",
    bindings: [
      {
        kind: "WithBinding",
        name: EdgeQLAST.createIdentifier("cte1"),
        value: { kind: "Subquery", query: simpleQuery },
      },
      {
        kind: "WithBinding",
        name: EdgeQLAST.createIdentifier("cte2"),
        value: { kind: "Subquery", query: simpleQuery },
      },
      {
        kind: "WithBinding",
        name: EdgeQLAST.createIdentifier("cte3"),
        value: { kind: "Subquery", query: simpleQuery },
      },
    ],
    body: {
      kind: "SelectQuery",
      expr: EdgeQLAST.createTypeName(["User"]),
      filter: { kind: "Subquery", query: simpleQuery },
    },
  };

  const complexComplexity = compiler.analyzeComplexity(complexQuery);

  // WithBlock counts bindings as CTEs
  assertEquals(complexComplexity.cteCount, 3);
  // Subqueries in bindings and body filter
  assertEquals(complexComplexity.subqueryCount >= 1, true);
  assertEquals(complexComplexity.score > simpleComplexity.score, true);
  assertEquals(complexComplexity.warnings.length >= 0, true);
});

Deno.test("Query complexity analysis - parsed query", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Parse a simple query and analyze its complexity
  const edgeql = `SELECT User { name, email }`;
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  const complexity = compiler.analyzeComplexity(ast);

  assertEquals(complexity.score < 10, true);
  assertEquals(complexity.cteCount, 0);
  assertEquals(complexity.subqueryCount, 0);
  assertEquals(complexity.warnings.length, 0);
});

Deno.test("Complex query integration - compileWindowFunction produces valid SQL", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Use compileWindowFunction directly to test window function SQL generation
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
    frame: {
      mode: "ROWS",
      start: "UNBOUNDED PRECEDING",
      end: "CURRENT ROW",
    },
  };

  const windowExpr = compiler.compileWindowFunction(windowFunc);

  // Wrap in SELECT for codegen
  const stmt = SQL.createSelectStatement({
    select: SQL.createSelectClause([
      SQL.createSelectItem(windowExpr, "rank"),
    ]),
  });
  const sql = codegen.generate(stmt);

  assertExists(sql.match(/row_number\(\)\s+OVER\s*\(/i));
  assertExists(sql.match(/PARTITION BY/i));
  assertExists(sql.match(/ORDER BY/i));
  assertExists(sql.match(/ROWS BETWEEN/i));
});

Deno.test("Complex query integration - compileAggregate with filter", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);

  // Test aggregate compilation with FILTER and DISTINCT
  const aggregate = {
    function: "SUM",
    expression: EdgeQLAST.createPath([{
      kind: "PathStep" as const,
      type: "property" as const,
      name: "age",
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
    distinct: false,
  };

  const aggExpr = compiler.compileAggregate(aggregate);

  assertEquals(aggExpr.kind, "AggregateExpression");
  assertEquals(aggExpr.function, "SUM");
  assertExists(aggExpr.filter);

  // Wrap in SELECT for codegen
  const stmt = SQL.createSelectStatement({
    select: SQL.createSelectClause([
      SQL.createSelectItem(aggExpr, "total"),
    ]),
  });
  const sql = codegen.generate(stmt);

  assertExists(sql.match(/SUM\(/i));
  assertExists(sql.match(/FILTER/i));
});
