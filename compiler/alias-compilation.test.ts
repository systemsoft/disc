/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Expression Alias Compilation (Stage 33 Phase 4)
 *
 * Validates that expression aliases defined in the schema are correctly
 * resolved and compiled to SQL. Covers:
 * - Basic alias resolution (query alias -> subquery)
 * - Alias with explicit shape
 * - Alias with additional filter
 * - Simple type alias (alias People := User)
 * - Alias without shape (implicit)
 * - Unknown name still throws CompilationError
 * - SchemaManager extraction of aliases from SDL
 * - resolveAlias with module scope
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { AliasDef, createTestSchema, resolveAlias, Schema } from "./context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a test schema with aliases added to the base createTestSchema().
 */
function createSchemaWithAliases(
  aliases: Map<string, AliasDef>
): Schema {
  const base = createTestSchema();
  return {
    ...base,
    aliases
  };
}

/**
 * Compile an EdgeQL query string against the given schema and return the
 * generated SQL (lowercased for easy assertion).
 */
function compileWithSchema(schema: Schema, edgeql: string): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value).toLowerCase();
}

// ---------------------------------------------------------------------------
// Tests: Basic alias resolution
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - basic alias resolves to subquery with WHERE", () => {
  const aliases = new Map<string, AliasDef>([
    ["ActiveUsers", {
      name: "ActiveUsers",
      expression: "select User filter .active = true",
      targetType: "User"
    }]
  ]);
  const schema = createSchemaWithAliases(aliases);

  const sql = compileWithSchema(schema, "select ActiveUsers");

  // The alias should produce a subquery referencing the users table
  assertStringIncludes(sql, "users");
  // The alias filter should be present in the subquery
  assertStringIncludes(sql, "where");
  assertStringIncludes(sql, "active");
  assertStringIncludes(sql, "true");
});

// ---------------------------------------------------------------------------
// Tests: Alias with explicit shape
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - alias with explicit shape selects named columns", () => {
  const aliases = new Map<string, AliasDef>([
    ["ActiveUsers", {
      name: "ActiveUsers",
      expression: "select User filter .active = true",
      targetType: "User"
    }]
  ]);
  const schema = createSchemaWithAliases(aliases);

  const sql = compileWithSchema(
    schema,
    "select ActiveUsers { name, email }"
  );

  // The shape columns should appear in the output
  assertStringIncludes(sql, "'name'");
  assertStringIncludes(sql, "'email'");
  assertStringIncludes(sql, "jsonb_build_object");
});

// ---------------------------------------------------------------------------
// Tests: Alias with additional filter
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - alias with additional filter combines both filters", () => {
  const aliases = new Map<string, AliasDef>([
    ["ActiveUsers", {
      name: "ActiveUsers",
      expression: "select User filter .active = true",
      targetType: "User"
    }]
  ]);
  const schema = createSchemaWithAliases(aliases);

  const sql = compileWithSchema(
    schema,
    "select ActiveUsers filter .name = \"Ada\""
  );

  // Both the alias filter (active = true) and the outer filter (name = Ada) should be present
  assertStringIncludes(sql, "active");
  assertStringIncludes(sql, "true");
  assertStringIncludes(sql, "where");
  assertStringIncludes(sql, "'ada'");
});

// ---------------------------------------------------------------------------
// Tests: Simple type alias
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - simple type alias resolves to underlying table", () => {
  const aliases = new Map<string, AliasDef>([
    ["People", {
      name: "People",
      expression: "User",
      targetType: "User"
    }]
  ]);
  const schema = createSchemaWithAliases(aliases);

  const sql = compileWithSchema(
    schema,
    "select People { name }"
  );

  // Should resolve to the users table
  assertStringIncludes(sql, "users");
  assertStringIncludes(sql, "'name'");
  assertStringIncludes(sql, "jsonb_build_object");
});

// ---------------------------------------------------------------------------
// Tests: Alias without shape (implicit)
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - alias without shape uses implicit shape", () => {
  const aliases = new Map<string, AliasDef>([
    ["ActiveUsers", {
      name: "ActiveUsers",
      expression: "select User filter .active = true",
      targetType: "User"
    }]
  ]);
  const schema = createSchemaWithAliases(aliases);

  const sql = compileWithSchema(schema, "select ActiveUsers");

  // Without a shape, the compiler should still produce valid SQL (either
  // implicit shape from the target type or SELECT *)
  assertStringIncludes(sql, "select");
  assertStringIncludes(sql, "users");
});

// ---------------------------------------------------------------------------
// Tests: Unknown name still throws
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - unknown name still throws CompilationError", () => {
  const aliases = new Map<string, AliasDef>();
  const schema = createSchemaWithAliases(aliases);

  assertThrows(
    () => compileWithSchema(schema, "select NonExistent"),
    CompilationError,
    "not found"
  );
});

// ---------------------------------------------------------------------------
// Tests: SchemaManager extracts aliases from SDL
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - SchemaManager extracts aliases from SDL", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
        required email: str;
        active: bool;
      }

      alias ActiveUsers := (
        select User filter .active = true
      );
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }

  const schema = manager.modulesToSchema(parseResult.value);

  // The schema should contain the alias
  assertEquals(schema.aliases !== undefined, true);
  assertEquals(schema.aliases!.has("ActiveUsers"), true);

  const alias = schema.aliases!.get("ActiveUsers")!;
  assertEquals(alias.name, "ActiveUsers");
  // The expression should contain the EdgeQL select tokens
  assertStringIncludes(alias.expression, "select");
  assertStringIncludes(alias.expression, "User");
  // Note: targetType detection from `select Type filter ...` style
  // PathExpressions is not yet supported (the first segment is "select",
  // not a capitalized type name). targetType is only detected for simple
  // path expressions like `alias People := User;`
  assertEquals(alias.targetType, undefined);
});

Deno.test("Alias Compilation - SchemaManager extracts simple type alias with targetType", () => {
  const sdl = `
    module default {
      type User {
        required name: str;
        required email: str;
      }

      alias People := User;
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }

  const schema = manager.modulesToSchema(parseResult.value);

  assertEquals(schema.aliases !== undefined, true);
  assertEquals(schema.aliases!.has("People"), true);

  const alias = schema.aliases!.get("People")!;
  assertEquals(alias.name, "People");
  // For a simple path expression starting with a capitalized name,
  // targetType should be detected
  assertEquals(alias.targetType, "User");
});

// ---------------------------------------------------------------------------
// Tests: resolveAlias with module scope
// ---------------------------------------------------------------------------

Deno.test("Alias Compilation - resolveAlias with module scope", () => {
  const aliases = new Map<string, AliasDef>([
    ["default::ActiveUsers", {
      name: "default::ActiveUsers",
      expression: "select User filter .active = true",
      targetType: "User"
    }],
    ["other::SpecialUsers", {
      name: "other::SpecialUsers",
      expression: "select User filter .name = 'special'",
      targetType: "User"
    }]
  ]);

  const schema: Schema = {
    ...createTestSchema(),
    aliases
  };

  // 1. Exact match works
  const exactMatch = resolveAlias(schema, "default::ActiveUsers");
  assertEquals(exactMatch?.name, "default::ActiveUsers");

  // 2. Unqualified name resolves via default module
  const defaultMatch = resolveAlias(schema, "ActiveUsers");
  assertEquals(defaultMatch?.name, "default::ActiveUsers");

  // 3. Unqualified name resolves via moduleScope
  const scopedMatch = resolveAlias(schema, "SpecialUsers", "other");
  assertEquals(scopedMatch?.name, "other::SpecialUsers");

  // 4. Unqualified name with wrong scope returns undefined (then falls back to default)
  const noMatch = resolveAlias(schema, "SpecialUsers");
  assertEquals(noMatch, undefined);
});
