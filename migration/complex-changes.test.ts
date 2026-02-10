/**
 * Tests for Complex Schema Changes - renaming, type changes, constraint modifications
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { SchemaDiffer } from "./differ.ts";
import { DDLGenerator } from "./ddl.ts";
import { MigrationEngine } from "./engine.ts";
import * as SchemaAST from "../schema/ast.ts";
import * as Types from "./types.ts";

// Helper functions for creating complex test schemas
function createBaseSchema(): SchemaAST.Module[] {
  return [
    {
      kind: "Module",
      name: { kind: "Identifier", name: "default", quoted: false },
      items: [
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "User", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "name", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "age", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "int32", quoted: false } },
              required: false,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "email", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
              constraints: [
                { kind: "Constraint", name: { kind: "Identifier", name: "exclusive", quoted: false } },
              ],
            },
          ],
        },
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "Post", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "title", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Link",
              name: { kind: "Identifier", name: "author", quoted: false },
              target: { kind: "NamedType", name: { kind: "Identifier", name: "User", quoted: false } },
              required: true,
              multi: false,
            },
          ],
        },
      ],
    },
  ];
}

function createRenamedPropertySchema(): SchemaAST.Module[] {
  return [
    {
      kind: "Module",
      name: { kind: "Identifier", name: "default", quoted: false },
      items: [
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "User", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "full_name", quoted: false }, // renamed from "name"
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "birth_year", quoted: false }, // renamed from "age", type changed
              type: { kind: "NamedType", name: { kind: "Identifier", name: "int32", quoted: false } },
              required: false,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "email", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
              constraints: [
                { kind: "Constraint", name: { kind: "Identifier", name: "exclusive", quoted: false } },
              ],
            },
          ],
        },
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "Post", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "title", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Link",
              name: { kind: "Identifier", name: "author", quoted: false },
              target: { kind: "NamedType", name: { kind: "Identifier", name: "User", quoted: false } },
              required: true,
              multi: false,
            },
          ],
        },
      ],
    },
  ];
}

function createTypeChangeSchema(): SchemaAST.Module[] {
  return [
    {
      kind: "Module",
      name: { kind: "Identifier", name: "default", quoted: false },
      items: [
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "User", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "name", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "age", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "float64", quoted: false } }, // changed from int32
              required: true, // changed from optional
              multi: false,
              default: { kind: "Literal", type: "number", value: 0.0 }, // added default
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "email", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: false, // changed from required
              multi: true, // changed from single
              constraints: [], // removed exclusive constraint
            },
          ],
        },
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "Post", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "title", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Link",
              name: { kind: "Identifier", name: "author", quoted: false },
              target: { kind: "NamedType", name: { kind: "Identifier", name: "User", quoted: false } },
              required: false, // changed from required
              multi: true, // changed to multi
            },
          ],
        },
      ],
    },
  ];
}

function createRenamedTypeSchema(): SchemaAST.Module[] {
  return [
    {
      kind: "Module",
      name: { kind: "Identifier", name: "default", quoted: false },
      items: [
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "Account", quoted: false }, // renamed from "User"
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "name", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "age", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "int32", quoted: false } },
              required: false,
              multi: false,
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "email", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
              constraints: [
                { kind: "Constraint", name: { kind: "Identifier", name: "exclusive", quoted: false } },
              ],
            },
          ],
        },
        {
          kind: "TypeDef",
          name: { kind: "Identifier", name: "Post", quoted: false },
          extending: [],
          items: [
            {
              kind: "Property",
              name: { kind: "Identifier", name: "title", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
            },
            {
              kind: "Link",
              name: { kind: "Identifier", name: "author", quoted: false },
              target: { kind: "NamedType", name: { kind: "Identifier", name: "Account", quoted: false } }, // updated reference
              required: true,
              multi: false,
            },
          ],
        },
      ],
    },
  ];
}

const config: Types.MigrationConfig = {
  migrations_dir: "./migrations",
  schema_file: "./schema.esdl",
  database_url: "postgresql://localhost:5432/test",
  dry_run: true,
  auto_approve: false,
  backup_before_migration: true,
  rollback_on_error: true,
};

Deno.test("Schema Differ - Detect Property Rename (appears as drop + add)", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedPropertySchema();
  
  const operations = differ.diff(oldSchema, newSchema);
  
  // Should detect changes to User type
  const userAlterOp = operations.find(op => 
    op.kind === "AlterType" && (op as Types.AlterTypeOperation).type_name === "User"
  ) as Types.AlterTypeOperation;
  
  assertEquals(userAlterOp !== undefined, true);
  
  // Should have drop "name" and add "full_name"
  const dropNameOp = userAlterOp.operations.find(op => 
    op.kind === "DropProperty" && (op as Types.DropPropertyOperation).property_name === "name"
  );
  const addFullNameOp = userAlterOp.operations.find(op => 
    op.kind === "AddProperty" && (op as Types.AddPropertyOperation).property.name === "full_name"
  );
  
  assertEquals(dropNameOp !== undefined, true);
  assertEquals(addFullNameOp !== undefined, true);
  
  // Should also have drop "age" and add "birth_year"
  const dropAgeOp = userAlterOp.operations.find(op => 
    op.kind === "DropProperty" && (op as Types.DropPropertyOperation).property_name === "age"
  );
  const addBirthYearOp = userAlterOp.operations.find(op => 
    op.kind === "AddProperty" && (op as Types.AddPropertyOperation).property.name === "birth_year"
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
    op.kind === "AlterType" && (op as Types.AlterTypeOperation).type_name === "User"
  ) as Types.AlterTypeOperation;
  
  assertEquals(userAlterOp !== undefined, true);
  
  // Should detect type change for age property
  const ageAlterOp = userAlterOp.operations.find(op => 
    op.kind === "AlterProperty" && (op as Types.AlterPropertyOperation).property_name === "age"
  ) as Types.AlterPropertyOperation;
  
  assertEquals(ageAlterOp !== undefined, true);
  
  // Should have multiple changes
  assertEquals(ageAlterOp.changes.length >= 3, true);
  
  // Should include type change
  const typeChange = ageAlterOp.changes.find(change => change.kind === "ChangeType");
  assertEquals(typeChange !== undefined, true);
  assertEquals(typeChange!.old_value, "int32");
  assertEquals(typeChange!.new_value, "float64");
  
  // Should include required change
  const requiredChange = ageAlterOp.changes.find(change => change.kind === "ChangeRequired");
  assertEquals(requiredChange !== undefined, true);
  assertEquals(requiredChange!.old_value, false);
  assertEquals(requiredChange!.new_value, true);
  
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
    op.kind === "AlterType" && (op as Types.AlterTypeOperation).type_name === "Post"
  ) as Types.AlterTypeOperation;
  
  assertEquals(postAlterOp !== undefined, true);
  
  // Should detect changes to author link
  const authorAlterOp = postAlterOp.operations.find(op => 
    op.kind === "AlterLink" && (op as Types.AlterLinkOperation).link_name === "author"
  ) as Types.AlterLinkOperation;
  
  assertEquals(authorAlterOp !== undefined, true);
  assertEquals(authorAlterOp.changes.length >= 2, true);
  
  // Should include required change
  const requiredChange = authorAlterOp.changes.find(change => change.kind === "ChangeRequired");
  assertEquals(requiredChange !== undefined, true);
  assertEquals(requiredChange!.old_value, true);
  assertEquals(requiredChange!.new_value, false);
  
  // Should include multi change
  const multiChange = authorAlterOp.changes.find(change => change.kind === "ChangeMulti");
  assertEquals(multiChange !== undefined, true);
  assertEquals(multiChange!.old_value, false);
  assertEquals(multiChange!.new_value, true);
});

Deno.test("Schema Differ - Detect Type Rename (appears as drop + add)", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedTypeSchema();
  
  const operations = differ.diff(oldSchema, newSchema);
  
  // Should detect User type being dropped and Account type being added
  const dropUserOp = operations.find(op => 
    op.kind === "DropType" && (op as Types.DropTypeOperation).type_name === "User"
  );
  const createAccountOp = operations.find(op => 
    op.kind === "CreateType" && (op as Types.CreateTypeOperation).type_name === "Account"
  );
  
  assertEquals(dropUserOp !== undefined, true);
  assertEquals(createAccountOp !== undefined, true);
  
  // Should also update Post type to change link target
  const postAlterOp = operations.find(op => 
    op.kind === "AlterType" && (op as Types.AlterTypeOperation).type_name === "Post"
  ) as Types.AlterTypeOperation;
  
  assertEquals(postAlterOp !== undefined, true);
  
  // Should have alter link operation
  const authorAlterOp = postAlterOp.operations.find(op => 
    op.kind === "AlterLink" && (op as Types.AlterLinkOperation).link_name === "author"
  ) as Types.AlterLinkOperation;
  
  assertEquals(authorAlterOp !== undefined, true);
  
  const targetChange = authorAlterOp.changes.find(change => change.kind === "ChangeTarget");
  assertEquals(targetChange !== undefined, true);
  assertEquals(targetChange!.old_value, "User");
  assertEquals(targetChange!.new_value, "Account");
});

Deno.test("DDL Generator - Handle Complex Type Changes", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    type_name: "User",
    operations: [
      {
        kind: "AlterProperty",
        property_name: "age",
        changes: [
          {
            kind: "ChangeType",
            old_value: "int32",
            new_value: "float64",
          },
          {
            kind: "ChangeRequired",
            old_value: false,
            new_value: true,
          },
          {
            kind: "ChangeDefault",
            old_value: undefined,
            new_value: 0.0,
          },
        ],
      },
    ],
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
    type_name: "Post",
    operations: [
      {
        kind: "AlterLink",
        link_name: "author",
        changes: [
          {
            kind: "ChangeMulti",
            old_value: false,
            new_value: true,
          },
          {
            kind: "ChangeRequired",
            old_value: true,
            new_value: false,
          },
        ],
      },
    ],
  };
  
  const statements = generator.generateDDL([operation]);
  
  // Should create junction table for multi-link
  const junctionTableStmt = statements.find(stmt => 
    stmt.includes("CREATE TABLE") && stmt.includes("post_author")
  );
  assertEquals(junctionTableStmt !== undefined, true);
  
  // Should drop the foreign key column from main table
  const dropColumnStmt = statements.find(stmt => 
    stmt.includes("DROP COLUMN") && stmt.includes("author_id")
  );
  assertEquals(dropColumnStmt !== undefined, true);
});

Deno.test("Migration Engine - Validate Complex Changes for Safety", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedTypeSchema(); // This includes dropping User type
  
  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);
  
  const validationResult = engine.validateMigration(planResult.value);
  
  // Should warn about potentially destructive changes
  assertEquals(validationResult.ok, false);
  assertStringIncludes(validationResult.error.message.toLowerCase(), "data loss");
});

Deno.test("Migration Engine - Generate Data Migration Hints", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createBaseSchema();
  const newSchema = createRenamedPropertySchema();
  
  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);
  
  const hintsResult = engine.generateDataMigrationHints(planResult.value);
  assertEquals(hintsResult.ok, true);
  
  const hints = hintsResult.value;
  
  // Should include hint for name -> full_name migration
  const nameHint = hints.find(hint => 
    hint.includes("name") && hint.includes("full_name")
  );
  assertEquals(nameHint !== undefined, true);
  
  // Should include hint for age -> birth_year migration
  const ageHint = hints.find(hint => 
    hint.includes("age") && hint.includes("birth_year")
  );
  assertEquals(ageHint !== undefined, true);
});

Deno.test("Migration Engine - Handle Constraint Changes", () => {
  const engine = new MigrationEngine(config);
  
  // Create schema with removed constraint
  const schemaWithoutConstraint = createTypeChangeSchema(); // email constraint removed
  
  const planResult = engine.planMigration(createBaseSchema(), schemaWithoutConstraint);
  assertEquals(planResult.ok, true);
  
  const operations = planResult.value.migrations[0].operations;
  const userAlterOp = operations.find(op => 
    op.kind === "AlterType" && (op as Types.AlterTypeOperation).type_name === "User"
  ) as Types.AlterTypeOperation;
  
  assertEquals(userAlterOp !== undefined, true);
  
  // Should have operation to change email property (removing exclusive constraint)
  const emailAlterOp = userAlterOp.operations.find(op => 
    op.kind === "AlterProperty" && (op as Types.AlterPropertyOperation).property_name === "email"
  );
  
  assertEquals(emailAlterOp !== undefined, true);
});

Deno.test("Migration Engine - Complex Changes Integration Test", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createBaseSchema();
  const newSchema = createTypeChangeSchema();
  
  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);
  
  const ddlResult = engine.generateDDL(planResult.value);
  assertEquals(ddlResult.ok, true);
  
  const statements = ddlResult.value;
  
  // Should handle multiple complex changes
  assertEquals(statements.length > 5, true);
  
  // Should include table alterations
  const hasAlterTable = statements.some(stmt => stmt.includes("ALTER TABLE"));
  assertEquals(hasAlterTable, true);
  
  // Should include constraint changes
  const hasConstraintChange = statements.some(stmt => 
    stmt.includes("DROP CONSTRAINT") || stmt.includes("ADD CONSTRAINT")
  );
  assertEquals(hasConstraintChange, true);
  
  // Should include type changes
  const hasTypeChange = statements.some(stmt => stmt.includes("TYPE"));
  assertEquals(hasTypeChange, true);
});