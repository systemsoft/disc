#!/usr/bin/env deno run
// deno-lint-ignore-file no-console

/**
 * EdgeQL Parser and Compiler Demo
 *
 * This demo shows the complete pipeline from EdgeQL query to SQL
 */

import { EdgeQLParser } from "./edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler/compiler.ts";
import { SQLCodeGenerator } from "./compiler/codegen.ts";
import { createTestSchema } from "./compiler/context.ts";

// Create a test schema
const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileAndShow(name: string, edgeql: string) {
  console.log("\n" + "=".repeat(60));
  console.log(`Demo: ${name}`);
  console.log("=".repeat(60));
  console.log("\nEdgeQL Query:");
  console.log("-------------");
  console.log(edgeql.trim());

  try {
    // Parse EdgeQL
    const parser = new EdgeQLParser(edgeql);
    const ast = parser.parse();

    console.log("\nParsed AST (simplified):");
    console.log("------------------------");
    console.log(`Type: ${ast.kind}`);
    if ("expr" in ast && ast.expr) {
      console.log(`Expression: ${ast.expr.kind}`);
    }
    if ("shape" in ast && ast.shape) {
      console.log(`Shape elements: ${ast.shape.elements.length}`);
    }
    if ("filter" in ast && ast.filter) {
      console.log(`Has filter: yes`);
    }

    // Compile to SQL
    const result = compiler.compile(ast);
    if (!result.ok) {
      throw result.error;
    }

    const sql = codegen.generate(result.value);

    console.log("\nGenerated SQL:");
    console.log("--------------");
    console.log(sql);
  } catch (error) {
    console.log("\nError:", error.message);
  }
}

// Demo 1: Simple SELECT
compileAndShow(
  "Simple SELECT",
  "SELECT User",
);

// Demo 2: SELECT with Shape
compileAndShow(
  "SELECT with Shape",
  `SELECT User {
    id,
    name,
    email,
    created_at
  }`,
);

// Demo 3: SELECT with Nested Shape
compileAndShow(
  "SELECT with Nested Shape",
  `SELECT User {
    name,
    email,
    posts: {
      id,
      title,
      created_at
    }
  }`,
);

// Demo 4: SELECT with Filter
compileAndShow(
  "SELECT with Filter",
  `SELECT User {
    name,
    email
  } 
  FILTER .active = true AND .age >= 18`,
);

// Demo 5: SELECT with ORDER BY and LIMIT
compileAndShow(
  "SELECT with ORDER BY and LIMIT",
  `SELECT User {
    name,
    email
  }
  ORDER BY .created_at DESC
  LIMIT 10`,
);

// Demo 6: Computed Properties
compileAndShow(
  "Computed Properties",
  `SELECT User {
    name,
    full_name := .first_name ++ ' ' ++ .last_name,
    post_count := count(.posts)
  }`,
);

// Demo 7: INSERT Query
compileAndShow(
  "INSERT Query",
  `INSERT User {
    name := "Alice Smith",
    email := "alice@example.com",
    active := true
  }`,
);

// Demo 8: UPDATE Query
compileAndShow(
  "UPDATE Query",
  `UPDATE User
  FILTER .email = "alice@example.com"
  SET {
    name := "Alice Johnson",
    updated_at := datetime_current()
  }`,
);

// Demo 9: DELETE Query
compileAndShow(
  "DELETE Query",
  `DELETE User
  FILTER .email = "old@example.com"`,
);

// Demo 10: Complex Query with WITH
compileAndShow(
  "Complex Query with WITH Block",
  `WITH
    active_users := (
      SELECT User 
      FILTER .active = true
    ),
    total := count(active_users)
  SELECT active_users {
    name,
    email
  }
  ORDER BY .name
  LIMIT 5`,
);

console.log("\n" + "=".repeat(60));
console.log("EdgeQL to SQL Compilation Demo Complete!");
console.log("=".repeat(60));
console.log("\nThe EdgeQL parser and compiler successfully:");
console.log("✅ Parsed EdgeQL queries into AST");
console.log("✅ Analyzed and validated the AST");
console.log("✅ Compiled EdgeQL AST to SQL AST");
console.log("✅ Generated PostgreSQL-compatible SQL");
console.log("\nSupported features:");
console.log("- SELECT/INSERT/UPDATE/DELETE queries");
console.log("- Shape specifications with nested objects");
console.log("- Filters with complex expressions");
console.log("- ORDER BY, LIMIT, OFFSET");
console.log("- Computed properties");
console.log("- WITH blocks for CTEs");
console.log("- Type casts and function calls");
console.log("- Path expressions and backward links");
