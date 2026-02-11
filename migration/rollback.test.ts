/**
 * Tests for Migration Rollback Functionality
 */

import { assertEquals, assertStringIncludes, assertRejects } from "@std/assert";
import { MigrationEngine } from "./engine.ts";
import { DDLGenerator } from "./ddl.ts";
import * as SchemaAST from "../schema/ast.ts";
import * as Types from "./types.ts";

// Helper function to create test config
function createTestConfig(overrides: Partial<Types.MigrationConfig> = {}): Types.MigrationConfig {
  return {
    migrations_dir: "./migrations",
    schema_file: "./schema.esdl",
    database_url: "postgresql://localhost:5432/test",
    dry_run: true,
    auto_approve: false,
    backup_before_migration: true,
    rollback_on_error: true,
    ...overrides,
  };
}

// Helper function to create a simple test schema
function createSimpleSchema(): SchemaAST.Module[] {
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
    type_name: "User",
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
    type_name: "User",
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
      },
    ],
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);
  
  assertEquals(rollbackSQL.length, 1);
  assertStringIncludes(rollbackSQL[0], "ALTER TABLE user");
  assertStringIncludes(rollbackSQL[0], "DROP COLUMN IF EXISTS active");
});

Deno.test("DDL Generator - Generate Rollback SQL for DropProperty", () => {
  const generator = new DDLGenerator();
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    type_name: "User",
    operations: [
      {
        kind: "DropProperty",
        property_name: "active",
      },
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
    type_name: "User",
    operations: [
      {
        kind: "AlterProperty",
        property_name: "age",
        changes: [
          {
            kind: "ChangeType",
            old_value: "int32",
            new_value: "int64",
          },
          {
            kind: "ChangeRequired",
            old_value: false,
            new_value: true,
          },
        ],
      },
    ],
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);
  
  assertEquals(rollbackSQL.length >= 2, true);
  
  // Should reverse the type change
  const typeChangeRollback = rollbackSQL.find(sql => sql.includes("ALTER COLUMN age TYPE"));
  assertEquals(typeChangeRollback !== undefined, true);
  assertStringIncludes(typeChangeRollback!, "INTEGER");
  
  // Should reverse the required change
  const requiredChangeRollback = rollbackSQL.find(sql => sql.includes("DROP NOT NULL"));
  assertEquals(requiredChangeRollback !== undefined, true);
});

Deno.test("Migration Engine - Generate Migration with Rollback", () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);
  const schema = createSimpleSchema();
  
  const result = engine.planMigration(null, schema);
  assertEquals(result.ok, true);
  
  const plan = result.value;
  const migration = plan.migrations[0];
  
  // Migration should have rollback SQL generated
  const rollbackSQL = engine.generateRollbackSQL(migration);
  assertEquals(rollbackSQL.ok, true);
  if (rollbackSQL.ok) {
    assertEquals(rollbackSQL.value.length > 0, true);
  }
});

Deno.test("Migration Engine - Execute Migration with Rollback on Error", async () => {
  const config = createTestConfig({ rollback_on_error: true });
  const engine = new MigrationEngine(config);
  
  // Create a plan that will fail during execution
  const plan: Types.MigrationPlan = {
    migrations: [{
      id: "test-migration-fail",
      name: "failing migration",
      description: "This migration will fail",
      created_at: new Date(),
      schema_hash: "test",
      operations: [
        {
          kind: "CreateType",
          type_name: "User",
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
    target_schema_hash: "test",
    operations_count: 1,
  };

  // Mock the private executeStatements method to simulate a failure
  const originalExecuteStatements = (engine as any).executeStatements;
  (engine as any).executeStatements = async () => {
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
    { name: "migration1", operations: [] },
    { name: "migration2", operations: [] },
    { name: "migration3", operations: [] },
  ];
  
  const migrationIds: string[] = [];
  
  for (const migData of migrations) {
    const plan: Types.MigrationPlan = {
      migrations: [{
        id: `test-${migData.name}`,
        name: migData.name,
        description: `Test ${migData.name}`,
        created_at: new Date(),
        schema_hash: migData.name,
        operations: migData.operations,
      }],
      target_schema_hash: migData.name,
      operations_count: migData.operations.length,
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
      created_at: new Date(),
      schema_hash: "destructive",
      operations: [
        {
          kind: "DropType",
          type_name: "User",
        } as Types.DropTypeOperation,
        {
          kind: "AlterType",
          type_name: "Post",
          operations: [
            {
              kind: "DropProperty",
              property_name: "content",
            } as Types.DropPropertyOperation,
          ],
        } as Types.AlterTypeOperation,
      ],
    }],
    target_schema_hash: "destructive",
    operations_count: 2,
  };
  
  const validationResult = engine.validateRollbackSafety(destructivePlan);
  
  // Should identify rollback risks
  assertEquals(validationResult.ok, false);
  if (!validationResult.ok) {
    assertStringIncludes(validationResult.error.message.toLowerCase(), "rollback");
    assertStringIncludes(validationResult.error.message.toLowerCase(), "data loss");
  }
});

Deno.test("Migration Engine - Create Migration Checkpoint", async () => {
  const config = createTestConfig({ backup_before_migration: true });
  const engine = new MigrationEngine(config);
  
  // Create checkpoint before migration
  const checkpointResult = await engine.createMigrationCheckpoint("test-checkpoint");
  assertEquals(checkpointResult.ok, true);
  
  if (checkpointResult.ok) {
    const checkpoint = checkpointResult.value;
    assertEquals(typeof checkpoint.id, "string");
    assertEquals(typeof checkpoint.created_at, "object");
    assertEquals(checkpoint.schema_state !== undefined, true);
  }
});

Deno.test("Migration Engine - Restore From Checkpoint", async () => {
  const config = createTestConfig();
  const engine = new MigrationEngine(config);
  
  // Create a checkpoint
  const checkpointResult = await engine.createMigrationCheckpoint("restore-test");
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
    assertEquals(currentState.applied_migrations.length, 0);
  }
});