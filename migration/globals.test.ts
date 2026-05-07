/**
 * Tests for Global Migration Operations (Stage 36 Phase 5)
 *
 * Verifies that SDL global declarations are correctly diffed and generate
 * the expected migration operations and DDL. Covers:
 * - Differ detects new, removed, and changed globals
 * - DDL generates no-op comments for CreateGlobal / DropGlobal
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as AST from "../schema/ast.ts";
import { Module } from "../schema/converter.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import * as Types from "./types.ts";

// ============================================================
// Helpers
// ============================================================

/** Generate DDL from migration operations */
function generateDDL(operations: Types.MigrationOperation[]): string[] {
  const generator = new DDLGenerator();
  return generator.generateDDL(operations);
}

/**
 * Build a Module[] with global declarations constructed from AST nodes.
 */
function makeModuleWithGlobals(
  globals: {
    name: string;
    type: string;
    required?: boolean;
    multi?: boolean;
    readonly?: boolean;
    default?: AST.Expression;
  }[],
): Module[] {
  return [{
    name: "default",
    items: globals.map((g) => ({
      kind: "GlobalDeclaration" as const,
      name: { kind: "Identifier" as const, value: g.name },
      type: {
        kind: "TypeRef" as const,
        name: { kind: "QualifiedName" as const, parts: [g.type] },
      },
      required: g.required,
      multi: g.multi,
      readonly: g.readonly,
      default: g.default,
    })),
  }];
}

// ============================================================
// Differ Tests
// ============================================================

Deno.test("Differ - detects new global (CreateGlobal)", () => {
  const differ = new SchemaDiffer();
  const oldModules: Module[] = [{ name: "default", items: [] }];
  const newModules = makeModuleWithGlobals([
    { name: "current_user_id", type: "uuid" },
  ]);

  const operations = differ.diff(oldModules, newModules);

  const globalOps = operations.filter((op) => op.kind === "CreateGlobal");
  assertEquals(globalOps.length, 1);

  const createGlobal = globalOps[0] as Types.CreateGlobalOperation;
  assertEquals(createGlobal.name, "current_user_id");
  assertEquals(createGlobal.module, "default");
  assertEquals(createGlobal.type, "uuid");
  assertEquals(createGlobal.pgType, "uuid");
  assertEquals(createGlobal.required, false);
  assertEquals(createGlobal.multi, false);
  assertEquals(createGlobal.readonly, false);
});

Deno.test("Differ - detects removed global (DropGlobal)", () => {
  const differ = new SchemaDiffer();
  const oldModules = makeModuleWithGlobals([
    { name: "current_user_id", type: "uuid" },
  ]);
  const newModules: Module[] = [{ name: "default", items: [] }];

  const operations = differ.diff(oldModules, newModules);

  const globalOps = operations.filter((op) => op.kind === "DropGlobal");
  assertEquals(globalOps.length, 1);

  const dropGlobal = globalOps[0] as Types.DropGlobalOperation;
  assertEquals(dropGlobal.name, "current_user_id");
  assertEquals(dropGlobal.module, "default");
});

Deno.test("Differ - detects changed global type (DropGlobal + CreateGlobal)", () => {
  const differ = new SchemaDiffer();
  const oldModules = makeModuleWithGlobals([
    { name: "current_user_id", type: "uuid" },
  ]);
  const newModules = makeModuleWithGlobals([
    { name: "current_user_id", type: "str" },
  ]);

  const operations = differ.diff(oldModules, newModules);

  const dropOps = operations.filter((op) => op.kind === "DropGlobal");
  const createOps = operations.filter((op) => op.kind === "CreateGlobal");

  assertEquals(dropOps.length, 1);
  assertEquals(createOps.length, 1);

  assertEquals(
    (dropOps[0] as Types.DropGlobalOperation).name,
    "current_user_id",
  );

  const createGlobal = createOps[0] as Types.CreateGlobalOperation;
  assertEquals(createGlobal.name, "current_user_id");
  assertEquals(createGlobal.type, "str");
  assertEquals(createGlobal.pgType, "text");
});

// ============================================================
// DDL Tests
// ============================================================

Deno.test("DDL - CreateGlobal and DropGlobal generate no-op comments", () => {
  const createOp: Types.CreateGlobalOperation = {
    kind: "CreateGlobal",
    name: "current_user_id",
    module: "default",
    type: "uuid",
    pgType: "uuid",
    required: false,
    multi: false,
    readonly: false,
  };

  const dropOp: Types.DropGlobalOperation = {
    kind: "DropGlobal",
    name: "current_user_id",
    module: "default",
  };

  const createStatements = generateDDL([createOp]);
  assertEquals(createStatements.length, 1);
  assertStringIncludes(createStatements[0], "--");
  assertStringIncludes(createStatements[0], "default::current_user_id");
  assertStringIncludes(createStatements[0], "compile-time only");

  const dropStatements = generateDDL([dropOp]);
  assertEquals(dropStatements.length, 1);
  assertStringIncludes(dropStatements[0], "--");
  assertStringIncludes(dropStatements[0], "default::current_user_id");
  assertStringIncludes(dropStatements[0], "compile-time only");
});
