/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Migration Rollback Functionality
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Module } from "../schema/converter.ts";
import { DDLGenerator } from "./ddl.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

// Helper function to create test config
function createTestConfig(
  overrides: Partial<Types.MigrationConfig> = {}
): Types.MigrationConfig {
  return {
    migrationsDir: "./migrations",
    schemaFile: "./schema.disc",
    databaseUrl: "postgresql://localhost:5432/test",
    dryRun: true,
    autoApprove: false,
    backupBeforeMigration: true,
    rollbackOnError: true,
    ...overrides
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
                name: { kind: "QualifiedName", parts: ["str"] }
              },
              required: true,
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
              multi: false
            }
          ]
        }
      ]
    }
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
        annotations: {}
      }
    ],
    links: []
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
    typeName: "User"
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
          annotations: {}
        }
      } as Types.AddPropertyOperation
    ]
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
        propertyName: "active"
      } as Types.DropPropertyOperation
    ]
  };

  const rollbackSQL = generator.generateRollbackDDL([operation]);

  // P1-10: rollback output now also includes a DO-block RAISE that fails
  // the rollback loudly at apply-time rather than silently no-op'ing.
  assertEquals(rollbackSQL.length, 4);
  assertStringIncludes(rollbackSQL[0], "-- MANUAL");
  assertStringIncludes(rollbackSQL[1], "ADD COLUMN active");
  assertStringIncludes(rollbackSQL[3], "RAISE EXCEPTION");
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
            newValue: "int64"
          },
          {
            kind: "ChangeRequired",
            oldValue: false,
            newValue: true
          }
        ]
      } as Types.AlterPropertyOperation
    ]
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
              annotations: {}
            }
          ],
          links: []
        } as Types.CreateTypeOperation
      ]
    }],
    targetSchemaHash: "test",
    operationsCount: 1
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
    { name: "migration3", operations: [] as Types.MigrationOperation[] }
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
        operations: migData.operations
      }],
      targetSchemaHash: migData.name,
      operationsCount: migData.operations.length
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
          typeName: "User"
        } as Types.DropTypeOperation,
        {
          kind: "AlterType",
          typeName: "Post",
          operations: [
            {
              kind: "DropProperty",
              propertyName: "content"
            } as Types.DropPropertyOperation
          ]
        } as Types.AlterTypeOperation
      ]
    }],
    targetSchemaHash: "destructive",
    operationsCount: 2
  };

  const validationResult = engine.validateRollbackSafety(destructivePlan);

  // Should identify rollback risks
  assertEquals(validationResult.ok, false);
  if (!validationResult.ok) {
    assertStringIncludes(
      validationResult.error.message.toLowerCase(),
      "rollback"
    );
    assertStringIncludes(
      validationResult.error.message.toLowerCase(),
      "data loss"
    );
  }
});

Deno.test("Migration Engine - Create Migration Checkpoint", async () => {
  const config = createTestConfig({ backupBeforeMigration: true });
  const engine = new MigrationEngine(config);

  // Create checkpoint before migration
  const checkpointResult = await engine.createMigrationCheckpoint(
    "test-checkpoint"
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
    "restore-test"
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

Deno.test("DDL Generator - rollback leaves the caller's operation order intact", () => {
  // The engine builds rollback SQL before the forward DDL from the same
  // array; reversing it in place ran multi-step migrations backwards.
  const operations: Types.DropTypeOperation[] = [
    { kind: "DropType", typeName: "First" },
    { kind: "DropType", typeName: "Second" }
  ];

  new DDLGenerator().generateRollbackDDL(operations);

  assertEquals(operations.map(operation => operation.typeName), ["First", "Second"]);
});

Deno.test("DDL Generator - rollback leaves nested alter operations in order", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    operations: [
      Types.dropPropertyOperation("first"),
      Types.dropPropertyOperation("second")
    ],
    typeName: "User"
  };

  new DDLGenerator().generateRollbackDDL([operation]);

  assertEquals(
    operation.operations.map(typeOp => (typeOp as Types.DropPropertyOperation).propertyName),
    ["first", "second"]
  );
});

/*** Rolling back a migration must remove every object its forward DDL created: `DROP TABLE <type> CASCADE`
     only drops the FKs into a type's junction tables, and a dropped table's trigger functions survive it. ***/

function prop(name: string, extra: Partial<Types.PropertyDefinition> = {}): Types.PropertyDefinition {
  return { annotations: {}, constraints: [], multi: false, name, required: false, type: "str", ...extra };
}

function link(name: string, target: string, extra: Partial<Types.LinkDefinition> = {}): Types.LinkDefinition {
  return { annotations: {}, multi: false, name, required: false, target, ...extra };
}

/*** The index of the first rollback statement containing `text`, or -1. ***/
function indexOfStatement(statements: string[], text: string): number {
  return statements.findIndex(statement => statement.includes(text));
}

Deno.test("DDL Generator - CreateType rollback drops the type's junction tables before the table", () => {
  const rollback = new DDLGenerator().generateRollbackDDL([
    Types.createTypeOperation("Video", [prop("title")], [
      link("tags", "Tag", { multi: true, properties: [prop("weight", { type: "int64" })] }),
      link("owner", "User")
    ])
  ]);

  const junction = indexOfStatement(rollback, "DROP TABLE IF EXISTS video_tags CASCADE;");
  const table = indexOfStatement(rollback, "DROP TABLE IF EXISTS video CASCADE;");

  assert(junction !== -1, rollback.join("\n"));
  assert(junction < table, "the junction is dropped before the table it references");
  assertEquals(indexOfStatement(rollback, "video_owner"), -1, "a single link has no junction");
});

Deno.test("DDL Generator - CreateType rollback drops the functions of its triggers, rewrites and delete-target links", () => {
  const operation = Types.createTypeOperation("Video", [
    prop("slug", { rewrites: [{ body: "str_lower(__subject__.title)", events: ["insert"] }] })
  ], [
    link("thumbnail", "Image", { onSourceDelete: "DELETE TARGET" }),
    link("clips", "Clip", { multi: true, onSourceDelete: "DELETE TARGET" })
  ]);
  operation.triggers = [{ body: "select 1", events: ["insert"], name: "log_insert", scope: "each", timing: "after" }];

  const rollback = new DDLGenerator().generateRollbackDDL([operation]);
  const table = indexOfStatement(rollback, "DROP TABLE IF EXISTS video CASCADE;");

  for (
    const fn of [
      "disc_source_delete_video_thumbnail",
      "disc_source_delete_video_clips",
      "video__log_insert_fn",
      "video__slug__rewrite_fn"
    ]
  ) {
    const drop = indexOfStatement(rollback, `DROP FUNCTION IF EXISTS ${fn}();`);
    assert(drop !== -1, `drops ${fn}:\n${rollback.join("\n")}`);
    assert(drop < table, `${fn} is dropped with its trigger, before the table`);
  }
});

Deno.test("DDL Generator - CreateType rollback drops only the junction the forward DDL created for a reciprocal link", () => {
  const operations = [
    Types.createTypeOperation("Group", [], [link("users", "User", { multi: true })]),
    Types.createTypeOperation("User", [], [link("groups", "Group", { multi: true })])
  ];
  const generator = new DDLGenerator();
  const forward = generator.generateDDL(operations).join("\n");
  const rollback = generator.generateRollbackDDL(operations);

  assertStringIncludes(forward, "CREATE TABLE group_users");
  assertEquals(forward.includes("CREATE TABLE user_groups"), false);
  assert(indexOfStatement(rollback, "DROP TABLE IF EXISTS group_users CASCADE;") !== -1);
  assertEquals(indexOfStatement(rollback, "user_groups"), -1, "user_groups was never created, so rollback leaves that name alone");
});

Deno.test("DDL Generator - AddLink rollback drops a delete-target link's trigger and function", () => {
  for (const multi of [false, true]) {
    const rollback = new DDLGenerator()
      .generateRollbackDDL([{
        kind: "AlterType",
        operations: [{ kind: "AddLink", link: link("pinnedVideo", "Video", { multi, onSourceDelete: "DELETE TARGET" }) } as Types.AddLinkOperation],
        typeName: "Channel"
      } as Types.AlterTypeOperation])
      .join("\n");

    assertStringIncludes(rollback, `DROP TRIGGER IF EXISTS "trg_source_delete_channel_pinnedVideo" ON channel;`);
    assertStringIncludes(rollback, `DROP FUNCTION IF EXISTS "disc_source_delete_channel_pinnedVideo"();`);
    assertStringIncludes(
      rollback,
      multi ? `DROP TABLE IF EXISTS "channel_pinnedVideo" CASCADE;` : "ALTER TABLE channel DROP COLUMN IF EXISTS pinned_video_id;"
    );
  }
});

Deno.test("DDL Generator - AddProperty rollback drops the snake_case column the forward DDL added", () => {
  const rollback = new DDLGenerator().generateRollbackDDL([{
    kind: "AlterType",
    operations: [Types.addPropertyOperation(prop("displayName"))],
    typeName: "Channel"
  } as Types.AlterTypeOperation]);

  assertEquals(rollback, ["ALTER TABLE channel DROP COLUMN IF EXISTS display_name;"]);
});
