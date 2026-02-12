/**
 * Tests for Complex Query Compilation
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ComplexQueryCompiler } from "./complex-query.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import * as Context from "./context.ts";

Deno.test("ComplexQueryCompiler - compiles nested subqueries", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    selections: [{
      kind: "Selection",
      expression: {
        kind: "Subquery",
        query: {
          kind: "Query",
          type: "select",
          selections: [{
            kind: "Selection",
            expression: { kind: "TypeRef", name: "User" }
          }],
          from: { kind: "TypeRef", name: "User" },
          filter: {
            kind: "BinaryOp",
            op: "IN",
            left: { kind: "Path", steps: ["id"] },
            right: {
              kind: "Subquery",
              query: {
                kind: "Query",
                type: "select",
                selections: [{
                  kind: "Selection",
                  expression: { kind: "Path", steps: ["author_id"] }
                }],
                from: { kind: "TypeRef", name: "Post" },
                filter: {
                  kind: "BinaryOp",
                  op: ">",
                  left: { kind: "Path", steps: ["views"] },
                  right: { kind: "Literal", value: 1000, type: "int" }
                }
              }
            }
          }
        }
      }
    }]
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    // Should compile to nested SELECT with IN clause
    assertExists(sql.match(/SELECT.*FROM.*users.*WHERE.*id\s+IN\s*\(/i));
    assertExists(sql.match(/SELECT.*author_id.*FROM.*posts.*WHERE.*views\s*>\s*1000/i));
  }
});

Deno.test("ComplexQueryCompiler - optimizes correlated subqueries", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    selections: [
      {
        kind: "Selection",
        expression: { kind: "Path", steps: ["name"] }
      },
      {
        kind: "Selection",
        alias: "post_count",
        expression: {
          kind: "Aggregate",
          function: "count",
          expression: {
            kind: "Subquery",
            query: {
              kind: "Query",
              type: "select",
              selections: [{
                kind: "Selection",
                expression: { kind: "TypeRef", name: "Post" }
              }],
              from: { kind: "TypeRef", name: "Post" },
              filter: {
                kind: "BinaryOp",
                op: "=",
                left: { kind: "Path", steps: ["author_id"] },
                right: { kind: "OuterRef", path: ["id"] }
              }
            }
          }
        }
      }
    ],
    from: { kind: "TypeRef", name: "User" }
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    // Should use lateral join for optimization
    assertExists(sql.match(/LEFT\s+JOIN\s+LATERAL/i));
  }
});

Deno.test("ComplexQueryCompiler - compiles window functions", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    selections: [
      {
        kind: "Selection",
        expression: { kind: "Path", steps: ["title"] }
      },
      {
        kind: "Selection",
        alias: "rank",
        expression: {
          kind: "WindowFunction",
          function: "row_number",
          partitionBy: [{ kind: "Path", steps: ["category"] }],
          orderBy: [{
            expression: { kind: "Path", steps: ["created_at"] },
            direction: "DESC"
          }]
        }
      }
    ],
    from: { kind: "TypeRef", name: "Post" }
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    assertExists(sql.match(/row_number\(\)\s+OVER\s*\(/i));
    assertExists(sql.match(/PARTITION\s+BY.*category/i));
    assertExists(sql.match(/ORDER\s+BY.*created_at\s+DESC/i));
  }
});

Deno.test("ComplexQueryCompiler - compiles CTEs (WITH clauses)", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    with: [
      {
        kind: "CTE",
        name: "active_users",
        query: {
          kind: "Query",
          type: "select",
          selections: [{
            kind: "Selection",
            expression: { kind: "TypeRef", name: "User" }
          }],
          from: { kind: "TypeRef", name: "User" },
          filter: {
            kind: "BinaryOp",
            op: "=",
            left: { kind: "Path", steps: ["is_active"] },
            right: { kind: "Literal", value: true, type: "bool" }
          }
        }
      },
      {
        kind: "CTE",
        name: "recent_posts",
        query: {
          kind: "Query",
          type: "select",
          selections: [{
            kind: "Selection",
            expression: { kind: "TypeRef", name: "Post" }
          }],
          from: { kind: "TypeRef", name: "Post" },
          filter: {
            kind: "BinaryOp",
            op: ">",
            left: { kind: "Path", steps: ["created_at"] },
            right: { kind: "Function", name: "now", args: [], modifiers: ["-", "7 days"] }
          }
        }
      }
    ],
    selections: [{
      kind: "Selection",
      expression: { kind: "TypeRef", name: "active_users" }
    }],
    from: { kind: "TypeRef", name: "active_users" },
    joins: [{
      kind: "Join",
      type: "inner",
      target: { kind: "TypeRef", name: "recent_posts" },
      on: {
        kind: "BinaryOp",
        op: "=",
        left: { kind: "Path", steps: ["active_users", "id"] },
        right: { kind: "Path", steps: ["recent_posts", "author_id"] }
      }
    }]
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    assertExists(sql.match(/WITH.*active_users\s+AS\s*\(/i));
    assertExists(sql.match(/recent_posts\s+AS\s*\(/i));
    assertExists(sql.match(/FROM\s+active_users.*JOIN\s+recent_posts/i));
  }
});

Deno.test("ComplexQueryCompiler - handles recursive CTEs", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    with: [{
      kind: "CTE",
      name: "category_tree",
      recursive: true,
      query: {
        kind: "UnionQuery",
        queries: [
          {
            kind: "Query",
            type: "select",
            selections: [
              { kind: "Selection", expression: { kind: "Path", steps: ["id"] } },
              { kind: "Selection", expression: { kind: "Path", steps: ["name"] } },
              { kind: "Selection", expression: { kind: "Path", steps: ["parent_id"] } },
              { kind: "Selection", alias: "level", expression: { kind: "Literal", value: 0, type: "int" } }
            ],
            from: { kind: "TypeRef", name: "Category" },
            filter: {
              kind: "BinaryOp",
              op: "IS NULL",
              left: { kind: "Path", steps: ["parent_id"] },
              right: { kind: "Literal", value: null, type: "null" }
            }
          },
          {
            kind: "Query",
            type: "select",
            selections: [
              { kind: "Selection", expression: { kind: "Path", steps: ["c", "id"] } },
              { kind: "Selection", expression: { kind: "Path", steps: ["c", "name"] } },
              { kind: "Selection", expression: { kind: "Path", steps: ["c", "parent_id"] } },
              {
                kind: "Selection",
                alias: "level",
                expression: {
                  kind: "BinaryOp",
                  op: "+",
                  left: { kind: "Path", steps: ["ct", "level"] },
                  right: { kind: "Literal", value: 1, type: "int" }
                }
              }
            ],
            from: { kind: "TypeRef", name: "Category", alias: "c" },
            joins: [{
              kind: "Join",
              type: "inner",
              target: { kind: "TypeRef", name: "category_tree", alias: "ct" },
              on: {
                kind: "BinaryOp",
                op: "=",
                left: { kind: "Path", steps: ["c", "parent_id"] },
                right: { kind: "Path", steps: ["ct", "id"] }
              }
            }]
          }
        ]
      }
    }],
    selections: [{
      kind: "Selection",
      expression: { kind: "TypeRef", name: "category_tree" }
    }],
    from: { kind: "TypeRef", name: "category_tree" }
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    assertExists(sql.match(/WITH\s+RECURSIVE\s+category_tree/i));
    assertExists(sql.match(/UNION/i));
  }
});

Deno.test("ComplexQueryCompiler - optimizes complex aggregations", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    selections: [
      {
        kind: "Selection",
        expression: { kind: "Path", steps: ["category"] }
      },
      {
        kind: "Selection",
        alias: "total_views",
        expression: {
          kind: "Aggregate",
          function: "sum",
          expression: { kind: "Path", steps: ["views"] }
        }
      },
      {
        kind: "Selection",
        alias: "avg_rating",
        expression: {
          kind: "Aggregate",
          function: "avg",
          expression: { kind: "Path", steps: ["rating"] },
          filter: {
            kind: "BinaryOp",
            op: "IS NOT NULL",
            left: { kind: "Path", steps: ["rating"] },
            right: { kind: "Literal", value: null, type: "null" }
          }
        }
      }
    ],
    from: { kind: "TypeRef", name: "Post" },
    groupBy: [{ kind: "Path", steps: ["category"] }],
    having: {
      kind: "BinaryOp",
      op: ">",
      left: {
        kind: "Aggregate",
        function: "count",
        expression: { kind: "Literal", value: "*", type: "star" }
      },
      right: { kind: "Literal", value: 5, type: "int" }
    }
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    assertExists(sql.match(/SUM\(.*views.*\)/i));
    assertExists(sql.match(/AVG\(.*rating.*\)\s+FILTER/i));
    assertExists(sql.match(/GROUP\s+BY.*category/i));
    assertExists(sql.match(/HAVING\s+COUNT\(\*\)\s*>\s*5/i));
  }
});

Deno.test("ComplexQueryCompiler - handles complex joins", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const query: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    selections: [
      { kind: "Selection", expression: { kind: "Path", steps: ["u", "name"] } },
      { kind: "Selection", expression: { kind: "Path", steps: ["p", "title"] } },
      { kind: "Selection", expression: { kind: "Path", steps: ["c", "content"] } }
    ],
    from: { kind: "TypeRef", name: "User", alias: "u" },
    joins: [
      {
        kind: "Join",
        type: "left",
        target: { kind: "TypeRef", name: "Post", alias: "p" },
        on: {
          kind: "BinaryOp",
          op: "=",
          left: { kind: "Path", steps: ["u", "id"] },
          right: { kind: "Path", steps: ["p", "author_id"] }
        }
      },
      {
        kind: "Join",
        type: "left",
        target: { kind: "TypeRef", name: "Comment", alias: "c" },
        on: {
          kind: "LogicalOp",
          op: "AND",
          operands: [
            {
              kind: "BinaryOp",
              op: "=",
              left: { kind: "Path", steps: ["p", "id"] },
              right: { kind: "Path", steps: ["c", "post_id"] }
            },
            {
              kind: "BinaryOp",
              op: "=",
              left: { kind: "Path", steps: ["c", "is_approved"] },
              right: { kind: "Literal", value: true, type: "bool" }
            }
          ]
        }
      }
    ]
  };
  
  const result = compiler.compile(query);
  
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = result.value.toSQL();
    assertExists(sql.match(/FROM\s+users\s+u/i));
    assertExists(sql.match(/LEFT\s+JOIN\s+posts\s+p/i));
    assertExists(sql.match(/LEFT\s+JOIN\s+comments\s+c.*ON.*AND/i));
  }
});

Deno.test("ComplexQueryCompiler - analyzes query complexity", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  const simpleQuery: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    selections: [{ kind: "Selection", expression: { kind: "Path", steps: ["name"] } }],
    from: { kind: "TypeRef", name: "User" }
  };
  
  const complexQuery: EdgeQLAST.Query = {
    kind: "Query",
    type: "select",
    with: [
      { kind: "CTE", name: "cte1", query: simpleQuery },
      { kind: "CTE", name: "cte2", query: simpleQuery }
    ],
    selections: [
      { kind: "Selection", expression: { kind: "Path", steps: ["name"] } },
      {
        kind: "Selection",
        expression: {
          kind: "Subquery",
          query: simpleQuery
        }
      }
    ],
    from: { kind: "TypeRef", name: "User" },
    joins: [
      { kind: "Join", type: "left", target: { kind: "TypeRef", name: "Post" } },
      { kind: "Join", type: "inner", target: { kind: "TypeRef", name: "Comment" } }
    ]
  };
  
  const simpleComplexity = compiler.analyzeComplexity(simpleQuery);
  const complexComplexity = compiler.analyzeComplexity(complexQuery);
  
  assertEquals(simpleComplexity.score < 10, true);
  assertEquals(complexComplexity.score > 20, true);
  assertEquals(complexComplexity.cteCount, 2);
  assertEquals(complexComplexity.joinCount, 2);
  assertEquals(complexComplexity.subqueryCount, 1);
});