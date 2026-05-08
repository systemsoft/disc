/**
 * Tests for computed properties DDL generation
 *
 * Computed properties are virtual — they are evaluated at query time
 * and should NOT produce database columns.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Module } from "../schema/converter.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import * as Types from "./types.ts";

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
        annotations: {}
      }
    ],
    links: []
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
        annotations: {}
      }
    ],
    links: []
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
        annotations: {}
      },
      {
        name: "last_name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {}
      },
      {
        name: "full_name",
        type: "str",
        required: true,
        multi: false,
        computed: ".first_name ++ ' ' ++ .last_name",
        constraints: [],
        annotations: {}
      },
      {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        constraints: ["exclusive"],
        annotations: {}
      }
    ],
    links: []
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
          annotations: {}
        }
      } as Types.AddPropertyOperation
    ]
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
          annotations: {}
        }
      } as Types.AddPropertyOperation
    ]
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
          annotations: {}
        }
      } as Types.AddPropertyOperation
    ]
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
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "full_name" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: false,
              multi: false,
              computed: {
                kind: "FunctionCall",
                name: { kind: "QualifiedName", parts: ["str_concat"] },
                args: [
                  {
                    kind: "PathExpression",
                    path: [".first_name"]
                  },
                  {
                    kind: "Literal",
                    type: "string",
                    value: " "
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ];

  // Diff against empty schema to trigger CreateType
  const operations = differ.diff([], schema);

  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");

  const createOp = operations[0] as Types.CreateTypeOperation;

  // first_name should not be computed
  const firstName = createOp.properties.find(p => p.name === "first_name");
  assertEquals(firstName?.computed, undefined);

  // full_name should be computed
  const fullName = createOp.properties.find(p => p.name === "full_name");
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
                name: { kind: "QualifiedName", parts: ["float64"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "quantity" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["int32"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "total" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["float64"] }
              },
              required: false,
              multi: false,
              computed: {
                kind: "BinaryOp",
                op: "*",
                left: {
                  kind: "PathExpression",
                  path: [".price"]
                },
                right: {
                  kind: "PathExpression",
                  path: [".quantity"]
                }
              }
            }
          ]
        }
      ]
    }
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

Deno.test("Schema Differ - datetime_current() default produces DEFAULT NOW()", () => {
  const differ = new SchemaDiffer();
  const generator = new DDLGenerator();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Event" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "createdAt" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["datetime"] }
              },
              required: false,
              multi: false,
              default: {
                kind: "FunctionCall",
                name: { kind: "QualifiedName", parts: ["datetime_current"] },
                args: []
              }
            }
          ]
        }
      ]
    }
  ];

  const operations = differ.diff([], schema);
  const ddl = generator.generateDDL(operations);
  const createTableSql = ddl[0];

  assertStringIncludes(createTableSql, "DEFAULT NOW()");
  assertEquals(
    createTableSql.includes("'FunctionCall'"),
    false,
    "Default must not render AST node kind as literal string"
  );
});

Deno.test("DDL Generator - reserved PG keywords in type names are quoted", () => {
  const differ = new SchemaDiffer();
  const generator = new DDLGenerator();

  // 'User' lowercases to 'user' which is a reserved SQL/PG keyword.
  // Prior to the fix, CREATE TABLE user (...) produced a syntax error.
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
              name: { kind: "Identifier", value: "name" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            }
          ]
        }
      ]
    }
  ];

  const operations = differ.diff([], schema);
  const ddl = generator.generateDDL(operations);
  const createTableSql = ddl[0];

  assertStringIncludes(createTableSql, `CREATE TABLE "user"`);
  assertEquals(
    /CREATE TABLE user\s/.test(createTableSql),
    false,
    "Bare unquoted 'user' table name causes a PG syntax error"
  );
});

Deno.test("Schema Differ - detects changed computed expression", () => {
  const differ = new SchemaDiffer();

  const oldSchema: Module[] = [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "Product" },
      members: [
        {
          kind: "PropertyDeclaration",
          name: { kind: "Identifier", value: "price" },
          type: {
            kind: "TypeRef",
            name: { kind: "QualifiedName", parts: ["float64"] }
          },
          required: true,
          multi: false
        },
        {
          kind: "PropertyDeclaration",
          name: { kind: "Identifier", value: "total" },
          type: {
            kind: "TypeRef",
            name: { kind: "QualifiedName", parts: ["float64"] }
          },
          required: false,
          multi: false,
          computed: {
            kind: "BinaryOp",
            op: "*",
            left: { kind: "PathExpression", path: [".price"] },
            right: { kind: "Literal", type: "integer", value: 1 }
          }
        }
      ]
    }]
  }];

  // Same schema but total = price * 2 instead of price * 1
  const newSchema: Module[] = [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "Product" },
      members: [
        oldSchema[0].items[0].kind === "TypeDeclaration" ? oldSchema[0].items[0].members[0] : (() => {
          throw new Error("unreachable");
        })(),
        {
          kind: "PropertyDeclaration",
          name: { kind: "Identifier", value: "total" },
          type: {
            kind: "TypeRef",
            name: { kind: "QualifiedName", parts: ["float64"] }
          },
          required: false,
          multi: false,
          computed: {
            kind: "BinaryOp",
            op: "*",
            left: { kind: "PathExpression", path: [".price"] },
            right: { kind: "Literal", type: "integer", value: 2 }
          }
        }
      ]
    }]
  }];

  const ops = differ.diff(oldSchema, newSchema);
  const alterOp = ops.find(o =>
    o.kind === "AlterType" &&
    (o as Types.AlterTypeOperation).typeName === "Product"
  ) as Types.AlterTypeOperation | undefined;

  assertEquals(
    alterOp !== undefined,
    true,
    "Changing a computed expression must produce an AlterType operation"
  );
  const propChange = alterOp?.operations.find(o => o.kind === "AlterProperty") as Types.AlterPropertyOperation | undefined;
  assertEquals(
    propChange !== undefined,
    true,
    "AlterType must contain an AlterProperty for the computed change"
  );
  const changeKinds = propChange?.changes.map(c => c.kind) ?? [];
  assert(
    changeKinds.includes("ChangeComputed"),
    `Expected ChangeComputed in ${JSON.stringify(changeKinds)}`
  );
});

Deno.test("Schema Differ - detects added annotation", () => {
  const differ = new SchemaDiffer();

  const makeSchema = (annotations: Record<string, string>): Module[] => [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "User" },
      members: [{
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "name" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["str"] }
        },
        required: true,
        multi: false,
        annotations: Object.entries(annotations).map(([key, value]) => ({
          kind: "Annotation" as const,
          name: { kind: "QualifiedName" as const, parts: [key] },
          value: { kind: "Literal" as const, type: "string" as const, value }
        }))
      }]
    }]
  }];

  const oldSchema = makeSchema({});
  const newSchema = makeSchema({ description: "The user's full name" });

  const ops = differ.diff(oldSchema, newSchema);
  const alterOp = ops.find(o => o.kind === "AlterType") as
    | Types.AlterTypeOperation
    | undefined;
  assertEquals(
    alterOp !== undefined,
    true,
    "Adding an annotation must produce an AlterType operation"
  );
  const propChange = alterOp?.operations.find(o => o.kind === "AlterProperty") as Types.AlterPropertyOperation | undefined;
  const changeKinds = propChange?.changes.map(c => c.kind) ?? [];
  assert(
    changeKinds.includes("AddAnnotation") ||
      changeKinds.includes("ChangeAnnotation"),
    `Expected AddAnnotation/ChangeAnnotation in ${JSON.stringify(changeKinds)}`
  );
});

Deno.test("Schema Differ - detects removed annotation", () => {
  const differ = new SchemaDiffer();

  const makeSchema = (annotations: Record<string, string>): Module[] => [{
    name: "default",
    items: [{
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: "User" },
      members: [{
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "name" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["str"] }
        },
        required: true,
        multi: false,
        annotations: Object.entries(annotations).map(([key, value]) => ({
          kind: "Annotation" as const,
          name: { kind: "QualifiedName" as const, parts: [key] },
          value: { kind: "Literal" as const, type: "string" as const, value }
        }))
      }]
    }]
  }];

  const oldSchema = makeSchema({ description: "orig" });
  const newSchema = makeSchema({});

  const ops = differ.diff(oldSchema, newSchema);
  const alterOp = ops.find(o => o.kind === "AlterType") as
    | Types.AlterTypeOperation
    | undefined;
  const propChange = alterOp?.operations.find(o => o.kind === "AlterProperty") as Types.AlterPropertyOperation | undefined;
  const changeKinds = propChange?.changes.map(c => c.kind) ?? [];
  assert(
    changeKinds.includes("DropAnnotation"),
    `Expected DropAnnotation in ${JSON.stringify(changeKinds)}`
  );
});

Deno.test("DDL Generator - reserved PG keyword column names are quoted", () => {
  const differ = new SchemaDiffer();
  const generator = new DDLGenerator();

  const schema: Module[] = [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Session" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "user" }, // reserved
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            }
          ]
        }
      ]
    }
  ];

  const ddl = generator.generateDDL(differ.diff([], schema));
  assertStringIncludes(ddl[0], `"user"`);
});
