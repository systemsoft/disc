/**
 * Tests for Complex Schema Changes - renaming, type changes, constraint modifications
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Module } from "../schema/converter.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

// Helper functions for creating complex test schemas
function createBaseSchema(): Module[] {
  return [
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
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "age" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["int32"] }
              },
              required: false,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "email" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "exclusive" },
                  on: { kind: "PathExpression", path: [".email"] }
                }
              ]
            }
          ]
        },
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Post" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "title" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "LinkDeclaration",
              name: { kind: "Identifier", value: "author" },
              target: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["User"] }
              },
              required: true,
              multi: false
            }
          ]
        }
      ]
    }
  ];
}

function createRenamedPropertySchema(): Module[] {
  return [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "User" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "full_name" }, // renamed from "name"
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "birth_year" }, // renamed from "age", type changed
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["int32"] }
              },
              required: false,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "email" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "exclusive" },
                  on: { kind: "PathExpression", path: [".email"] }
                }
              ]
            }
          ]
        },
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Post" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "title" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "LinkDeclaration",
              name: { kind: "Identifier", value: "author" },
              target: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["User"] }
              },
              required: true,
              multi: false
            }
          ]
        }
      ]
    }
  ];
}

function createTypeChangeSchema(): Module[] {
  return [
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
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "age" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["float64"] }
              }, // changed from int32
              required: true, // changed from optional
              multi: false,
              default: { kind: "Literal", type: "float", value: 0.0 } // added default
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "email" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: false, // changed from required
              multi: true, // changed from single
              constraints: [] // removed exclusive constraint
            }
          ]
        },
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Post" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "title" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "LinkDeclaration",
              name: { kind: "Identifier", value: "author" },
              target: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["User"] }
              },
              required: false, // changed from required
              multi: true // changed to multi
            }
          ]
        }
      ]
    }
  ];
}

function createRenamedTypeSchema(): Module[] {
  return [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Account" }, // renamed from "User"
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
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "age" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["int32"] }
              },
              required: false,
              multi: false
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "email" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false,
              constraints: [
                {
                  kind: "Constraint",
                  name: { kind: "Identifier", value: "exclusive" },
                  on: { kind: "PathExpression", path: [".email"] }
                }
              ]
            }
          ]
        },
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "Post" },
          members: [
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "title" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
              multi: false
            },
            {
              kind: "LinkDeclaration",
              name: { kind: "Identifier", value: "author" },
              target: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["Account"] }
              }, // updated reference
              required: true,
              multi: false
            }
          ]
        }
      ]
    }
  ];
}

const config: Types.MigrationConfig = {
  migrationsDir: "./migrations",
  schemaFile: "./schema.disc",
  databaseUrl: "postgresql://localhost:5432/test",
  dryRun: true,
  autoApprove: false,
  backupBeforeMigration: true,
  rollbackOnError: true
};

Deno.test("Schema Differ - Detect Property Rename (appears as drop + add)", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedPropertySchema();

  const operations = differ.diff(oldSchema, newSchema);

  // Should detect changes to User type
  const userAlterOp = operations.find(op =>
    op.kind === "AlterType" &&
    (op as Types.AlterTypeOperation).typeName === "User"
  ) as Types.AlterTypeOperation;

  assertEquals(userAlterOp !== undefined, true);

  // Should have drop "name" and add "full_name"
  const dropNameOp = userAlterOp.operations.find(op =>
    op.kind === "DropProperty" &&
    (op as Types.DropPropertyOperation).propertyName === "name"
  );
  const addFullNameOp = userAlterOp.operations.find(op =>
    op.kind === "AddProperty" &&
    (op as Types.AddPropertyOperation).property.name === "full_name"
  );

  assertEquals(dropNameOp !== undefined, true);
  assertEquals(addFullNameOp !== undefined, true);

  // Should also have drop "age" and add "birth_year"
  const dropAgeOp = userAlterOp.operations.find(op =>
    op.kind === "DropProperty" &&
    (op as Types.DropPropertyOperation).propertyName === "age"
  );
  const addBirthYearOp = userAlterOp.operations.find(op =>
    op.kind === "AddProperty" &&
    (op as Types.AddPropertyOperation).property.name === "birth_year"
  );

  assertEquals(dropAgeOp !== undefined, true);
  assertEquals(addBirthYearOp !== undefined, true);
});

Deno.test("Schema Differ - Detect Type Changes in Properties", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createBaseSchema();
  const newSchema = createTypeChangeSchema();

  const operations = differ.diff(oldSchema, newSchema);

  const userAlterOp = operations.find(op =>
    op.kind === "AlterType" &&
    (op as Types.AlterTypeOperation).typeName === "User"
  ) as Types.AlterTypeOperation;

  assertEquals(userAlterOp !== undefined, true);

  // Should detect type change for age property
  const ageAlterOp = userAlterOp.operations.find(op =>
    op.kind === "AlterProperty" &&
    (op as Types.AlterPropertyOperation).propertyName === "age"
  ) as Types.AlterPropertyOperation;

  assertEquals(ageAlterOp !== undefined, true);

  // Should have multiple changes
  assertEquals(ageAlterOp.changes.length >= 3, true);

  // Should include type change
  const typeChange = ageAlterOp.changes.find(change => change.kind === "ChangeType");
  assertEquals(typeChange !== undefined, true);
  assertEquals(typeChange!.oldValue, "int32");
  assertEquals(typeChange!.newValue, "float64");

  // Should include required change
  const requiredChange = ageAlterOp.changes.find(change => change.kind === "ChangeRequired");
  assertEquals(requiredChange !== undefined, true);
  assertEquals(requiredChange!.oldValue, false);
  assertEquals(requiredChange!.newValue, true);

  // Should include default change
  const defaultChange = ageAlterOp.changes.find(change => change.kind === "ChangeDefault");
  assertEquals(defaultChange !== undefined, true);
});

Deno.test("Schema Differ - Detect Link Changes", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createBaseSchema();
  const newSchema = createTypeChangeSchema();

  const operations = differ.diff(oldSchema, newSchema);

  const postAlterOp = operations.find(op =>
    op.kind === "AlterType" &&
    (op as Types.AlterTypeOperation).typeName === "Post"
  ) as Types.AlterTypeOperation;

  assertEquals(postAlterOp !== undefined, true);

  // Should detect changes to author link
  const authorAlterOp = postAlterOp.operations.find(op =>
    op.kind === "AlterLink" &&
    (op as Types.AlterLinkOperation).linkName === "author"
  ) as Types.AlterLinkOperation;

  assertEquals(authorAlterOp !== undefined, true);
  assertEquals(authorAlterOp.changes.length >= 2, true);

  // Should include required change
  const requiredChange = authorAlterOp.changes.find(change => change.kind === "ChangeRequired");
  assertEquals(requiredChange !== undefined, true);
  assertEquals(requiredChange!.oldValue, true);
  assertEquals(requiredChange!.newValue, false);

  // Should include multi change
  const multiChange = authorAlterOp.changes.find(change => change.kind === "ChangeMulti");
  assertEquals(multiChange !== undefined, true);
  assertEquals(multiChange!.oldValue, false);
  assertEquals(multiChange!.newValue, true);
});

Deno.test("Schema Differ - Detect Type Rename (appears as drop + add)", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedTypeSchema();

  const operations = differ.diff(oldSchema, newSchema);

  // Should detect User type being dropped and Account type being added
  const dropUserOp = operations.find(op =>
    op.kind === "DropType" &&
    (op as Types.DropTypeOperation).typeName === "User"
  );
  const createAccountOp = operations.find(op =>
    op.kind === "CreateType" &&
    (op as Types.CreateTypeOperation).typeName === "Account"
  );

  assertEquals(dropUserOp !== undefined, true);
  assertEquals(createAccountOp !== undefined, true);

  // Should also update Post type to change link target
  const postAlterOp = operations.find(op =>
    op.kind === "AlterType" &&
    (op as Types.AlterTypeOperation).typeName === "Post"
  ) as Types.AlterTypeOperation;

  assertEquals(postAlterOp !== undefined, true);

  // Should have alter link operation
  const authorAlterOp = postAlterOp.operations.find(op =>
    op.kind === "AlterLink" &&
    (op as Types.AlterLinkOperation).linkName === "author"
  ) as Types.AlterLinkOperation;

  assertEquals(authorAlterOp !== undefined, true);

  const targetChange = authorAlterOp.changes.find(change => change.kind === "ChangeTarget");
  assertEquals(targetChange !== undefined, true);
  assertEquals(targetChange!.oldValue, "User");
  assertEquals(targetChange!.newValue, "Account");
});

Deno.test("DDL Generator - Handle Complex Type Changes", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AlterProperty",
        propertyName: "age",
        changes: [
          {
            kind: "ChangeType",
            oldValue: "int32",
            newValue: "float64"
          },
          {
            kind: "ChangeRequired",
            oldValue: false,
            newValue: true
          },
          {
            kind: "ChangeDefault",
            oldValue: undefined,
            newValue: 0.0
          }
        ]
      } as Types.AlterPropertyOperation
    ]
  };

  const statements = generator.generateDDL([operation]);

  assertEquals(statements.length >= 3, true);

  // Should have type change
  const typeChangeStmt = statements.find(stmt => stmt.includes("ALTER COLUMN age TYPE"));
  assertEquals(typeChangeStmt !== undefined, true);
  assertStringIncludes(typeChangeStmt!, "DOUBLE PRECISION");

  // Should have nullability change
  const nullabilityStmt = statements.find(stmt => stmt.includes("SET NOT NULL"));
  assertEquals(nullabilityStmt !== undefined, true);

  // Should have default change
  const defaultStmt = statements.find(stmt => stmt.includes("SET DEFAULT"));
  assertEquals(defaultStmt !== undefined, true);
  assertStringIncludes(defaultStmt!, "0.0");
});

Deno.test("DDL Generator - Handle Link Changes to Multi", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "Post",
    operations: [
      {
        kind: "AlterLink",
        linkName: "author",
        changes: [
          {
            kind: "ChangeMulti",
            oldValue: false,
            newValue: true
          },
          {
            kind: "ChangeRequired",
            oldValue: true,
            newValue: false
          }
        ]
      } as Types.AlterLinkOperation
    ]
  };

  const statements = generator.generateDDL([operation]);

  // Should generate an ALTER LINK comment (since link alteration is complex)
  assertEquals(statements.length >= 1, true);
});

Deno.test("Migration Engine - Validate Complex Changes for Safety", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedTypeSchema(); // This includes dropping User type

  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const validationResult = engine.validateMigration(planResult.value);

    // Should warn about potentially destructive changes
    assertEquals(validationResult.ok, false);
    if (!validationResult.ok) {
      assertStringIncludes(
        validationResult.error.message.toLowerCase(),
        "data loss"
      );
    }
  }
});

Deno.test("Migration Engine - Generate Data Migration Hints", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedPropertySchema();

  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const hintsResult = engine.generateDataMigrationHints(planResult.value);
    assertEquals(hintsResult.ok, true);

    if (hintsResult.ok) {
      const hints = hintsResult.value;

      // Should include hints about dropping properties
      const hasDropHint = hints.some((hint: string) => hint.toLowerCase().includes("backing up"));
      assertEquals(hasDropHint, true);
    }
  }
});

Deno.test("Migration Engine - Handle Constraint Changes", () => {
  const engine = new MigrationEngine(config);

  // Create schema with removed constraint
  const schemaWithoutConstraint = createTypeChangeSchema(); // email constraint removed

  const planResult = engine.planMigration(
    createBaseSchema(),
    schemaWithoutConstraint
  );
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const operations = planResult.value.migrations[0].operations;
    const userAlterOp = operations.find(op =>
      op.kind === "AlterType" &&
      (op as Types.AlterTypeOperation).typeName === "User"
    ) as Types.AlterTypeOperation;

    assertEquals(userAlterOp !== undefined, true);

    // Should have operation to change email property (removing exclusive constraint)
    const emailAlterOp = userAlterOp.operations.find(op =>
      op.kind === "AlterProperty" &&
      (op as Types.AlterPropertyOperation).propertyName === "email"
    );

    assertEquals(emailAlterOp !== undefined, true);
  }
});

Deno.test("Migration Engine - Complex Changes Integration Test", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createBaseSchema();
  const newSchema = createTypeChangeSchema();

  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const ddlResult = engine.generateDDL(planResult.value);
    assertEquals(ddlResult.ok, true);

    if (ddlResult.ok) {
      const statements = ddlResult.value;

      // Should handle multiple complex changes
      assertEquals(statements.length > 5, true);

      // Should include table alterations
      const hasAlterTable = statements.some(stmt => stmt.includes("ALTER TABLE"));
      assertEquals(hasAlterTable, true);

      // Should include type changes
      const hasTypeChange = statements.some(stmt => stmt.includes("TYPE"));
      assertEquals(hasTypeChange, true);
    }
  }
});
