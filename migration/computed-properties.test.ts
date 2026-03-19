/**
 * Tests for computed properties DDL generation
 *
 * Computed properties are virtual — they are evaluated at query time
 * and should NOT produce database columns.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import * as Types from "./types.ts";
import { Module } from "../schema/converter.ts";

// ========================================
// DDL Generator Tests
// ========================================

Deno.test("DDL Generator - computed property skipped in CREATE TABLE", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        computed: ".first_name ++ ' ' ++ .last_name",
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTableSql = statements[0];

  // The CREATE TABLE should only have the id column, not the computed property
  assertStringIncludes(createTableSql, "id");
  assertEquals(createTableSql.includes("name"), false);
});

Deno.test("DDL Generator - non-computed property included in CREATE TABLE", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTableSql = statements[0];

  assertStringIncludes(createTableSql, "email");
  assertStringIncludes(createTableSql, "TEXT");
});

Deno.test("DDL Generator - mixed computed and regular properties", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "first_name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "last_name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "full_name",
        type: "str",
        required: true,
        multi: false,
        computed: ".first_name ++ ' ' ++ .last_name",
        constraints: [],
        annotations: {},
      },
      {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        constraints: ["exclusive"],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTableSql = statements[0];

  // Regular properties should be present
  assertStringIncludes(createTableSql, "first_name");
  assertStringIncludes(createTableSql, "last_name");
  assertStringIncludes(createTableSql, "email");

  // Computed property should NOT be present
  assertEquals(createTableSql.includes("full_name"), false);
});

Deno.test("DDL Generator - AddProperty with computed generates comment only", () => {
  const generator = new DDLGenerator();
  const alterOp: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "display_name",
          type: "str",
          required: false,
          multi: false,
          computed: ".first_name ++ ' ' ++ .last_name",
          constraints: [],
          annotations: {},
        },
      } as Types.AddPropertyOperation,
    ],
  };

  const statements = generator.generateDDL([alterOp]);

  // Should produce a comment, not an ALTER TABLE ADD COLUMN
  assertEquals(statements.length, 1);
  assertStringIncludes(statements[0], "-- Computed property");
  assertStringIncludes(statements[0], "display_name");
  assertStringIncludes(statements[0], "virtual");
  assertEquals(statements[0].includes("ALTER TABLE"), false);
});

Deno.test("DDL Generator - AddProperty without computed generates ALTER TABLE", () => {
  const generator = new DDLGenerator();
  const alterOp: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "bio",
          type: "str",
          required: false,
          multi: false,
          constraints: [],
          annotations: {},
        },
      } as Types.AddPropertyOperation,
    ],
  };

  const statements = generator.generateDDL([alterOp]);

  // Should produce ALTER TABLE ADD COLUMN
  assertStringIncludes(statements[0], "ALTER TABLE");
  assertStringIncludes(statements[0], "ADD COLUMN");
  assertStringIncludes(statements[0], "bio");
});

Deno.test("DDL Generator - rollback AddProperty with computed generates comment", () => {
  const generator = new DDLGenerator();
  const alterOp: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "display_name",
          type: "str",
          required: false,
          multi: false,
          computed: ".first_name ++ ' ' ++ .last_name",
          constraints: [],
          annotations: {},
        },
      } as Types.AddPropertyOperation,
    ],
  };

  const statements = generator.generateRollbackDDL([alterOp]);

  // Rolling back a computed property add should produce a comment, not DROP COLUMN
  assertEquals(statements.length, 1);
  assertStringIncludes(statements[0], "-- Computed property");
  assertStringIncludes(statements[0], "display_name");
  assertEquals(statements[0].includes("DROP COLUMN"), false);
});

// ========================================
// Schema Differ Tests
// ========================================

Deno.test("Schema Differ - extractProperties detects computed property from AST", () => {
  const differ = new SchemaDiffer();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "User" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "first_name" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: true,
              multi: false,
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "full_name" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: false,
              multi: false,
              computed: {
                kind: "FunctionCall",
                name: { kind: "QualifiedName", parts: ["str_concat"] },
                args: [
                  {
                    kind: "PathExpression",
                    path: [".first_name"],
                  },
                  {
                    kind: "Literal",
                    type: "string",
                    value: " ",
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ];

  // Diff against empty schema to trigger CreateType
  const operations = differ.diff([], schema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const createOp = operations[0] as Types.CreateTypeOperation;

  // first_name should not be computed
  const firstName = createOp.properties.find((p) => p.name === "first_name");
  assertEquals(firstName?.computed, undefined);

  // full_name should be computed
  const fullName = createOp.properties.find((p) => p.name === "full_name");
  assertEquals(typeof fullName?.computed, "string");
  assertStringIncludes(fullName!.computed!, "str_concat");
});

Deno.test("Schema Differ - computed property produces no DDL column in end-to-end flow", () => {
  const differ = new SchemaDiffer();
  const generator = new DDLGenerator();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Product" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "price" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["float64"] },
              },
              required: true,
              multi: false,
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "quantity" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["int32"] },
              },
              required: true,
              multi: false,
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "total" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["float64"] },
              },
              required: false,
              multi: false,
              computed: {
                kind: "BinaryOp",
                op: "*",
                left: {
                  kind: "PathExpression",
                  path: [".price"],
                },
                right: {
                  kind: "PathExpression",
                  path: [".quantity"],
                },
              },
            },
          ],
        },
      ],
    },
  ];

  const operations = differ.diff([], schema);
  const ddl = generator.generateDDL(operations);
  const createTableSql = ddl[0];

  // Stored properties should appear
  assertStringIncludes(createTableSql, "price");
  assertStringIncludes(createTableSql, "quantity");

  // Computed property should NOT appear
  assertEquals(createTableSql.includes("total"), false);
});
