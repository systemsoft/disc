/**
 * Tests for Migration Tracker - database persistence functionality
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { MigrationTracker } from "./tracker.ts";
import * as Types from "./types.ts";

// Helper function to create test migration
function createTestMigration(): Types.Migration {
  return {
    id: "test-migration-001",
    name: "create_user_table",
    description: "Create initial user table",
    created_at: new Date("2024-01-01T10:00:00Z"),
    schema_hash: "abc123",
    operations: [
      {
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
      },
    ],
  };
}

// Helper function to create test migration result
function createTestMigrationResult(): Types.MigrationResult {
  return {
    success: true,
    migration_id: "test-migration-001",
    applied_at: new Date("2024-01-01T10:01:00Z"),
    duration_ms: 150,
    rollback_sql: ["DROP TABLE IF EXISTS user CASCADE;"],
  };
}

Deno.test("Migration Tracker - Initialize", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  
  const result = await tracker.initialize();
  assertEquals(result.ok, true);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Record Migration", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  
  const recordResult = await tracker.recordMigration(migration, migrationResult);
  assertEquals(recordResult.ok, true);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Get Applied Migrations", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Record a migration
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  await tracker.recordMigration(migration, migrationResult);
  
  // Get applied migrations
  const appliedResult = await tracker.getAppliedMigrations();
  assertEquals(appliedResult.ok, true);
  assertEquals(appliedResult.value.length, 1);
  assertEquals(appliedResult.value[0], migration.id);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Check Migration Applied Status", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  
  // Check before applying
  let isAppliedResult = await tracker.isMigrationApplied(migration.id);
  assertEquals(isAppliedResult.ok, true);
  assertEquals(isAppliedResult.value, false);
  
  // Apply migration
  await tracker.recordMigration(migration, migrationResult);
  
  // Check after applying
  isAppliedResult = await tracker.isMigrationApplied(migration.id);
  assertEquals(isAppliedResult.ok, true);
  assertEquals(isAppliedResult.value, true);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Remove Migration", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  
  // Record migration
  await tracker.recordMigration(migration, migrationResult);
  
  // Verify it's applied
  let isAppliedResult = await tracker.isMigrationApplied(migration.id);
  assertEquals(isAppliedResult.value, true);
  
  // Remove migration
  const removeResult = await tracker.removeMigration(migration.id);
  assertEquals(removeResult.ok, true);
  
  // Verify it's no longer applied
  isAppliedResult = await tracker.isMigrationApplied(migration.id);
  assertEquals(isAppliedResult.value, false);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Get Migration State", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Initial state should be empty
  let stateResult = await tracker.getMigrationState();
  assertEquals(stateResult.ok, true);
  assertEquals(stateResult.value.applied_migrations.length, 0);
  
  // Apply migration
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  await tracker.recordMigration(migration, migrationResult);
  
  // Check state after migration
  stateResult = await tracker.getMigrationState();
  assertEquals(stateResult.ok, true);
  assertEquals(stateResult.value.applied_migrations.length, 1);
  assertEquals(stateResult.value.last_migration_id, migration.id);
  assertEquals(stateResult.value.current_schema_hash, migration.schema_hash);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Save and Load Checkpoint", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  const checkpoint: Types.MigrationCheckpoint = {
    id: "checkpoint-001",
    name: "before_user_table_changes",
    created_at: new Date("2024-01-01T09:00:00Z"),
    schema_state: {
      version: "1.0",
      tables: ["existing_table"],
    },
    migration_state: {
      applied_migrations: [],
      current_schema_hash: "initial",
    },
  };
  
  // Save checkpoint
  const saveResult = await tracker.saveCheckpoint(checkpoint);
  assertEquals(saveResult.ok, true);
  
  // Load checkpoint
  const loadResult = await tracker.loadCheckpoint(checkpoint.id);
  assertEquals(loadResult.ok, true);
  assertEquals(loadResult.value.id, checkpoint.id);
  assertEquals(loadResult.value.name, checkpoint.name);
  
  await tracker.close();
});

Deno.test("Migration Tracker - List Checkpoints", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Create multiple checkpoints
  const checkpoints = [
    {
      id: "checkpoint-001",
      name: "first_checkpoint",
      created_at: new Date("2024-01-01T09:00:00Z"),
      schema_state: { version: "1.0" },
      migration_state: { applied_migrations: [], current_schema_hash: "initial" },
    },
    {
      id: "checkpoint-002",
      name: "second_checkpoint",
      created_at: new Date("2024-01-01T10:00:00Z"),
      schema_state: { version: "1.1" },
      migration_state: { applied_migrations: ["migration-001"], current_schema_hash: "hash123" },
    },
  ];
  
  // Save checkpoints
  for (const checkpoint of checkpoints) {
    await tracker.saveCheckpoint(checkpoint);
  }
  
  // List checkpoints
  const listResult = await tracker.listCheckpoints();
  assertEquals(listResult.ok, true);
  assertEquals(listResult.value.length, 2);
  
  // Verify order (should be newest first)
  assertEquals(listResult.value[0].name, "second_checkpoint");
  assertEquals(listResult.value[1].name, "first_checkpoint");
  
  await tracker.close();
});

Deno.test("Migration Tracker - Get Migration History", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Apply multiple migrations
  const migrations = [
    {
      ...createTestMigration(),
      id: "migration-001",
      name: "create_users",
    },
    {
      ...createTestMigration(),
      id: "migration-002",
      name: "add_posts",
      created_at: new Date("2024-01-01T11:00:00Z"),
    },
  ];
  
  for (const migration of migrations) {
    const result = {
      ...createTestMigrationResult(),
      migration_id: migration.id,
    };
    await tracker.recordMigration(migration, result);
  }
  
  // Get history
  const historyResult = await tracker.getMigrationHistory();
  assertEquals(historyResult.ok, true);
  assertEquals(historyResult.value.length, 2);
  
  // Should be in reverse chronological order
  assertEquals(historyResult.value[0].name, "add_posts");
  assertEquals(historyResult.value[1].name, "create_users");
  
  await tracker.close();
});

Deno.test("Migration Tracker - Get Rollback SQL", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  
  // Record migration with rollback SQL
  await tracker.recordMigration(migration, migrationResult);
  
  // Get rollback SQL
  const rollbackResult = await tracker.getRollbackSQL(migration.id);
  assertEquals(rollbackResult.ok, true);
  assertEquals(rollbackResult.value.length, 1);
  assertEquals(rollbackResult.value[0], "DROP TABLE IF EXISTS user CASCADE;");
  
  await tracker.close();
});

Deno.test("Migration Tracker - Verify Integrity", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Apply some migrations
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  await tracker.recordMigration(migration, migrationResult);
  
  // Verify integrity
  const integrityResult = await tracker.verifyMigrationIntegrity();
  assertEquals(integrityResult.ok, true);
  assertEquals(integrityResult.value, true);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Error Handling - Not Initialized", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  
  const migration = createTestMigration();
  const migrationResult = createTestMigrationResult();
  
  // Try to record migration without initialization
  const recordResult = await tracker.recordMigration(migration, migrationResult);
  assertEquals(recordResult.ok, false);
  assertStringIncludes(recordResult.error.message, "not initialized");
});

Deno.test("Migration Tracker - Error Handling - Migration Not Found", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Try to remove non-existent migration
  const removeResult = await tracker.removeMigration("non-existent-id");
  assertEquals(removeResult.ok, false);
  assertStringIncludes(removeResult.error.message, "not found");
  
  // Try to get rollback SQL for non-existent migration
  const rollbackResult = await tracker.getRollbackSQL("non-existent-id");
  assertEquals(rollbackResult.ok, false);
  assertStringIncludes(rollbackResult.error.message, "not found");
  
  // Try to load non-existent checkpoint
  const loadResult = await tracker.loadCheckpoint("non-existent-checkpoint");
  assertEquals(loadResult.ok, false);
  assertStringIncludes(loadResult.error.message, "not found");
  
  await tracker.close();
});

Deno.test("Migration Tracker - Multiple Migrations", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Apply multiple migrations in sequence
  const migrationIds = ["m001", "m002", "m003"];
  
  for (let i = 0; i < migrationIds.length; i++) {
    const migration = {
      ...createTestMigration(),
      id: migrationIds[i],
      name: `migration_${i + 1}`,
    };
    const result = {
      ...createTestMigrationResult(),
      migration_id: migration.id,
    };
    
    await tracker.recordMigration(migration, result);
  }
  
  // Verify all are applied
  const appliedResult = await tracker.getAppliedMigrations();
  assertEquals(appliedResult.ok, true);
  assertEquals(appliedResult.value.length, 3);
  
  // Verify they're in the correct order
  for (let i = 0; i < migrationIds.length; i++) {
    assertEquals(appliedResult.value[i], migrationIds[i]);
  }
  
  // Remove middle migration (simulate rollback)
  await tracker.removeMigration("m002");
  
  const afterRemovalResult = await tracker.getAppliedMigrations();
  assertEquals(afterRemovalResult.ok, true);
  assertEquals(afterRemovalResult.value.length, 2);
  assertEquals(afterRemovalResult.value.includes("m002"), false);
  
  await tracker.close();
});

Deno.test("Migration Tracker - Concurrent Operations", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test");
  await tracker.initialize();
  
  // Simulate concurrent migration operations
  const operations = [];
  
  for (let i = 0; i < 5; i++) {
    const migration = {
      ...createTestMigration(),
      id: `concurrent-migration-${i}`,
      name: `concurrent_migration_${i}`,
    };
    const result = {
      ...createTestMigrationResult(),
      migration_id: migration.id,
    };
    
    operations.push(tracker.recordMigration(migration, result));
  }
  
  // Wait for all operations to complete
  const results = await Promise.all(operations);
  
  // Verify all succeeded
  for (const result of results) {
    assertEquals(result.ok, true);
  }
  
  // Verify all migrations are recorded
  const appliedResult = await tracker.getAppliedMigrations();
  assertEquals(appliedResult.ok, true);
  assertEquals(appliedResult.value.length, 5);
  
  await tracker.close();
});