#!/usr/bin/env -S deno run --allow-read

/**
 * Demo: EdgeQL SELECT to SQL Compilation
 * 
 * This demonstrates the complete pipeline:
 * 1. Parse EdgeQL query
 * 2. Compile to SQL AST  
 * 3. Generate executable SQL
 */

import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import * as Context from "./context.ts";
import { AccessPolicy } from "../access/mod.ts";

// Create a sample schema
function createDemoSchema(): Context.Schema {
  const types = new Map<string, Context.TypeDef>();
  
  // User type
  types.set("User", {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id" }],
      ["name", { name: "name", type: "str", required: true, multi: false, columnName: "name" }],
      ["email", { name: "email", type: "str", required: true, multi: false, columnName: "email" }],
      ["created_at", { name: "created_at", type: "datetime", required: true, multi: false, columnName: "created_at" }],
    ]),
    links: new Map([
      ["posts", { name: "posts", target: "Post", required: false, multi: true, backlink: "author" }],
      ["friends", { name: "friends", target: "User", required: false, multi: true }],
    ]),
  });
  
  // Post type
  types.set("Post", {
    name: "Post",
    kind: "object",
    tableName: "posts",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id" }],
      ["title", { name: "title", type: "str", required: true, multi: false, columnName: "title" }],
      ["body", { name: "body", type: "str", required: true, multi: false, columnName: "body" }],
      ["published", { name: "published", type: "bool", required: false, multi: false, columnName: "published" }],
      ["created_at", { name: "created_at", type: "datetime", required: true, multi: false, columnName: "created_at" }],
    ]),
    links: new Map([
      ["author", { name: "author", target: "User", required: true, multi: false, columnName: "author_id", backlink: "posts" }],
    ]),
  });
  
  const functions = new Map<string, Context.FunctionDef>();
  
  // Standard functions
  functions.set("count", {
    name: "count",
    args: [{ name: "set", type: "any", optional: true }],
    returnType: "int64",
    sqlName: "count",
  });
  
  functions.set("str_lower", {
    name: "str_lower",
    args: [{ name: "string", type: "str", optional: false }],
    returnType: "str",
    sqlName: "lower",
  });
  
  return { types, functions };
}

function compileQuery(edgeql: string): void {
  console.log("═══════════════════════════════════════════════════════");
  console.log("EdgeQL Query:");
  console.log("─────────────");
  console.log(edgeql);
  console.log();
  
  try {
    // Step 1: Parse EdgeQL
    const parser = new EdgeQLParser(edgeql);
    const ast = parser.parse();
    console.log("✅ Parsed successfully");
    
    // Step 2: Compile to SQL AST
    const schema = createDemoSchema();
    const compiler = new EdgeQLCompiler(schema);
    const result = compiler.compile(ast);
    
    if (!result.ok) {
      console.error("❌ Compilation failed:", result.error.message);
      return;
    }
    console.log("✅ Compiled to SQL AST");
    
    // Step 3: Generate SQL
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    
    console.log("\nGenerated SQL:");
    console.log("──────────────");
    console.log(sql);
    console.log();
    
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
  }
}

// Demo various SELECT queries
console.log("╔═══════════════════════════════════════════════════════╗");
console.log("║         EdgeQL to SQL Compilation Demo                ║");
console.log("╚═══════════════════════════════════════════════════════╝\n");

console.log("\n═══ Section 1: Basic Queries (No Access Control) ═══\n");

// Example 1: Simple SELECT
compileQuery("SELECT User");

// Example 2: SELECT with shape
compileQuery(`
  SELECT User {
    name,
    email
  }
`);

// Example 3: SELECT with filter
compileQuery(`
  SELECT User 
  FILTER .name = "Alice"
`);

// Example 4: Complex query with filter, shape, and ordering
compileQuery(`
  SELECT User {
    name,
    email,
    created_at
  }
  FILTER .email LIKE "%@example.com"
  ORDER BY .created_at DESC
  LIMIT 10
`);

// Example 5: SELECT with nested shape (if supported)
compileQuery(`
  SELECT User {
    name,
    posts: {
      title,
      published
    }
  }
  FILTER .name = "Bob"
`);

// Example 6: SELECT with computed fields
compileQuery(`
  SELECT Post {
    title,
    author: {
      name
    },
    preview := str_lower(.body)[0:100]
  }
  FILTER .published = true
  ORDER BY .created_at DESC
`);

// Demo access control features
console.log("\n═══ Section 2: Queries with Access Control ═══\n");

function compileWithAccessControl(edgeql: string, description: string): void {
  console.log("═══════════════════════════════════════════════════════");
  console.log(description);
  console.log("─────────────");
  console.log("EdgeQL Query:");
  console.log(edgeql);
  console.log();
  
  try {
    // Parse EdgeQL
    const parser = new EdgeQLParser(edgeql);
    const ast = parser.parse();
    console.log("✅ Parsed successfully");
    
    // Create compiler with access control
    const schema = createDemoSchema();
    const compiler = new EdgeQLCompiler(schema, {
      accessContext: {
        userId: "user456",
        userRole: "viewer",
        sessionData: { tenant_id: 42 },
      }
    });
    
    // Register some access policies
    const publicPostsPolicy: AccessPolicy = {
      name: "public_posts",
      objectType: "Post",
      actions: [{ allow: true, operations: ["select"] }],
      using: {
        kind: "AccessComparison",
        operator: "=",
        left: { kind: "AccessPath", path: ["published"] },
        right: { kind: "AccessLiteral", value: true, type: "boolean" },
      } as any,
    };
    
    const ownUserPolicy: AccessPolicy = {
      name: "own_user_data",
      objectType: "User",
      actions: [{ allow: true, operations: ["select"] }],
      using: {
        kind: "AccessComparison",
        operator: "=",
        left: { kind: "AccessPath", path: ["id"] },
        right: { kind: "AccessGlobal", name: "current_user" },
      } as any,
    };
    
    compiler.registerAccessPolicy(publicPostsPolicy);
    compiler.registerAccessPolicy(ownUserPolicy);
    
    const result = compiler.compile(ast);
    
    if (!result.ok) {
      console.error("❌ Compilation failed:", result.error.message);
      return;
    }
    console.log("✅ Compiled to SQL AST with access control");
    
    // Generate SQL
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    
    console.log("\nGenerated SQL:");
    console.log("──────────────");
    console.log(sql);
    console.log();
    
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
  }
}

// Example 7: SELECT with access control - public posts only
compileWithAccessControl(
  "SELECT Post",
  "Example 7: SELECT with access control (public posts only)"
);

// Example 8: SELECT with access control - user can only see their own data
compileWithAccessControl(
  `SELECT User {
    name,
    email
  }`,
  "Example 8: SELECT with access control (own user data only)"
);

// Example 9: Admin context - no restrictions
console.log("\n═══ Section 3: Admin Access (No Restrictions) ═══\n");

function compileAsAdmin(edgeql: string): void {
  console.log("═══════════════════════════════════════════════════════");
  console.log("Admin Query (full access):");
  console.log("──────────────────────────");
  console.log(edgeql);
  console.log();
  
  try {
    const parser = new EdgeQLParser(edgeql);
    const ast = parser.parse();
    
    const schema = createDemoSchema();
    const compiler = new EdgeQLCompiler(schema, {
      accessContext: {
        userId: "admin123",
        userRole: "admin",
      }
    });
    
    // Admin bypass policy
    const adminPolicy: AccessPolicy = {
      name: "admin_bypass",
      actions: [{ allow: true, operations: ["all"] }],
      condition: {
        kind: "AccessComparison",
        operator: "=",
        left: { kind: "AccessGlobal", name: "current_role" },
        right: { kind: "AccessLiteral", value: "admin", type: "string" },
      } as any,
    };
    
    compiler.registerAccessPolicy(adminPolicy);
    
    const result = compiler.compile(ast);
    
    if (!result.ok) {
      console.error("❌ Compilation failed:", result.error.message);
      return;
    }
    
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    
    console.log("Generated SQL (admin has full access):");
    console.log("───────────────────────────────────────");
    console.log(sql);
    console.log();
    
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
  }
}

compileAsAdmin("SELECT User");

console.log("═══════════════════════════════════════════════════════");
console.log("Demo complete! EdgeQL with Access Control! 🔐🎉");
console.log("═══════════════════════════════════════════════════════");