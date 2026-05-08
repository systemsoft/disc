/**
 * Tests for Global Variable Compilation (Stage 36 Phase 3)
 *
 * Validates that GlobalRef expressions and SetGlobalQuery statements are
 * correctly compiled to SQL. Covers:
 * - Global ref compiles to current_setting() with cast
 * - Qualified global ref resolves correctly
 * - SET GLOBAL compiles to SET LOCAL
 * - SET on readonly global throws CompilationError
 * - Unknown global reference throws CompilationError
 * - Global ref used in a filter expression
 */

import { assertStringIncludes } from "@std/assert";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema, GlobalDef, Schema } from "./context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a test schema with additional globals merged into the base schema.
 */
function createSchemaWithGlobals(
  globals: Map<string, GlobalDef>
): Schema {
  const base = createTestSchema();
  const merged = new Map(base.globals);
  for (const [key, value] of globals) {
    merged.set(key, value);
  }
  return {
    ...base,
    globals: merged
  };
}

// ---------------------------------------------------------------------------
// Tests: Global ref compiles to current_setting with cast
// ---------------------------------------------------------------------------

Deno.test("Globals Compilation - global ref compiles to current_setting with cast", () => {
  const schema = createTestSchema();

  // The base test schema already includes default::current_user_id (uuid)
  // We need to use it as an expression, e.g. select <uuid>global current_user_id
  // But the parser turns `global current_user_id` into a GlobalRef node.
  // Let's compile it directly using the AST.

  // Use it inside a select so the compiler accepts it as a query
  const ast: import("../edgeql/ast.ts").SelectQuery = {
    kind: "SelectQuery",
    expr: {
      kind: "GlobalRef",
      name: "current_user_id"
    }
  };

  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate(result.value).toLowerCase();

  // Should contain current_setting call
  assertStringIncludes(sql, "current_setting");
  // Should reference the pg setting name
  assertStringIncludes(sql, "disc.global_default__current_user_id");
  // Should cast to uuid
  assertStringIncludes(sql, "uuid");
  // Should include true (missing_ok parameter)
  assertStringIncludes(sql, "true");
});

// ---------------------------------------------------------------------------
// Tests: Qualified global ref resolves correctly
// ---------------------------------------------------------------------------

Deno.test("Globals Compilation - qualified global ref resolves correctly", () => {
  const schema = createTestSchema();

  const ast: import("../edgeql/ast.ts").SelectQuery = {
    kind: "SelectQuery",
    expr: {
      kind: "GlobalRef",
      name: "current_user_id",
      module: "default"
    }
  };

  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate(result.value).toLowerCase();

  assertStringIncludes(sql, "current_setting");
  assertStringIncludes(sql, "disc.global_default__current_user_id");
  assertStringIncludes(sql, "uuid");
});

// ---------------------------------------------------------------------------
// Tests: SET GLOBAL compiles to SET LOCAL
// ---------------------------------------------------------------------------

Deno.test("Globals Compilation - SET GLOBAL compiles to SET LOCAL", () => {
  const schema = createTestSchema();

  const ast: import("../edgeql/ast.ts").SetGlobalQuery = {
    kind: "SetGlobalQuery",
    name: "current_user_id",
    value: {
      kind: "Literal",
      type: "string",
      value: "some-uuid-value"
    }
  };

  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate(result.value);

  // Should be a set_config() call
  assertStringIncludes(sql, "set_config");
  // Should reference the correct pg setting name
  assertStringIncludes(sql, "disc.global_default__current_user_id");
  // Should contain the value
  assertStringIncludes(sql, "some-uuid-value");
  // Should use true for local (transaction-scoped)
  assertStringIncludes(sql, "true");
});

// ---------------------------------------------------------------------------
// Tests: SET on readonly global throws CompilationError
// ---------------------------------------------------------------------------

Deno.test("Globals Compilation - SET on readonly global throws CompilationError", () => {
  const globals = new Map<string, GlobalDef>([
    ["default::app_version", {
      name: "app_version",
      module: "default",
      type: "str",
      pgType: "text",
      required: false,
      multi: false,
      readonly: true,
      pgSettingName: "disc.global_default__app_version"
    }]
  ]);
  const schema = createSchemaWithGlobals(globals);

  const ast: import("../edgeql/ast.ts").SetGlobalQuery = {
    kind: "SetGlobalQuery",
    name: "app_version",
    value: {
      kind: "Literal",
      type: "string",
      value: "2.0"
    }
  };

  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (result.ok) {
    throw new Error("Expected compilation to fail for readonly global");
  }
  assertStringIncludes(result.error.message, "readonly");
});

// ---------------------------------------------------------------------------
// Tests: Unknown global reference throws CompilationError
// ---------------------------------------------------------------------------

Deno.test("Globals Compilation - unknown global throws CompilationError", () => {
  const schema = createTestSchema();

  const ast: import("../edgeql/ast.ts").SelectQuery = {
    kind: "SelectQuery",
    expr: {
      kind: "GlobalRef",
      name: "nonexistent_global"
    }
  };

  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (result.ok) {
    throw new Error("Expected compilation to fail for unknown global");
  }
  assertStringIncludes(result.error.message, "Unknown global");
});

// ---------------------------------------------------------------------------
// Tests: Global ref used in a filter expression
// ---------------------------------------------------------------------------

Deno.test("Globals Compilation - global ref in filter expression", () => {
  const schema = createTestSchema();

  // SELECT User FILTER .id = global current_user_id
  const ast: import("../edgeql/ast.ts").SelectQuery = {
    kind: "SelectQuery",
    expr: {
      kind: "TypeName",
      name: { kind: "QualifiedName", parts: ["User"] }
    },
    filter: {
      kind: "BinaryOp",
      op: "=",
      left: {
        kind: "Path",
        steps: [{
          kind: "PathStep",
          type: "property",
          name: "id"
        }]
      },
      right: {
        kind: "GlobalRef",
        name: "current_user_id"
      }
    }
  };

  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate(result.value).toLowerCase();

  // Should contain the users table
  assertStringIncludes(sql, "users");
  // Should contain a WHERE clause
  assertStringIncludes(sql, "where");
  // Should contain current_setting for the global
  assertStringIncludes(sql, "current_setting");
  assertStringIncludes(sql, "disc.global_default__current_user_id");
  // Should cast to uuid
  assertStringIncludes(sql, "uuid");
});
