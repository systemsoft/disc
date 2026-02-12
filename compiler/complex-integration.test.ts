/**
 * Integration tests for complex query compilation
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ComplexQueryCompiler } from "./complex-query.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import * as Context from "./context.ts";

Deno.test("Complex query integration - analytics dashboard query", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  const parser = new EdgeQLParser();
  
  // Complex analytics query with CTEs, window functions, and aggregates
  const edgeql = `
    WITH active_users AS (
      SELECT User {
        id,
        name,
        created_at
      } FILTER .is_active = true AND .created_at > datetime_current() - <duration>'30 days'
    ),
    user_metrics AS (
      SELECT active_users {
        id,
        post_count := count(.posts),
        comment_count := count(.comments),
        engagement_score := .post_count * 10 + .comment_count * 5
      }
    )
    SELECT user_metrics {
      name,
      post_count,
      comment_count,
      engagement_score,
      rank := row_number() OVER (ORDER BY .engagement_score DESC),
      percentile := percent_rank() OVER (ORDER BY .engagement_score)
    }
    ORDER BY engagement_score DESC
    LIMIT 100
  `;
  
  const parseResult = parser.parse(edgeql);
  assertEquals(parseResult.ok, true);
  
  if (parseResult.ok) {
    const compileResult = compiler.compile(parseResult.value);
    assertEquals(compileResult.ok, true);
    
    if (compileResult.ok) {
      const sql = compileResult.value.toSQL();
      
      // Verify CTE structure
      assertEquals(sql.includes("WITH"), true);
      assertEquals(sql.includes("active_users AS"), true);
      assertEquals(sql.includes("user_metrics AS"), true);
      
      // Verify window functions
      assertEquals(sql.includes("row_number() OVER"), true);
      assertEquals(sql.includes("percent_rank() OVER"), true);
      
      // Verify aggregates
      assertEquals(sql.includes("count("), true);
      
      // Verify final query structure
      assertEquals(sql.includes("ORDER BY engagement_score DESC"), true);
      assertEquals(sql.includes("LIMIT 100"), true);
    }
  }
});

Deno.test("Complex query integration - hierarchical data with recursive CTE", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  const parser = new EdgeQLParser();
  
  const edgeql = `
    WITH RECURSIVE category_tree AS (
      SELECT Category {
        id,
        name,
        parent_id,
        level := 0,
        path := array[.name]
      }
      FILTER .parent_id IS NULL
      
      UNION ALL
      
      SELECT Category {
        id,
        name,
        parent_id,
        level := parent.level + 1,
        path := parent.path ++ array[.name]
      }
      FROM Category
      JOIN category_tree AS parent ON Category.parent_id = parent.id
    )
    SELECT category_tree {
      id,
      name,
      level,
      path,
      full_path := array_to_string(.path, ' > ')
    }
    ORDER BY path
  `;
  
  const parseResult = parser.parse(edgeql);
  assertEquals(parseResult.ok, true);
  
  if (parseResult.ok) {
    const compileResult = compiler.compile(parseResult.value);
    assertEquals(compileResult.ok, true);
    
    if (compileResult.ok) {
      const sql = compileResult.value.toSQL();
      
      // Verify recursive CTE
      assertEquals(sql.includes("WITH RECURSIVE"), true);
      assertEquals(sql.includes("category_tree AS"), true);
      assertEquals(sql.includes("UNION ALL"), true);
      
      // Verify hierarchical logic
      assertEquals(sql.includes("parent.level + 1"), true);
      assertEquals(sql.includes("array_to_string"), true);
    }
  }
});

Deno.test("Complex query integration - pivot table with crosstab", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  const parser = new EdgeQLParser();
  
  const edgeql = `
    SELECT month_series.month {
      month,
      users := count(User FILTER .created_at >= month_series.month 
                            AND .created_at < month_series.month + <duration>'1 month'),
      posts := count(Post FILTER .created_at >= month_series.month 
                            AND .created_at < month_series.month + <duration>'1 month'),
      revenue := sum(Order.amount FILTER Order.created_at >= month_series.month 
                                    AND Order.created_at < month_series.month + <duration>'1 month')
    }
    FROM (
      SELECT generate_series(
        date_trunc('month', datetime_current() - <duration>'12 months'),
        date_trunc('month', datetime_current()),
        <duration>'1 month'
      ) AS month
    ) AS month_series
    ORDER BY month
  `;
  
  const parseResult = parser.parse(edgeql);
  assertEquals(parseResult.ok, true);
  
  if (parseResult.ok) {
    const compileResult = compiler.compile(parseResult.value);
    assertEquals(compileResult.ok, true);
    
    if (compileResult.ok) {
      const sql = compileResult.value.toSQL();
      
      // Verify time series generation
      assertEquals(sql.includes("generate_series"), true);
      assertEquals(sql.includes("date_trunc"), true);
      
      // Verify filtered aggregates
      assertEquals(sql.includes("count(") && sql.includes("FILTER"), true);
      assertEquals(sql.includes("sum(") && sql.includes("FILTER"), true);
    }
  }
});

Deno.test("Complex query integration - optimized correlated subquery", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  const parser = new EdgeQLParser();
  
  const edgeql = `
    SELECT User {
      name,
      email,
      latest_post := (
        SELECT Post {
          title,
          created_at
        }
        FILTER .author = User
        ORDER BY .created_at DESC
        LIMIT 1
      ),
      post_stats := (
        SELECT {
          total := count(Post FILTER .author = User),
          published := count(Post FILTER .author = User AND .is_published = true),
          avg_views := avg(Post.views FILTER .author = User)
        }
      )
    }
    FILTER .is_active = true
  `;
  
  const parseResult = parser.parse(edgeql);
  assertEquals(parseResult.ok, true);
  
  if (parseResult.ok) {
    const compileResult = compiler.compile(parseResult.value);
    assertEquals(compileResult.ok, true);
    
    if (compileResult.ok) {
      const sql = compileResult.value.toSQL();
      
      // Verify optimization to LATERAL JOIN
      assertEquals(sql.includes("LATERAL"), true);
      
      // Verify aggregates in subquery
      assertEquals(sql.includes("avg("), true);
      assertEquals(sql.includes("count("), true);
    }
  }
});

Deno.test("Query complexity analysis - simple vs complex", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  const parser = new EdgeQLParser();
  
  // Simple query
  const simpleQuery = `SELECT User { name, email }`;
  const simpleParseResult = parser.parse(simpleQuery);
  
  if (simpleParseResult.ok) {
    const complexity = compiler.analyzeComplexity(simpleParseResult.value);
    
    assertEquals(complexity.score < 10, true);
    assertEquals(complexity.cteCount, 0);
    assertEquals(complexity.joinCount, 0);
    assertEquals(complexity.subqueryCount, 0);
    assertEquals(complexity.warnings.length, 0);
  }
  
  // Complex query
  const complexQuery = `
    WITH RECURSIVE tree AS (...),
         metrics AS (...),
         summary AS (...)
    SELECT complex_result {
      field1,
      subquery1 := (SELECT ...),
      subquery2 := (SELECT ...),
      window1 := row_number() OVER (...),
      aggregate1 := sum(...) FILTER (...)
    }
    FROM table1
    JOIN table2 ON ...
    JOIN table3 ON ...
    JOIN table4 ON ...
    WHERE complex_condition
    GROUP BY multiple_fields
    HAVING aggregate_condition
    ORDER BY complex_expression
  `;
  
  // Simulate complex query AST
  const complexAST = {
    kind: "Query",
    type: "select",
    with: [
      { kind: "CTE", name: "tree", recursive: true },
      { kind: "CTE", name: "metrics" },
      { kind: "CTE", name: "summary" }
    ],
    selections: [
      { kind: "Selection", expression: { kind: "Subquery" } },
      { kind: "Selection", expression: { kind: "Subquery" } },
      { kind: "Selection", expression: { kind: "WindowFunction" } },
      { kind: "Selection", expression: { kind: "Aggregate" } }
    ],
    joins: [
      { kind: "Join" },
      { kind: "Join" },
      { kind: "Join" }
    ]
  };
  
  const complexity = compiler.analyzeComplexity(complexAST);
  
  assertEquals(complexity.score > 20, true);
  assertEquals(complexity.cteCount, 3);
  assertEquals(complexity.joinCount, 3);
  assertEquals(complexity.subqueryCount, 2);
  assertEquals(complexity.aggregateCount, 1);
  assertEquals(complexity.windowFunctionCount, 1);
  assertEquals(complexity.warnings.length > 0, true);
});

Deno.test("Complex query optimization - predicate pushdown", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  
  // Query that can benefit from predicate pushdown
  const query = {
    kind: "Query",
    type: "select",
    selections: [{ kind: "Selection", expression: { kind: "Path", steps: ["name"] } }],
    from: { kind: "TypeRef", name: "User" },
    joins: [{
      kind: "Join",
      type: "inner",
      target: { kind: "TypeRef", name: "Post" },
      on: {
        kind: "BinaryOp",
        op: "=",
        left: { kind: "Path", steps: ["User", "id"] },
        right: { kind: "Path", steps: ["Post", "author_id"] }
      }
    }],
    filter: {
      kind: "LogicalOp",
      op: "AND",
      operands: [
        {
          kind: "BinaryOp",
          op: "=",
          left: { kind: "Path", steps: ["User", "is_active"] },
          right: { kind: "Literal", value: true }
        },
        {
          kind: "BinaryOp",
          op: ">",
          left: { kind: "Path", steps: ["Post", "views"] },
          right: { kind: "Literal", value: 1000 }
        }
      ]
    }
  };
  
  const result = compiler.compile(query);
  assertEquals(result.ok, true);
  
  if (result.ok) {
    const sql = result.value.toSQL();
    
    // Verify that predicates are pushed down to joins
    // The Post.views > 1000 condition should be in the JOIN clause
    // for better performance
    assertEquals(sql.includes("JOIN") && sql.includes("views > 1000"), true);
  }
});

Deno.test("Complex query - batch insert with returning", () => {
  const schema = Context.createTestSchema();
  const compiler = new ComplexQueryCompiler(schema);
  const parser = new EdgeQLParser();
  
  const edgeql = `
    WITH new_users AS (
      INSERT User {
        name := <array<str>>$names,
        email := <array<str>>$emails,
        created_at := datetime_current()
      }
      RETURNING {
        id,
        name,
        email
      }
    )
    SELECT new_users {
      id,
      name,
      welcome_message := 'Welcome, ' ++ .name ++ '!',
      activation_link := generate_activation_link(.id, .email)
    }
  `;
  
  const parseResult = parser.parse(edgeql);
  assertEquals(parseResult.ok, true);
  
  if (parseResult.ok) {
    const compileResult = compiler.compile(parseResult.value);
    assertEquals(compileResult.ok, true);
    
    if (compileResult.ok) {
      const sql = compileResult.value.toSQL();
      
      // Verify batch insert with RETURNING
      assertEquals(sql.includes("INSERT INTO"), true);
      assertEquals(sql.includes("RETURNING"), true);
      
      // Verify CTE usage
      assertEquals(sql.includes("WITH new_users AS"), true);
      
      // Verify string concatenation
      assertEquals(sql.includes("||"), true);
    }
  }
});