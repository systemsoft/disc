/**
 * Tests that verify the compiler injects access control conditions when
 * policies are registered with the EdgeQLCompiler.
 */

import { assertEquals, assertExists } from "@std/assert";
import { EdgeQLCompiler, CompilerOptions } from "./compiler.ts";
import { createTestSchema, Schema, TypeDef } from "./context.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { AccessPolicy } from "../access/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clone the test schema and attach the given access policies to the "User"
 * type.  Returns a fresh Schema each time so tests don't share state.
 */
function createSchemaWithPolicies(policies: AccessPolicy[]): Schema {
  const base = createTestSchema();
  const userType = base.types.get("User")!;
  const updatedUser: TypeDef = { ...userType, accessPolicies: policies };
  base.types.set("User", updatedUser);
  return base;
}

/**
 * Parse an EdgeQL source string and compile it with the provided compiler.
 * Returns the generated SQL string on success, throws on compile error.
 */
function compileToSQL(compiler: EdgeQLCompiler, edgeql: string): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

// ---------------------------------------------------------------------------
// 1. No policies — no access control modifications
// ---------------------------------------------------------------------------

Deno.test("Access Compilation - no policies does not inject WHERE FALSE", () => {
  const schema = createSchemaWithPolicies([]);
  const options: CompilerOptions = {
    enableAccessControl: true,
    accessConfig: {
      mode: "permissive",
      defaultAllow: true,
      enableRLS: false,
      enableAudit: false,
    },
  };
  const compiler = new EdgeQLCompiler(schema, options);

  const sql = compileToSQL(compiler, "SELECT User { name, email }");

  assertExists(sql, "Expected SQL to be generated");
  assertEquals(
    sql.includes("WHERE FALSE"),
    false,
    "Expected no WHERE FALSE when no policies are registered and defaultAllow is true",
  );
  assertEquals(sql.includes("SELECT"), true, "Expected SELECT in generated SQL");
});

// ---------------------------------------------------------------------------
// 2. Deny policy for SELECT blocks query with WHERE FALSE
// ---------------------------------------------------------------------------

Deno.test("Access Compilation - deny SELECT policy injects WHERE FALSE", () => {
  const denyPolicy: AccessPolicy = {
    name: "deny_select",
    objectType: "User",
    actions: [{ allow: false, operations: ["select"] }],
  };

  const schema = createSchemaWithPolicies([]);
  const options: CompilerOptions = {
    enableAccessControl: true,
    accessConfig: {
      mode: "permissive",
      defaultAllow: true,
      enableRLS: false,
      enableAudit: false,
    },
  };
  const compiler = new EdgeQLCompiler(schema, options);
  compiler.registerAccessPolicy(denyPolicy);

  const parser = new EdgeQLParser("SELECT User { name, email }");
  const ast = parser.parse();
  const result = compiler.compile(ast);

  // With an explicit deny and no allow, the result is either an error
  // or a SQL statement containing WHERE FALSE.
  if (result.ok) {
    const codegen = new SQLCodeGenerator();
    const sql = codegen.generate(result.value);
    assertEquals(
      sql.includes("FALSE"),
      true,
      "Expected WHERE FALSE injected into SQL when SELECT is denied",
    );
  } else {
    // A CompilationError is also an acceptable response to a deny policy
    assertExists(result.error.message, "Expected error message when access is denied");
  }
});

// ---------------------------------------------------------------------------
// 3. Allow policy with using expression produces SQL conditions
// ---------------------------------------------------------------------------

Deno.test("Access Compilation - allow policy with using expression injects SQL condition", () => {
  const allowPolicy: AccessPolicy = {
    name: "owner_select",
    objectType: "User",
    actions: [{ allow: true, operations: ["select"] }],
    // A minimal using expression: AccessComparison comparing id = current_user
    using: {
      kind: "AccessComparison",
      operator: "=",
      left: { kind: "AccessPath", path: ["id"] },
      right: { kind: "AccessGlobal", name: "current_user" },
    },
  };

  const schema = createSchemaWithPolicies([]);
  const options: CompilerOptions = {
    enableAccessControl: true,
    accessConfig: {
      mode: "permissive",
      defaultAllow: false,
      enableRLS: true,
      enableAudit: false,
    },
    accessContext: {
      userId: "abc-123",
    },
  };
  const compiler = new EdgeQLCompiler(schema, options);
  compiler.registerAccessPolicy(allowPolicy);

  const sql = compileToSQL(compiler, "SELECT User { name, email }");

  assertExists(sql, "Expected SQL to be generated");
  assertEquals(
    sql.includes("SELECT"),
    true,
    "Expected SELECT in generated SQL",
  );
  // The evaluator should have injected the userId as a condition
  assertEquals(
    sql.includes("abc-123") || sql.includes("WHERE"),
    true,
    "Expected access condition or WHERE clause to appear in SQL",
  );
});

// ---------------------------------------------------------------------------
// 4. Deny INSERT policy causes compile error
// ---------------------------------------------------------------------------

Deno.test("Access Compilation - deny INSERT policy returns Err", () => {
  const denyInsertPolicy: AccessPolicy = {
    name: "deny_insert",
    objectType: "User",
    actions: [{ allow: false, operations: ["insert"] }],
  };

  const schema = createSchemaWithPolicies([]);
  const options: CompilerOptions = {
    enableAccessControl: true,
    accessConfig: {
      mode: "permissive",
      defaultAllow: true,
      enableRLS: false,
      enableAudit: false,
    },
  };
  const compiler = new EdgeQLCompiler(schema, options);
  compiler.registerAccessPolicy(denyInsertPolicy);

  const parser = new EdgeQLParser(`INSERT User { name := "test", email := "test@example.com" }`);
  const ast = parser.parse();
  const result = compiler.compile(ast);

  assertEquals(
    result.ok,
    false,
    "Expected compilation to fail when INSERT is denied by policy",
  );
  assertExists(result.ok === false && result.error, "Expected an error on denied INSERT");
});

// ---------------------------------------------------------------------------
// 5. Access context changes determine whether a query is allowed
// ---------------------------------------------------------------------------

Deno.test("Access Compilation - access context changes evaluation outcome", () => {
  // Use a policy whose condition checks `current_user` (the userId field).
  // When userId is absent the global evaluates to false and the policy
  // produces no allow decision; when userId is present the allow fires.
  const userPolicy: AccessPolicy = {
    name: "authenticated_only",
    objectType: "User",
    actions: [{ allow: true, operations: ["select"] }],
    condition: {
      // AccessGlobal "current_user" evaluates to Boolean(context.userId)
      kind: "AccessGlobal",
      name: "current_user",
    },
  };

  const schema = createSchemaWithPolicies([]);
  const options: CompilerOptions = {
    enableAccessControl: true,
    accessConfig: {
      mode: "permissive",
      defaultAllow: false,
      enableRLS: false,
      enableAudit: false,
    },
  };
  const compiler = new EdgeQLCompiler(schema, options);
  compiler.registerAccessPolicy(userPolicy);

  const parser = new EdgeQLParser("SELECT User { name, email }");
  const ast = parser.parse();

  // Without a userId: the condition evaluates to false, allow is not granted,
  // so the compiler should inject WHERE FALSE.
  compiler.setAccessContext({});
  const anonResult = compiler.compile(ast);
  if (anonResult.ok) {
    const codegen = new SQLCodeGenerator();
    const anonSQL = codegen.generate(anonResult.value);
    assertEquals(
      anonSQL.includes("FALSE"),
      true,
      "Expected WHERE FALSE for unauthenticated context when condition requires current_user",
    );
  } else {
    // A compilation error is also acceptable for denied access
    assertExists(anonResult.error.message, "Expected error for unauthenticated access");
  }

  // With a userId: the condition evaluates to true, allow fires.
  compiler.setAccessContext({ userId: "user-abc-123" });
  const authResult = compiler.compile(ast);
  assertEquals(
    authResult.ok,
    true,
    "Expected successful compilation when userId is set and condition uses current_user",
  );
  if (authResult.ok) {
    const codegen = new SQLCodeGenerator();
    const authSQL = codegen.generate(authResult.value);
    assertEquals(
      authSQL.includes("SELECT"),
      true,
      "Expected SELECT in authenticated SQL",
    );
  }
});
