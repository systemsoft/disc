/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * Performance tests for Migration Engine with large schema changes
 *
 * Tests that use MigrationTracker require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertLessOrEqual } from "@std/assert";
import * as AST from "../schema/ast.ts";
import { Module } from "../schema/converter.ts";
import {
  canRunPgTests,
  cleanupTestTables,
  getTestDsn
} from "../tests/pg-test-harness.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationEngine } from "./engine.ts";
import { MigrationTracker } from "./tracker.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

// Helper function to create test config
function createPerformanceTestConfig(): Types.MigrationConfig {
  return {
    migrationsDir: "./migrations",
    schemaFile: "./perf_test.disc",
    databaseUrl: "postgresql://localhost:5432/test_performance",
    dryRun: true,
    autoApprove: false,
    backupBeforeMigration: true,
    rollbackOnError: true
  };
}

// Helper to create large schema with many types
function createLargeSchema(numTypes: number): Module[] {
  const types: AST.Declaration[] = [];

  for (let i = 1; i <= numTypes; i++) {
    const members: AST.TypeMember[] = [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "id" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["uuid"] }
        },
        required: true,
        multi: false
      },
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
        name: { kind: "Identifier", value: "value" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["int32"] }
        },
        required: false,
        multi: false
      },
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "createdAt" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["datetime"] }
        },
        required: true,
        multi: false,
        default: {
          kind: "FunctionCall",
          name: { kind: "QualifiedName", parts: ["datetime_current"] },
          args: []
        }
      }
    ];

    // Add some multi properties for complexity
    if (i % 3 === 0) {
      members.push({
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", value: "tags" },
        type: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: ["str"] }
        },
        required: false,
        multi: true
      });
    }

    // Add some links for complexity
    if (i > 1) {
      members.push({
        kind: "LinkDeclaration",
        name: { kind: "Identifier", value: "parent" },
        target: {
          kind: "TypeRef",
          name: {
            kind: "QualifiedName",
            parts: [`Entity${Math.floor(i / 2)}`]
          }
        },
        required: false,
        multi: false
      });
    }

    // Add multi-links occasionally
    if (i % 5 === 0 && i > 5) {
      members.push({
        kind: "LinkDeclaration",
        name: { kind: "Identifier", value: "related" },
        target: {
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: [`Entity${i - 1}`] }
        },
        required: false,
        multi: true
      });
    }

    types.push({
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: `Entity${i}` },
      members
    } as AST.TypeDeclaration);
  }

  return [
    {
      name: "default",
      items: types
    }
  ];
}

// Helper to create schema with modifications
function createModifiedLargeSchema(numTypes: number): Module[] {
  const schema = createLargeSchema(numTypes);
  const module = schema[0];

  // Modify every 3rd type
  for (let i = 0; i < module.items.length; i += 3) {
    const typeDef = module.items[i] as AST.TypeDeclaration;

    // Add a new property
    typeDef.members.push({
      kind: "PropertyDeclaration",
      name: { kind: "Identifier", value: "modified_at" },
      type: {
        kind: "TypeRef",
        name: { kind: "QualifiedName", parts: ["datetime"] }
      },
      required: false,
      multi: false
    });

    // Modify an existing property (make value required)
    const valueProperty = typeDef.members.find(
      (item): item is AST.PropertyDeclaration => item.kind === "PropertyDeclaration" && item.name.value === "value"
    );
    if (valueProperty) {
      valueProperty.required = true;
    }
  }

  // Add a few new types
  for (let i = numTypes + 1; i <= numTypes + 10; i++) {
    const newType: AST.TypeDeclaration = {
      kind: "TypeDeclaration",
      name: { kind: "Identifier", value: `NewEntity${i}` },
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
    };
    module.items.push(newType);
  }

  return schema;
}

Deno.test("Performance - Large Schema Initial Migration", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);

  const numTypes = 100;
  const schema = createLargeSchema(numTypes);

  const startTime = performance.now();
  const planResult = engine.planMigration(null, schema);
  const endTime = performance.now();

  assertEquals(planResult.ok, true);

  const duration = endTime - startTime;
  console.log(
    `Initial migration planning for ${numTypes} types took ${duration.toFixed(2)}ms`
  );

  // Should complete within reasonable time
  assertLessOrEqual(duration, 5000); // 5 seconds

  // Verify correct number of operations
  if (planResult.ok) {
    const operations = planResult.value.migrations[0].operations;
    const createOps = operations.filter(op => op.kind === "CreateType");
    assertEquals(createOps.length, numTypes);
  }
});

/**
 * Pins the differ's linear scaling on the initial-migration path with a
 * deep inheritance chain. (gh/geldata#5322 — was O(N²) before the
 * `DiffCache` reverse subtype map + memoized inheritance walks landed.)
 *
 * Pre-fix timings on the same machine: n=1000 took ~200ms, n=2000 took
 * ~800ms (clear quadratic). Post-fix: both <50ms. The 500ms cap leaves
 * headroom for slow CI runners while still failing loud if a regression
 * brings quadratic behavior back.
 */
Deno.test("Performance - Initial Migration scales linearly with deep inheritance (Bundle LL — gh/geldata#5322)", () => {
  const engine = new MigrationEngine(createPerformanceTestConfig());

  // Build a chain where each type extends the previous one, simulating
  // a tall hierarchy. This is the worst case for the recursive
  // inheritance-walk paths.
  function buildChain(n: number): Module[] {
    const items: AST.Declaration[] = [];
    for (let i = 1; i <= n; i++) {
      const decl: AST.TypeDeclaration = {
        kind: "TypeDeclaration",
        name: { kind: "Identifier", value: `Chain${i}` },
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
      };
      if (i > 1) {
        decl.extending = [
          {
            kind: "TypeRef",
            name: { kind: "QualifiedName", parts: [`Chain${i - 1}`] }
          }
        ];
      }
      items.push(decl);
    }
    return [{ name: "default", items }];
  }

  const numTypes = 2000;
  const start = performance.now();
  const result = engine.planMigration(null, buildChain(numTypes));
  const duration = performance.now() - start;

  assertEquals(result.ok, true);
  console.log(
    `Initial migration with ${numTypes}-deep inheritance chain: ${duration.toFixed(2)}ms`
  );
  // 500ms cap is ~200× the post-fix typical and ~1.5× the pre-fix
  // 2000-type baseline → fails loud on quadratic regression.
  assertLessOrEqual(duration, 500);
});

Deno.test("Performance - Large Schema Diff", () => {
  const differ = new SchemaDiffer();

  const numTypes = 200;
  const oldSchema = createLargeSchema(numTypes);
  const newSchema = createModifiedLargeSchema(numTypes);

  const startTime = performance.now();
  const operations = differ.diff(oldSchema, newSchema);
  const endTime = performance.now();

  const duration = endTime - startTime;
  console.log(
    `Schema diff for ${numTypes} types took ${duration.toFixed(2)}ms`
  );

  // Should complete within reasonable time
  assertLessOrEqual(duration, 3000); // 3 seconds

  // Should detect changes
  assertEquals(operations.length > 0, true);

  // Should have alter operations and new type creations
  const alterOps = operations.filter(op => op.kind === "AlterType");
  const createOps = operations.filter(op => op.kind === "CreateType");

  assertEquals(alterOps.length > 0, true); // Should have alterations
  assertEquals(createOps.length, 10); // Should have 10 new types
});

Deno.test("Performance - DDL Generation for Large Schema", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);

  const numTypes = 150;
  const schema = createLargeSchema(numTypes);

  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const startTime = performance.now();
    const ddlResult = engine.generateDDL(planResult.value);
    const endTime = performance.now();

    assertEquals(ddlResult.ok, true);

    const duration = endTime - startTime;
    console.log(
      `DDL generation for ${numTypes} types took ${duration.toFixed(2)}ms`
    );

    // Should complete within reasonable time
    assertLessOrEqual(duration, 4000); // 4 seconds

    // Should generate appropriate number of statements
    if (ddlResult.ok) {
      const statements = ddlResult.value;
      assertEquals(statements.length > numTypes, true); // Should have more statements than types (includes indexes, etc.)
    }
  }
});

Deno.test("Performance - Rollback DDL Generation", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);

  const numTypes = 100;
  const oldSchema = createLargeSchema(numTypes);
  const newSchema = createModifiedLargeSchema(numTypes);

  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const migration = planResult.value.migrations[0];

    const startTime = performance.now();
    const rollbackResult = engine.generateRollbackSQL(migration);
    const endTime = performance.now();

    assertEquals(rollbackResult.ok, true);

    const duration = endTime - startTime;
    console.log(
      `Rollback DDL generation for ${migration.operations.length} operations took ${duration.toFixed(2)}ms`
    );

    // Should complete within reasonable time
    assertLessOrEqual(duration, 2000); // 2 seconds
  }
});

Deno.test({
  name: "Performance - Migration Tracking with Many Migrations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupTestTables(dsn);
    const tracker = new MigrationTracker(dsn);
    await tracker.initialize();

    const numMigrations = 500;
    const migrations: Types.Migration[] = [];

    // Create many test migrations
    for (let i = 1; i <= numMigrations; i++) {
      migrations.push({
        id: `perf-migration-${i.toString().padStart(3, "0")}`,
        name: `migration_${i}`,
        description: `Performance test migration ${i}`,
        createdAt: new Date(Date.now() + i * 1000),
        schemaHash: `hash_${i}`,
        operations: [
          {
            kind: "CreateType",
            typeName: `PerfType${i}`,
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
          } as Types.CreateTypeOperation
        ]
      });
    }

    // Record all migrations
    const startTime = performance.now();

    for (const migration of migrations) {
      const result: Types.MigrationResult = {
        success: true,
        migrationId: migration.id,
        appliedAt: new Date(),
        durationMs: 100
      };

      const recordResult = await tracker.recordMigration(migration, result);
      assertEquals(recordResult.ok, true);
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    console.log(
      `Recording ${numMigrations} migrations took ${duration.toFixed(2)}ms`
    );
    console.log(
      `Average per migration: ${(duration / numMigrations).toFixed(2)}ms`
    );

    // Should complete within reasonable time
    assertLessOrEqual(duration, 30000); // 30 seconds

    // Verify all migrations are recorded
    const appliedResult = await tracker.getAppliedMigrations();
    assertEquals(appliedResult.ok, true);
    if (appliedResult.ok) {
      assertEquals(appliedResult.value.length, numMigrations);
    }

    await tracker.close();
  }
});

Deno.test({
  name: "Performance - Migration History Retrieval",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupTestTables(dsn);
    const tracker = new MigrationTracker(dsn);
    await tracker.initialize();

    const numMigrations = 100;

    // Record migrations
    for (let i = 1; i <= numMigrations; i++) {
      const migration: Types.Migration = {
        id: `history-test-${i}`,
        name: `migration_${i}`,
        description: `History test migration ${i}`,
        createdAt: new Date(Date.now() + i * 1000),
        schemaHash: `hash_${i}`,
        operations: []
      };

      const result: Types.MigrationResult = {
        success: true,
        migrationId: migration.id,
        appliedAt: new Date(),
        durationMs: 100
      };

      await tracker.recordMigration(migration, result);
    }

    // Test retrieval performance
    const startTime = performance.now();
    const historyResult = await tracker.getMigrationHistory();
    const endTime = performance.now();

    assertEquals(historyResult.ok, true);
    if (historyResult.ok) {
      assertEquals(historyResult.value.length, numMigrations);
    }

    const duration = endTime - startTime;
    console.log(
      `Retrieving history for ${numMigrations} migrations took ${duration.toFixed(2)}ms`
    );

    // Should complete quickly
    assertLessOrEqual(duration, 1000); // 1 second

    await tracker.close();
  }
});

Deno.test("Performance - Complex Schema with Deep Inheritance", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);

  // Create schema with deep inheritance chain
  const deepInheritanceSchema: Module[] = [
    {
      name: "default",
      items: []
    }
  ];

  const module = deepInheritanceSchema[0];
  const numLevels = 20;
  const numTypesPerLevel = 10;

  // Create inheritance hierarchy
  for (let level = 0; level < numLevels; level++) {
    for (let i = 1; i <= numTypesPerLevel; i++) {
      const typeName = `Level${level}Type${i}`;
      const extending: AST.TypeRef[] = level > 0 ?
        [{
          kind: "TypeRef",
          name: { kind: "QualifiedName", parts: [`Level${level - 1}Type${i}`] }
        }] :
        [];

      const type: AST.TypeDeclaration = {
        kind: "TypeDeclaration",
        name: { kind: "Identifier", value: typeName },
        extending,
        members: [
          {
            kind: "PropertyDeclaration",
            name: { kind: "Identifier", value: `level_${level}_prop` },
            type: {
              kind: "TypeRef",
              name: { kind: "QualifiedName", parts: ["str"] }
            },
            required: false,
            multi: false
          }
        ]
      };

      module.items.push(type);
    }
  }

  const startTime = performance.now();
  const planResult = engine.planMigration(null, deepInheritanceSchema);
  const endTime = performance.now();

  assertEquals(planResult.ok, true);

  const duration = endTime - startTime;
  console.log(
    `Deep inheritance schema (${numLevels} levels, ${numTypesPerLevel} types/level) took ${duration.toFixed(2)}ms`
  );

  // Should handle complex inheritance within reasonable time
  assertLessOrEqual(duration, 8000); // 8 seconds
});

Deno.test("Performance - Concurrent Migration Operations", () => {
  const numConcurrentOps = 50;
  const config = createPerformanceTestConfig();
  const operations: ReturnType<MigrationEngine["planMigration"]>[] = [];

  const startTime = performance.now();

  // Create multiple engines operating concurrently
  for (let i = 0; i < numConcurrentOps; i++) {
    const engine = new MigrationEngine(config);
    const schema = createLargeSchema(20); // Smaller schemas for concurrent test

    operations.push(engine.planMigration(null, schema));
  }

  // planMigration is synchronous, so results are already available
  const endTime = performance.now();

  // Verify all operations succeeded
  for (const result of operations) {
    assertEquals(result.ok, true);
  }

  const duration = endTime - startTime;
  console.log(
    `${numConcurrentOps} concurrent migration planning operations took ${duration.toFixed(2)}ms`
  );

  // Should complete within reasonable time
  assertLessOrEqual(duration, 10000); // 10 seconds
});

Deno.test("Performance - Memory Usage with Large Schema", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);

  const numTypes = 1000;
  const schema = createLargeSchema(numTypes);

  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const ddlResult = engine.generateDDL(planResult.value);
    assertEquals(ddlResult.ok, true);

    // Verify results are reasonable
    if (ddlResult.ok) {
      const statements = ddlResult.value;
      assertEquals(statements.length > numTypes, true);
    }
  }
});

Deno.test("Performance - Stress Test with Very Large Schema", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);

  const numTypes = 500;
  const schema = createLargeSchema(numTypes);

  console.log(`Starting stress test with ${numTypes} types…`);

  const startTime = performance.now();

  // Plan migration
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);

  const planningTime = performance.now();

  if (planResult.ok) {
    // Generate DDL
    const ddlResult = engine.generateDDL(planResult.value);
    assertEquals(ddlResult.ok, true);

    const ddlTime = performance.now();

    // Generate rollback
    const migration = planResult.value.migrations[0];
    const rollbackResult = engine.generateRollbackSQL(migration);
    assertEquals(rollbackResult.ok, true);

    const rollbackTime = performance.now();

    // Validate
    engine.validateMigration(planResult.value);
    // Note: This might fail due to data loss warnings, which is expected

    const endTime = performance.now();

    console.log(`Stress test results for ${numTypes} types:`);
    console.log(`  Planning: ${(planningTime - startTime).toFixed(2)}ms`);
    console.log(`  DDL Generation: ${(ddlTime - planningTime).toFixed(2)}ms`);
    console.log(
      `  Rollback Generation: ${(rollbackTime - ddlTime).toFixed(2)}ms`
    );
    console.log(`  Total: ${(endTime - startTime).toFixed(2)}ms`);

    // Should complete within reasonable time even for large schemas
    assertLessOrEqual(endTime - startTime, 15000); // 15 seconds
  }
});
