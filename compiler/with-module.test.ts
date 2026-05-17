/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for WITH MODULE namespace scoping
 *
 * Validates that `WITH MODULE <name>` in EdgeQL queries sets module scope
 * for unqualified type resolution during compilation.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type * as AST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema, TypeDef } from "./context.ts";

// ---------------------------------------------------------------------------
// Test schema: types in multiple modules
// ---------------------------------------------------------------------------

function createModuleTestSchema(): Schema {
  // Type in "other" module
  const otherFoo: TypeDef = {
    name: "other::Foo",
    kind: "object",
    tableName: "other_foo",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  // Type in "default" module
  const defaultBar: TypeDef = {
    name: "default::Bar",
    kind: "object",
    tableName: "default_bar",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["label", {
        name: "label",
        type: "str",
        required: true,
        multi: false,
        columnName: "label",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  // Type at top level (unqualified) to ensure existing behavior works
  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([
      ["other::Foo", otherFoo],
      ["default::Bar", defaultBar],
      ["User", userType]
    ]),
    functions: getBuiltinFunctions()
  };
}

const schema = createModuleTestSchema();
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  return codegen.generate(result.value);
}

function parseEdgeQL(source: string): AST.Query {
  const parser = new EdgeQLParser(source);
  return parser.parse();
}

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

Deno.test("WITH MODULE - Parse WITH MODULE only", () => {
  const ast = parseEdgeQL("WITH MODULE other SELECT Foo");
  assertEquals(ast.kind, "WithBlock");
  const withBlock = ast as AST.WithBlock;
  assertEquals(withBlock.module, "other");
  assertEquals(withBlock.bindings.length, 0);
  assertEquals(withBlock.body.kind, "SelectQuery");
});

Deno.test("WITH MODULE - Parse WITH MODULE + bindings", () => {
  const ast = parseEdgeQL(
    "WITH MODULE other, x := (SELECT Bar) SELECT x"
  );
  assertEquals(ast.kind, "WithBlock");
  const withBlock = ast as AST.WithBlock;
  assertEquals(withBlock.module, "other");
  assertEquals(withBlock.bindings.length, 1);
  assertEquals(withBlock.bindings[0].name.name, "x");
  assertEquals(withBlock.body.kind, "SelectQuery");
});

// ---------------------------------------------------------------------------
// Compilation tests
// ---------------------------------------------------------------------------

Deno.test("WITH MODULE - Compile resolves type in module scope", () => {
  const sql = compileEdgeQL("WITH MODULE other SELECT Foo");
  assertStringIncludes(sql, "other_foo");
  assertStringIncludes(sql, "jsonb_build_object");
});

Deno.test("WITH MODULE - Explicit :: qualification unaffected", () => {
  // Even with MODULE other, an explicit default::Bar should resolve correctly
  const sql = compileEdgeQL("WITH MODULE other SELECT default::Bar");
  assertStringIncludes(sql, "default_bar");
  assertStringIncludes(sql, "jsonb_build_object");
});

Deno.test("WITH MODULE - Module scope does not leak to outer query", () => {
  // Ensure that after the WITH MODULE block, module scope is restored.
  // We test this by compiling two queries sequentially with the same compiler.
  const compiler = new EdgeQLCompiler(schema);

  // First compile a WITH MODULE query
  const parser1 = new EdgeQLParser("WITH MODULE other SELECT Foo");
  const ast1 = parser1.parse();
  const result1 = compiler.compile(ast1);
  assertEquals(result1.ok, true);

  // Then compile a plain query — User should still resolve from top-level
  const parser2 = new EdgeQLParser("SELECT User");
  const ast2 = parser2.parse();
  const result2 = compiler.compile(ast2);
  assertEquals(result2.ok, true);
  if (!result2.ok) {
    throw result2.error;
  }
  const sql2 = codegen.generate(result2.value);
  assertStringIncludes(sql2, "users");
});

Deno.test("WITH MODULE - Unknown module type produces error", () => {
  assertThrows(
    () => {
      compileEdgeQL("WITH MODULE nonexistent SELECT Foo");
    },
    CompilationError,
    "not found"
  );
});

Deno.test("WITH MODULE - Module scope with FILTER", () => {
  const sql = compileEdgeQL(
    `WITH MODULE other SELECT Foo FILTER .name = 'test'`
  );
  assertStringIncludes(sql, "other_foo");
  assertStringIncludes(sql, "WHERE");
  assertStringIncludes(sql, "'test'");
});

Deno.test("WITH MODULE - Default module still works without WITH MODULE", () => {
  // Without WITH MODULE, unqualified "User" should resolve from top level
  const sql = compileEdgeQL("SELECT User");
  assertStringIncludes(sql, "users");
  assertStringIncludes(sql, "jsonb_build_object");
});
