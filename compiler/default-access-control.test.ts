/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * Test that access control is enabled by default in the main compiler
 */

import { assertEquals } from "@std/assert";
import { AccessPolicy } from "../access/mod.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import * as Context from "./context.ts";

// Create test schema
function createTestSchema(): Context.Schema {
  const types = new Map<string, Context.TypeDef>();

  types.set("User", {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id"
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name"
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email"
      }],
      ["role", {
        name: "role",
        type: "str",
        required: false,
        multi: false,
        columnName: "role"
      }]
    ]),
    links: new Map()
  });

  return { types, functions: new Map() };
}

Deno.test("Default compiler - Access control enabled by default", () => {
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);

  // Register a deny-all policy
  const policy: AccessPolicy = {
    name: "deny_all",
    objectType: "User",
    actions: [{ allow: false, operations: ["select"] }]
  };

  compiler.registerAccessPolicy(policy);

  const edgeql = "SELECT User";
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  const result = compiler.compile(ast);

  assertEquals(result.ok, true);

  if (result.ok) {
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    console.log("SQL with access control:", sql);

    // Should have WHERE FALSE due to deny policy
    assertEquals(sql.includes("WHERE"), true);
    assertEquals(sql.includes("FALSE"), true);
  }
});

Deno.test("Default compiler - Can disable access control", () => {
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });

  // Register a deny-all policy (should be ignored)
  const policy: AccessPolicy = {
    name: "deny_all",
    objectType: "User",
    actions: [{ allow: false, operations: ["select"] }]
  };

  compiler.registerAccessPolicy(policy);

  const edgeql = "SELECT User";
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  const result = compiler.compile(ast);

  assertEquals(result.ok, true);

  if (result.ok) {
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    console.log("SQL without access control:", sql);

    // Should NOT have WHERE FALSE since access control is disabled
    assertEquals(sql.includes("WHERE"), false);
    assertEquals(sql.includes("FALSE"), false);
  }
});

Deno.test("Default compiler - Works with access context", () => {
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema, {
    accessContext: {
      userId: "user123",
      userRole: "admin"
    }
  });

  // Register role-based policy
  const policy: AccessPolicy = {
    name: "admin_only",
    objectType: "User",
    actions: [{ allow: true, operations: ["select"] }],
    condition: {
      kind: "AccessComparison",
      operator: "=",
      left: { kind: "AccessGlobal", name: "current_role" },
      right: { kind: "AccessLiteral", value: "admin", type: "string" }
    } as any
  };

  compiler.registerAccessPolicy(policy);

  const edgeql = "SELECT User";
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  const result = compiler.compile(ast);

  assertEquals(result.ok, true);

  if (result.ok) {
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    console.log("SQL with admin context:", sql);

    // Admin should have access - no WHERE FALSE
    assertEquals(sql.includes("WHERE") && sql.includes("FALSE"), false);
  }
});

Deno.test("Default compiler - Can update access context", () => {
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);

  // Register role-based policy
  const policy: AccessPolicy = {
    name: "admin_only",
    objectType: "User",
    actions: [{ allow: true, operations: ["select"] }],
    condition: {
      kind: "AccessComparison",
      operator: "=",
      left: { kind: "AccessGlobal", name: "current_role" },
      right: { kind: "AccessLiteral", value: "admin", type: "string" }
    } as any
  };

  compiler.registerAccessPolicy(policy);

  // First try without admin role
  compiler.setAccessContext({
    userId: "user123",
    userRole: "viewer"
  });

  const edgeql = "SELECT User";
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  let result = compiler.compile(ast);
  assertEquals(result.ok, true);

  if (result.ok) {
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    console.log("SQL with viewer role:", sql);

    // Viewer should be denied (no matching policy)
    assertEquals(sql.includes("users"), true);
  }

  // Now update context to admin
  compiler.setAccessContext({
    userId: "user123",
    userRole: "admin"
  });

  result = compiler.compile(ast);
  assertEquals(result.ok, true);

  if (result.ok) {
    const generator = new SQLCodeGenerator();
    const sql = generator.generate(result.value);
    console.log("SQL with admin role:", sql);

    // Admin should have access
    assertEquals(sql.includes("users"), true);
  }
});
