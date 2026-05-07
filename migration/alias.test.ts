/**
 * Tests for Alias Migration Operations (Stage 33 Phase 4)
 *
 * Verifies that SDL alias declarations are correctly diffed and generate
 * the expected migration operations and DDL. Covers:
 * - Differ detects new, removed, and modified aliases
 * - Differ detects no change when aliases are identical
 * - DDL generates no-op comments for CreateAlias / DropAlias
 * - Rollback generates no-op comments
 * - End-to-end: SDL parse -> differ -> operations
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import * as Types from "./types.ts";

// ============================================================
// Helpers
// ============================================================

/** Parse an SDL string and return the document AST */
function parseSDL(source: string) {
  const parser = new SDLParser(source);
  return parser.parse();
}

/** Parse SDL and convert to Module[] for the differ */
function parseToModules(source: string): Module[] {
  const doc = parseSDL(source);
  const validator = new SchemaValidator();
  return validator.convertToModules(doc);
}

/** Generate DDL from migration operations */
function generateDDL(operations: Types.MigrationOperation[]): string[] {
  const generator = new DDLGenerator();
  return generator.generateDDL(operations);
}

/** Generate rollback DDL from migration operations */
function generateRollbackDDL(
  operations: Types.MigrationOperation[],
): string[] {
  const generator = new DDLGenerator();
  return generator.generateRollbackDDL(operations);
}

/**
 * Build a Module[] with an alias declaration constructed from AST nodes.
 * This avoids depending on the SDL parser for edge cases.
 */
function makeModuleWithAlias(
  aliases: { name: string; expression: string[]; }[],
): Module[] {
  return [{
    name: "default",
    items: aliases.map((a) => ({
      kind: "AliasDeclaration" as const,
      name: { kind: "Identifier" as const, value: a.name },
      using: {
        kind: "PathExpression" as const,
        path: a.expression,
      },
    })),
  }];
}

// ============================================================
// Differ Tests
// ============================================================

Deno.test("Differ - detects new alias (CreateAlias)", () => {
  const differ = new SchemaDiffer();
  const oldModules: Module[] = [{ name: "default", items: [] }];
  const newModules = makeModuleWithAlias([{
    name: "ActiveUsers",
    expression: ["select", "User", "filter", ".active", "=", "true"],
  }]);

  const operations = differ.diff(oldModules, newModules);

  const aliasOps = operations.filter((op) => op.kind === "CreateAlias");
  assertEquals(aliasOps.length, 1);

  const createAlias = aliasOps[0] as Types.CreateAliasOperation;
  assertEquals(createAlias.aliasName, "ActiveUsers");
  assertStringIncludes(createAlias.expression, "select");
  assertStringIncludes(createAlias.expression, "User");
});

Deno.test("Differ - detects removed alias (DropAlias)", () => {
  const differ = new SchemaDiffer();
  const oldModules = makeModuleWithAlias([{
    name: "ActiveUsers",
    expression: ["select", "User", "filter", ".active", "=", "true"],
  }]);
  const newModules: Module[] = [{ name: "default", items: [] }];

  const operations = differ.diff(oldModules, newModules);

  const aliasOps = operations.filter((op) => op.kind === "DropAlias");
  assertEquals(aliasOps.length, 1);

  const dropAlias = aliasOps[0] as Types.DropAliasOperation;
  assertEquals(dropAlias.aliasName, "ActiveUsers");
});

Deno.test("Differ - detects modified alias (DropAlias + CreateAlias)", () => {
  const differ = new SchemaDiffer();
  const oldModules = makeModuleWithAlias([{
    name: "ActiveUsers",
    expression: ["select", "User", "filter", ".active", "=", "true"],
  }]);
  const newModules = makeModuleWithAlias([{
    name: "ActiveUsers",
    expression: [
      "select",
      "User",
      "filter",
      ".active",
      "=",
      "true",
      "and",
      ".name",
      "!=",
      "'banned'",
    ],
  }]);

  const operations = differ.diff(oldModules, newModules);

  const dropOps = operations.filter((op) => op.kind === "DropAlias");
  const createOps = operations.filter((op) => op.kind === "CreateAlias");

  assertEquals(dropOps.length, 1);
  assertEquals(createOps.length, 1);
  assertEquals(
    (dropOps[0] as Types.DropAliasOperation).aliasName,
    "ActiveUsers",
  );
  assertEquals(
    (createOps[0] as Types.CreateAliasOperation).aliasName,
    "ActiveUsers",
  );
});

Deno.test("Differ - no change when alias is identical", () => {
  const differ = new SchemaDiffer();
  const modules = makeModuleWithAlias([{
    name: "ActiveUsers",
    expression: ["select", "User", "filter", ".active", "=", "true"],
  }]);

  const operations = differ.diff(modules, modules);

  const aliasOps = operations.filter(
    (op) => op.kind === "CreateAlias" || op.kind === "DropAlias",
  );
  assertEquals(aliasOps.length, 0);
});

// ============================================================
// DDL Tests
// ============================================================

Deno.test("DDL - CreateAlias generates no-op comment", () => {
  const operation: Types.CreateAliasOperation = {
    kind: "CreateAlias",
    aliasName: "ActiveUsers",
    expression: "select User filter .active = true",
  };

  const statements = generateDDL([operation]);

  assertEquals(statements.length, 1);
  assertStringIncludes(statements[0], "ActiveUsers");
  assertStringIncludes(statements[0], "compile-time");
  // Should be a comment (starts with --)
  assertStringIncludes(statements[0], "--");
});

Deno.test("DDL - DropAlias generates no-op comment", () => {
  const operation: Types.DropAliasOperation = {
    kind: "DropAlias",
    aliasName: "ActiveUsers",
  };

  const statements = generateDDL([operation]);

  assertEquals(statements.length, 1);
  assertStringIncludes(statements[0], "ActiveUsers");
  assertStringIncludes(statements[0], "compile-time");
  assertStringIncludes(statements[0], "--");
});

Deno.test("DDL - Rollback generates no-op comment for alias operations", () => {
  const createOp: Types.CreateAliasOperation = {
    kind: "CreateAlias",
    aliasName: "ActiveUsers",
    expression: "select User filter .active = true",
  };

  const dropOp: Types.DropAliasOperation = {
    kind: "DropAlias",
    aliasName: "OldAlias",
  };

  const createRollback = generateRollbackDDL([createOp]);
  const dropRollback = generateRollbackDDL([dropOp]);

  assertEquals(createRollback.length, 1);
  assertStringIncludes(createRollback[0], "ActiveUsers");
  assertStringIncludes(createRollback[0], "--");

  assertEquals(dropRollback.length, 1);
  assertStringIncludes(dropRollback[0], "OldAlias");
  assertStringIncludes(dropRollback[0], "--");
});

// ============================================================
// End-to-end: SDL parse -> differ -> operations
// ============================================================

Deno.test("End-to-end - SDL with alias produces CreateAlias operation via parser", () => {
  const modules = parseToModules(`
    module default {
      type User {
        required name: str;
        active: bool;
      }

      alias ActiveUsers := (
        select User filter .active = true
      );
    }
  `);

  const differ = new SchemaDiffer();
  const operations = differ.diff([], modules);

  // Should have CreateType for User and CreateAlias for ActiveUsers
  const createTypeOps = operations.filter((op) => op.kind === "CreateType");
  const createAliasOps = operations.filter((op) => op.kind === "CreateAlias");

  assertEquals(createTypeOps.length, 1);
  assertEquals(
    (createTypeOps[0] as Types.CreateTypeOperation).typeName,
    "User",
  );

  assertEquals(createAliasOps.length, 1);
  const aliasOp = createAliasOps[0] as Types.CreateAliasOperation;
  assertEquals(aliasOp.aliasName, "ActiveUsers");
  assertStringIncludes(aliasOp.expression, "select");
  assertStringIncludes(aliasOp.expression, "User");

  // DDL for the alias should be a no-op comment
  const ddl = generateDDL(createAliasOps);
  assertEquals(ddl.length, 1);
  assertStringIncludes(ddl[0], "--");
  assertStringIncludes(ddl[0], "ActiveUsers");
});
