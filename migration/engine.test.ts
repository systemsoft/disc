/**
 * Tests for Migration Engine
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { MigrationEngine } from "./engine.ts";
import { SchemaDiffer } from "./differ.ts";
import { DDLGenerator } from "./ddl.ts";
import * as SchemaAST from "../schema/ast.ts";
import * as Types from "./types.ts";

// Helper functions for creating test schemas
function createTestSchema(): SchemaAST.Module[] {
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
      ],
    },
  ];
}

function createExtendedTestSchema(): SchemaAST.Module[] {
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
              name: { kind: "Identifier", name: "email", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
              required: true,
              multi: false,
              constraints: [
                { kind: "Constraint", name: { kind: "Identifier", name: "exclusive", quoted: false } },
              ],
            },
            {
              kind: "Property",
              name: { kind: "Identifier", name: "active", quoted: false },
              type: { kind: "NamedType", name: { kind: "Identifier", name: "bool", quoted: false } },
              required: false,
              multi: false,
              default: { kind: "Literal", type: "boolean", value: true },
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

const config: Types.MigrationConfig = {
  migrations_dir: "./migrations",
  schema_file: "./schema.esdl",
  database_url: "postgresql://localhost:5432/test",
  dry_run: true,
  auto_approve: false,
  backup_before_migration: true,
  rollback_on_error: true,
};

Deno.test("Schema Differ - Add Type", () => {
  const differ = new SchemaDiffer();
  const oldSchema: SchemaAST.Module[] = [];
  const newSchema = createTestSchema();
  
  const operations = differ.diff(oldSchema, newSchema);
  
  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "CreateType");
  
  const createOp = operations[0] as Types.CreateTypeOperation;
  assertEquals(createOp.type_name, "User");
  assertEquals(createOp.properties.length, 2);
  assertEquals(createOp.properties[0].name, "name");
  assertEquals(createOp.properties[1].name, "email");
});

Deno.test("Schema Differ - Remove Type", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createTestSchema();
  const newSchema: SchemaAST.Module[] = [];
  
  const operations = differ.diff(oldSchema, newSchema);
  
  assertEquals(operations.length, 1);
  assertEquals(operations[0].kind, "DropType");
  
  const dropOp = operations[0] as Types.DropTypeOperation;
  assertEquals(dropOp.type_name, "User");
});

Deno.test("Schema Differ - Add Property", () => {
  const differ = new SchemaDiffer();
  const oldSchema = createTestSchema();
  const newSchema = createExtendedTestSchema();
  
  const operations = differ.diff(oldSchema, newSchema);
  
  // Should find: alter User (add active property) and create Post type
  assertEquals(operations.length, 2);
  
  const alterOp = operations.find(op => op.kind === "AlterType") as Types.AlterTypeOperation;
  assertEquals(alterOp.type_name, "User");
  assertEquals(alterOp.operations.length, 1);
  assertEquals(alterOp.operations[0].kind, "AddProperty");
  
  const addPropOp = alterOp.operations[0] as Types.AddPropertyOperation;
  assertEquals(addPropOp.property.name, "active");
  assertEquals(addPropOp.property.type, "bool");
  assertEquals(addPropOp.property.required, false);
});

Deno.test("DDL Generator - Create Type", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    type_name: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
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
  
  assertEquals(statements.length > 0, true);
  const createTableSQL = statements[0];
  
  assertStringIncludes(createTableSQL, "CREATE TABLE user");
  assertStringIncludes(createTableSQL, "id UUID PRIMARY KEY");
  assertStringIncludes(createTableSQL, "name TEXT NOT NULL");
  assertStringIncludes(createTableSQL, "email TEXT NOT NULL");
});

Deno.test("DDL Generator - Add Property", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    type_name: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "active",
          type: "bool",
          required: false,
          multi: false,
          default: true,
          constraints: [],
          annotations: {},
        },
      },
    ],
  };
  
  const statements = generator.generateDDL([operation]);
  
  assertEquals(statements.length, 1);
  assertStringIncludes(statements[0], "ALTER TABLE user");
  assertStringIncludes(statements[0], "ADD COLUMN active");
  assertStringIncludes(statements[0], "BOOLEAN NULL");
  assertStringIncludes(statements[0], "DEFAULT TRUE");
});

Deno.test("DDL Generator - Create Link", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    type_name: "Post",
    properties: [
      {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [
      {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        annotations: {},
      },
      {
        name: "tags",
        target: "Tag",
        required: false,
        multi: true,
        annotations: {},
      },
    ],
  };
  
  const statements = generator.generateDDL([operation]);
  
  // Should create main table + junction table for multi link
  assertEquals(statements.length >= 2, true);
  
  const mainTable = statements[0];
  assertStringIncludes(mainTable, "CREATE TABLE post");
  assertStringIncludes(mainTable, "author_id UUID");
  
  // Check for junction table creation
  const junctionTable = statements.find(stmt => stmt.includes("post_tags"));
  assertEquals(junctionTable !== undefined, true);
});

Deno.test("Migration Engine - Plan Initial Migration", () => {
  const engine = new MigrationEngine(config);
  const schema = createTestSchema();
  
  const result = engine.planMigration(null, schema);
  
  assertEquals(result.ok, true);
  const plan = result.value;
  
  assertEquals(plan.migrations.length, 1);
  assertEquals(plan.migrations[0].operations.length, 1);
  assertEquals(plan.migrations[0].operations[0].kind, "CreateType");
  assertEquals(plan.operations_count, 1);
});

Deno.test("Migration Engine - Plan Schema Evolution", () => {
  const engine = new MigrationEngine(config);
  const oldSchema = createTestSchema();
  const newSchema = createExtendedTestSchema();
  
  const result = engine.planMigration(oldSchema, newSchema);
  
  assertEquals(result.ok, true);
  const plan = result.value;
  
  assertEquals(plan.migrations.length, 1);
  assertEquals(plan.operations_count >= 1, true);
  
  // Should include alter User and create Post
  const operations = plan.migrations[0].operations;
  const hasAlterUser = operations.some(op => 
    op.kind === "AlterType" && (op as Types.AlterTypeOperation).type_name === "User"
  );
  const hasCreatePost = operations.some(op => 
    op.kind === "CreateType" && (op as Types.CreateTypeOperation).type_name === "Post"
  );
  
  assertEquals(hasAlterUser, true);
  assertEquals(hasCreatePost, true);
});

Deno.test("Migration Engine - Generate DDL", () => {
  const engine = new MigrationEngine(config);
  const schema = createTestSchema();
  
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);
  
  const ddlResult = engine.generateDDL(planResult.value);
  assertEquals(ddlResult.ok, true);
  
  const statements = ddlResult.value;
  assertEquals(statements.length > 0, true);
  
  const hasCreateTable = statements.some(stmt => stmt.includes("CREATE TABLE"));
  assertEquals(hasCreateTable, true);
});

Deno.test("Migration Engine - Validate Migration", () => {
  const engine = new MigrationEngine(config);
  
  // Create a plan with potentially dangerous operations
  const plan: Types.MigrationPlan = {
    migrations: [{
      id: "test-migration",
      name: "test",
      description: "Test migration",
      created_at: new Date(),
      schema_hash: "test",
      operations: [
        {
          kind: "DropType",
          type_name: "User",
        },
      ],
    }],
    target_schema_hash: "test",
    operations_count: 1,
  };
  
  const result = engine.validateMigration(plan);
  
  // Should return an error due to potentially destructive operation
  assertEquals(result.ok, false);
  assertStringIncludes(result.error.message, "data loss");
});

Deno.test("Migration Engine - Execute Migration", async () => {
  const engine = new MigrationEngine({ ...config, dry_run: true });
  const schema = createTestSchema();
  
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);
  
  const executeResult = await engine.executeMigration(planResult.value);
  assertEquals(executeResult.ok, true);
  
  const results = executeResult.value;
  assertEquals(results.length, 1);
  assertEquals(results[0].success, true);
  assertEquals(typeof results[0].duration_ms, "number");
});

Deno.test("Migration Engine - Track Migration State", async () => {
  const engine = new MigrationEngine(config);
  const schema = createTestSchema();
  
  // Initially no migrations applied
  let state = engine.getMigrationState();
  assertEquals(state.applied_migrations.length, 0);
  
  // Execute a migration
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);
  
  const executeResult = await engine.executeMigration(planResult.value);
  assertEquals(executeResult.ok, true);
  
  // Check that migration is now tracked
  state = engine.getMigrationState();
  assertEquals(state.applied_migrations.length, 1);
  assertEquals(engine.isMigrationApplied(planResult.value.migrations[0].id), true);
});

Deno.test("DDL Generator - Type Mapping", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    type_name: "TestTypes",
    properties: [
      { name: "str_field", type: "str", required: true, multi: false, constraints: [], annotations: {} },
      { name: "int_field", type: "int32", required: true, multi: false, constraints: [], annotations: {} },
      { name: "float_field", type: "float64", required: true, multi: false, constraints: [], annotations: {} },
      { name: "bool_field", type: "bool", required: true, multi: false, constraints: [], annotations: {} },
      { name: "uuid_field", type: "uuid", required: true, multi: false, constraints: [], annotations: {} },
      { name: "datetime_field", type: "datetime", required: true, multi: false, constraints: [], annotations: {} },
    ],
    links: [],
  };
  
  const statements = generator.generateDDL([operation]);
  const createTable = statements[0];
  
  assertStringIncludes(createTable, "str_field TEXT");
  assertStringIncludes(createTable, "int_field INTEGER");
  assertStringIncludes(createTable, "float_field DOUBLE PRECISION");
  assertStringIncludes(createTable, "bool_field BOOLEAN");
  assertStringIncludes(createTable, "uuid_field UUID");
  assertStringIncludes(createTable, "datetime_field TIMESTAMP WITH TIME ZONE");
});

Deno.test("DDL Generator - Identifier Escaping", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    type_name: "TestEscaping",
    properties: [
      { name: "order", type: "str", required: true, multi: false, constraints: [], annotations: {} },
      { name: "select", type: "str", required: true, multi: false, constraints: [], annotations: {} },
    ],
    links: [],
  };
  
  const statements = generator.generateDDL([operation]);
  const createTable = statements[0];
  
  // Reserved keywords should be quoted
  assertStringIncludes(createTable, '"order"');
  assertStringIncludes(createTable, '"select"');
});