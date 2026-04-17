/**
 * Tests for Migration Rollback Functionality
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { MigrationEngine } from "./engine.ts";
import { DDLGenerator } from "./ddl.ts";
import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";

// Helper function to create test config
function createTestConfig(
  overrides: Partial<Types.MigrationConfig> = {},
): Types.MigrationConfig {
  return {
    migrationsDir: "./migrations",
    schemaFile: "./schema.disc",
    databaseUrl: "postgresql://localhost:5432/test",
    dryRun: true,
    autoApprove: false,
    backupBeforeMigration: true,
    rollbackOnError: true,
    ...overrides,
  };
}

// Helper function to create a simple test schema
function createSimpleSchema(): Module[] {
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
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: true,
              multi: false,
            },
            {
              kind: "PropertyDeclaration",
              name: { kind: "Identifier", value: "email" },
              type: {
                kind: "TypeRef",
                name: { kind: "QualifiedName", parts: ["str"] },
              },
              required: true,
              multi: false,
            },
          ],
        },
      ],
    },
  ];
}

Deno.test("DDL Generator - Generate Rollback SQL for CreateType", () => {
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
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);

  assertEquals(rollbackSQL.length, 1);
  assertStringIncludes(rollbackSQL[0], "DROP TABLE");
  assertStringIncludes(rollbackSQL[0], "user");
});

Deno.test("DDL Generator - Generate Rollback SQL for DropType", () => {
  const generator = new DDLGenerator();
  const operation: Types.DropTypeOperation = {
    kind: "DropType",
    typeName: "User",
  };

  // For drop operations, rollback would need schema information to recreate
  // This tests that we properly handle the case where rollback needs schema context
  const rollbackSQL = generator.generateRollbackDDL([operation]);

  assertEquals(rollbackSQL.length >= 1, true);
  // Should contain a comment indicating manual intervention needed
  assertStringIncludes(rollbackSQL[0], "-- MANUAL");
});

Deno.test("DDL Generator - Generate Rollback SQL for AddProperty", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "active",
          type: "bool",
          required: false,
          multi: false,
          constraints: [],
          annotations: {},
        },
      } as Types.AddPropertyOperation,
    ],
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);

  assertEquals(rollbackSQL.length, 1);
  assertStringIncludes(rollbackSQL[0], `ALTER TABLE "user"`);
  assertStringIncludes(rollbackSQL[0], "DROP COLUMN IF EXISTS active");
});

Deno.test("DDL Generator - Generate Rollback SQL for DropProperty", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "DropProperty",
        propertyName: "active",
      } as Types.DropPropertyOperation,
    ],
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);

  assertEquals(rollbackSQL.length, 3);
  // Should indicate that manual intervention is needed to recreate the column with proper type
  assertStringIncludes(rollbackSQL[0], "-- MANUAL");
  assertStringIncludes(rollbackSQL[1], "ADD COLUMN active");
});

Deno.test("DDL Generator - Generate Rollback SQL for AlterProperty", () => {
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
            newValue: "int64",
          },
          {
            kind: "ChangeRequired",
            oldValue: false,
            newValue: true,
          },
        ],
      } as Types.AlterPropertyOperation,
    ],
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);

  assertEquals(rollbackSQL.length >= 2, true);

  // Should reverse the type change
  const typeChangeRollback = rollbackSQL.find((sql) =>
    sql.includes("ALTER COLUMN age TYPE")
  );
  assertEquals(typeChangeRollback !== undefined, true);
  assertStringIncludes(typeChangeRollback!, "INTEGER");

  // Should reverse the required change
  const requiredChangeRollback = rollbackSQL.find((sql) =>
    sql.includes("DROP NOT NULL")
  );
  assertEquals(requiredChangeRollback !== undefined, true);
});

Deno.test("Migration Engine - Generate Migration with Rollback", () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);
  const schema = createSimpleSchema();

  const result = engine.planMigration(null, schema);
  assertEquals(result.ok, true);

  if (result.ok) {
    const plan = result.value;
    const migration = plan.migrations[0];

    // Migration should have rollback SQL generated
    const rollbackSQL = engine.generateRollbackSQL(migration);
    assertEquals(rollbackSQL.ok, true);
    if (rollbackSQL.ok) {
      assertEquals(rollbackSQL.value.length > 0, true);
    }
  }
});

Deno.test("Migration Engine - Execute Migration with Rollback on Error", async () => {
  const config = createTestConfig({ rollbackOnError: true });
  const engine = new MigrationEngine(config);

  // Create a plan that will fail during execution
  const plan: Types.MigrationPlan = {
    migrations: [{
      id: "test-migration-fail",
      name: "failing migration",
      description: "This migration will fail",
      createdAt: new Date(),
      schemaHash: "test",
      operations: [
        {
          kind: "CreateType",
          typeName: "User",
          properties: [
            {
              name: "invalid field with spaces",
              type: "invalid_type",
              required: true,
              multi: false,
              constraints: [],
              annotations: {},
            },
          ],
          links: [],
        } as Types.CreateTypeOperation,
      ],
    }],
    targetSchemaHash: "test",
    operationsCount: 1,
  };

  // Mock the private executeStatements method to simulate a failure
  (engine as unknown as Record<string, unknown>).executeStatements = () => {
    throw new Error("Simulated database error");
  };

  // Should attempt rollback when migration fails
  const result = await engine.executeMigrationWithRollback(plan);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "Simulated database error");
  }
});

Deno.test("Migration Engine - Rollback Specific Migration", async () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);
  const schema = createSimpleSchema();

  // First apply a migration
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const executeResult = await engine.executeMigration(planResult.value);
    assertEquals(executeResult.ok, true);

    const migrationId = planResult.value.migrations[0].id;

    // Check that migration is applied
    assertEquals(engine.isMigrationApplied(migrationId), true);

    // Now rollback the migration
    const rollbackResult = await engine.rollbackMigration(migrationId);
    assertEquals(rollbackResult.ok, true);

    // Migration should no longer be applied
    assertEquals(engine.isMigrationApplied(migrationId), false);
  }
});

Deno.test("Migration Engine - Rollback To Specific Migration", async () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);

  // Apply multiple migrations
  const migrations = [
    { name: "migration1", operations: [] as Types.MigrationOperation[] },
    { name: "migration2", operations: [] as Types.MigrationOperation[] },
    { name: "migration3", operations: [] as Types.MigrationOperation[] },
  ];

  const migrationIds: string[] = [];

  for (const migData of migrations) {
    const plan: Types.MigrationPlan = {
      migrations: [{
        id: `test-${migData.name}`,
        name: migData.name,
        description: `Test ${migData.name}`,
        createdAt: new Date(),
        schemaHash: migData.name,
        operations: migData.operations,
      }],
      targetSchemaHash: migData.name,
      operationsCount: migData.operations.length,
    };

    await engine.executeMigration(plan);
    migrationIds.push(plan.migrations[0].id);
  }

  // All migrations should be applied
  for (const id of migrationIds) {
    assertEquals(engine.isMigrationApplied(id), true);
  }

  // Rollback to migration1 (should rollback migration3 and migration2)
  const rollbackResult = await engine.rollbackToMigration(migrationIds[0]);
  assertEquals(rollbackResult.ok, true);

  // Only migration1 should remain applied
  assertEquals(engine.isMigrationApplied(migrationIds[0]), true);
  assertEquals(engine.isMigrationApplied(migrationIds[1]), false);
  assertEquals(engine.isMigrationApplied(migrationIds[2]), false);
});

Deno.test("Migration Engine - Validate Rollback Safety", () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);

  // Create a plan with destructive operations
  const destructivePlan: Types.MigrationPlan = {
    migrations: [{
      id: "destructive-migration",
      name: "destructive changes",
      description: "This migration may lose data",
      createdAt: new Date(),
      schemaHash: "destructive",
      operations: [
        {
          kind: "DropType",
          typeName: "User",
        } as Types.DropTypeOperation,
        {
          kind: "AlterType",
          typeName: "Post",
          operations: [
            {
              kind: "DropProperty",
              propertyName: "content",
            } as Types.DropPropertyOperation,
          ],
        } as Types.AlterTypeOperation,
      ],
    }],
    targetSchemaHash: "destructive",
    operationsCount: 2,
  };

  const validationResult = engine.validateRollbackSafety(destructivePlan);

  // Should identify rollback risks
  assertEquals(validationResult.ok, false);
  if (!validationResult.ok) {
    assertStringIncludes(
      validationResult.error.message.toLowerCase(),
      "rollback",
    );
    assertStringIncludes(
      validationResult.error.message.toLowerCase(),
      "data loss",
    );
  }
});

Deno.test("Migration Engine - Create Migration Checkpoint", async () => {
  const config = createTestConfig({ backupBeforeMigration: true });
  const engine = new MigrationEngine(config);

  // Create checkpoint before migration
  const checkpointResult = await engine.createMigrationCheckpoint(
    "test-checkpoint",
  );
  assertEquals(checkpointResult.ok, true);

  if (checkpointResult.ok) {
    const checkpoint = checkpointResult.value;
    assertEquals(typeof checkpoint.id, "string");
    assertEquals(typeof checkpoint.createdAt, "object");
    assertEquals(checkpoint.schemaState !== undefined, true);
  }
});

Deno.test("Migration Engine - Restore From Checkpoint", async () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);

  // Create a checkpoint
  const checkpointResult = await engine.createMigrationCheckpoint(
    "restore-test",
  );
  assertEquals(checkpointResult.ok, true);

  if (checkpointResult.ok) {
    const checkpoint = checkpointResult.value;

    // Apply some migration
    const schema = createSimpleSchema();
    const planResult = engine.planMigration(null, schema);
    assertEquals(planResult.ok, true);
    if (planResult.ok) {
      await engine.executeMigration(planResult.value);
    }

    // Restore from checkpoint
    const restoreResult = await engine.restoreFromCheckpoint(checkpoint.id);
    assertEquals(restoreResult.ok, true);

    // State should be restored
    const currentState = engine.getMigrationState();
    assertEquals(currentState.appliedMigrations.length, 0);
  }
});
