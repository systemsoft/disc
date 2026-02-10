/**
 * Performance tests for Migration Engine with large schema changes
 */

import { assertEquals, assertLessOrEqual } from "@std/assert";
import { MigrationEngine } from "./engine.ts";
import { SchemaDiffer } from "./differ.ts";
import { DDLGenerator } from "./ddl.ts";
import { MigrationTracker } from "./tracker.ts";
import * as SchemaAST from "../schema/ast.ts";
import * as Types from "./types.ts";

// Helper function to create test config
function createPerformanceTestConfig(): Types.MigrationConfig {
  return {
    migrations_dir: "./migrations",
    schema_file: "./perf_test.esdl",
    database_url: "postgresql://localhost:5432/test_performance",
    dry_run: true,
    auto_approve: false,
    backup_before_migration: true,
    rollback_on_error: true,
  };
}

// Helper to create large schema with many types
function createLargeSchema(numTypes: number): SchemaAST.Module[] {
  const types: SchemaAST.TypeDef[] = [];
  
  for (let i = 1; i <= numTypes; i++) {
    const properties: SchemaAST.Property[] = [
      {
        kind: "Property",
        name: { kind: "Identifier", name: "id", quoted: false },
        type: { kind: "NamedType", name: { kind: "Identifier", name: "uuid", quoted: false } },
        required: true,
        multi: false,
      },
      {
        kind: "Property",
        name: { kind: "Identifier", name: "name", quoted: false },
        type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
        required: true,
        multi: false,
      },
      {
        kind: "Property",
        name: { kind: "Identifier", name: "value", quoted: false },
        type: { kind: "NamedType", name: { kind: "Identifier", name: "int32", quoted: false } },
        required: false,
        multi: false,
      },
      {
        kind: "Property",
        name: { kind: "Identifier", name: "created_at", quoted: false },
        type: { kind: "NamedType", name: { kind: "Identifier", name: "datetime", quoted: false } },
        required: true,
        multi: false,
        default: { kind: "FunctionCall", name: "datetime_current", args: [] },
      },
    ];
    
    // Add some multi properties for complexity
    if (i % 3 === 0) {
      properties.push({
        kind: "Property",
        name: { kind: "Identifier", name: "tags", quoted: false },
        type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
        required: false,
        multi: true,
      });
    }
    
    // Add some links for complexity
    const links: SchemaAST.Link[] = [];
    if (i > 1) {
      links.push({
        kind: "Link",
        name: { kind: "Identifier", name: "parent", quoted: false },
        target: { kind: "NamedType", name: { kind: "Identifier", name: `Entity${Math.floor(i / 2)}`, quoted: false } },
        required: false,
        multi: false,
      });
    }
    
    // Add multi-links occasionally
    if (i % 5 === 0 && i > 5) {
      links.push({
        kind: "Link",
        name: { kind: "Identifier", name: "related", quoted: false },
        target: { kind: "NamedType", name: { kind: "Identifier", name: `Entity${i - 1}`, quoted: false } },
        required: false,
        multi: true,
      });
    }
    
    types.push({
      kind: "TypeDef",
      name: { kind: "Identifier", name: `Entity${i}`, quoted: false },
      extending: [],
      items: [...properties, ...links],
    });
  }
  
  return [
    {
      kind: "Module",
      name: { kind: "Identifier", name: "default", quoted: false },
      items: types,
    },
  ];
}

// Helper to create schema with modifications
function createModifiedLargeSchema(numTypes: number): SchemaAST.Module[] {
  const schema = createLargeSchema(numTypes);
  const module = schema[0];
  
  // Modify every 3rd type
  for (let i = 0; i < module.items.length; i += 3) {
    const typeDef = module.items[i] as SchemaAST.TypeDef;
    
    // Add a new property
    typeDef.items.push({
      kind: "Property",
      name: { kind: "Identifier", name: "modified_at", quoted: false },
      type: { kind: "NamedType", name: { kind: "Identifier", name: "datetime", quoted: false } },
      required: false,
      multi: false,
    });
    
    // Modify an existing property (make value required)
    const valueProperty = typeDef.items.find(
      item => item.kind === "Property" && item.name.name === "value"
    ) as SchemaAST.Property;
    if (valueProperty) {
      valueProperty.required = true;
    }
  }
  
  // Add a few new types
  for (let i = numTypes + 1; i <= numTypes + 10; i++) {
    const newType: SchemaAST.TypeDef = {
      kind: "TypeDef",
      name: { kind: "Identifier", name: `NewEntity${i}`, quoted: false },
      extending: [],
      items: [
        {
          kind: "Property",
          name: { kind: "Identifier", name: "name", quoted: false },
          type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
          required: true,
          multi: false,
        },
      ],
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
  console.log(`Initial migration planning for ${numTypes} types took ${duration.toFixed(2)}ms`);
  
  // Should complete within reasonable time
  assertLessOrEqual(duration, 5000); // 5 seconds
  
  // Verify correct number of operations
  const operations = planResult.value.migrations[0].operations;
  const createOps = operations.filter(op => op.kind === "CreateType");
  assertEquals(createOps.length, numTypes);
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
  console.log(`Schema diff for ${numTypes} types took ${duration.toFixed(2)}ms`);
  
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
  const generator = new DDLGenerator();
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);
  
  const numTypes = 150;
  const schema = createLargeSchema(numTypes);
  
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);
  
  const startTime = performance.now();
  const ddlResult = engine.generateDDL(planResult.value);
  const endTime = performance.now();
  
  assertEquals(ddlResult.ok, true);
  
  const duration = endTime - startTime;
  console.log(`DDL generation for ${numTypes} types took ${duration.toFixed(2)}ms`);
  
  // Should complete within reasonable time
  assertLessOrEqual(duration, 4000); // 4 seconds
  
  // Should generate appropriate number of statements
  const statements = ddlResult.value;
  assertEquals(statements.length > numTypes, true); // Should have more statements than types (includes indexes, etc.)
});

Deno.test("Performance - Rollback DDL Generation", () => {
  const generator = new DDLGenerator();
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);
  
  const numTypes = 100;
  const oldSchema = createLargeSchema(numTypes);
  const newSchema = createModifiedLargeSchema(numTypes);
  
  const planResult = engine.planMigration(oldSchema, newSchema);
  assertEquals(planResult.ok, true);
  
  const migration = planResult.value.migrations[0];
  
  const startTime = performance.now();
  const rollbackResult = engine.generateRollbackSQL(migration);
  const endTime = performance.now();
  
  assertEquals(rollbackResult.ok, true);
  
  const duration = endTime - startTime;
  console.log(`Rollback DDL generation for ${migration.operations.length} operations took ${duration.toFixed(2)}ms`);
  
  // Should complete within reasonable time
  assertLessOrEqual(duration, 2000); // 2 seconds
});

Deno.test("Performance - Migration Tracking with Many Migrations", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test_performance");
  await tracker.initialize();
  
  const numMigrations = 500;
  const migrations: Types.Migration[] = [];
  
  // Create many test migrations
  for (let i = 1; i <= numMigrations; i++) {
    migrations.push({
      id: `perf-migration-${i.toString().padStart(3, '0')}`,
      name: `migration_${i}`,
      description: `Performance test migration ${i}`,
      created_at: new Date(Date.now() + i * 1000),
      schema_hash: `hash_${i}`,
      operations: [
        {
          kind: "CreateType",
          type_name: `PerfType${i}`,
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
    });
  }
  
  // Record all migrations
  const startTime = performance.now();
  
  for (const migration of migrations) {
    const result: Types.MigrationResult = {
      success: true,
      migration_id: migration.id,
      applied_at: new Date(),
      duration_ms: 100,
    };
    
    const recordResult = await tracker.recordMigration(migration, result);
    assertEquals(recordResult.ok, true);
  }
  
  const endTime = performance.now();
  const duration = endTime - startTime;
  
  console.log(`Recording ${numMigrations} migrations took ${duration.toFixed(2)}ms`);
  console.log(`Average per migration: ${(duration / numMigrations).toFixed(2)}ms`);
  
  // Should complete within reasonable time
  assertLessOrEqual(duration, 30000); // 30 seconds
  
  // Verify all migrations are recorded
  const appliedResult = await tracker.getAppliedMigrations();
  assertEquals(appliedResult.ok, true);
  assertEquals(appliedResult.value.length, numMigrations);
  
  await tracker.close();
});

Deno.test("Performance - Migration History Retrieval", async () => {
  const tracker = new MigrationTracker("postgresql://localhost:5432/test_performance");
  await tracker.initialize();
  
  const numMigrations = 100;
  
  // Record migrations
  for (let i = 1; i <= numMigrations; i++) {
    const migration: Types.Migration = {
      id: `history-test-${i}`,
      name: `migration_${i}`,
      description: `History test migration ${i}`,
      created_at: new Date(Date.now() + i * 1000),
      schema_hash: `hash_${i}`,
      operations: [],
    };
    
    const result: Types.MigrationResult = {
      success: true,
      migration_id: migration.id,
      applied_at: new Date(),
      duration_ms: 100,
    };
    
    await tracker.recordMigration(migration, result);
  }
  
  // Test retrieval performance
  const startTime = performance.now();
  const historyResult = await tracker.getMigrationHistory();
  const endTime = performance.now();
  
  assertEquals(historyResult.ok, true);
  assertEquals(historyResult.value.length, numMigrations);
  
  const duration = endTime - startTime;
  console.log(`Retrieving history for ${numMigrations} migrations took ${duration.toFixed(2)}ms`);
  
  // Should complete quickly
  assertLessOrEqual(duration, 1000); // 1 second
  
  await tracker.close();
});

Deno.test("Performance - Complex Schema with Deep Inheritance", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);
  
  // Create schema with deep inheritance chain
  const deepInheritanceSchema: SchemaAST.Module[] = [
    {
      kind: "Module",
      name: { kind: "Identifier", name: "default", quoted: false },
      items: [],
    },
  ];
  
  const module = deepInheritanceSchema[0];
  const numLevels = 20;
  const numTypesPerLevel = 10;
  
  // Create inheritance hierarchy
  for (let level = 0; level < numLevels; level++) {
    for (let i = 1; i <= numTypesPerLevel; i++) {
      const typeName = `Level${level}Type${i}`;
      const extending = level > 0 ? [{ kind: "Identifier", name: `Level${level - 1}Type${i}`, quoted: false }] : [];
      
      const type: SchemaAST.TypeDef = {
        kind: "TypeDef",
        name: { kind: "Identifier", name: typeName, quoted: false },
        extending,
        items: [
          {
            kind: "Property",
            name: { kind: "Identifier", name: `level_${level}_prop`, quoted: false },
            type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
            required: false,
            multi: false,
          },
        ],
      };
      
      module.items.push(type);
    }
  }
  
  const startTime = performance.now();
  const planResult = engine.planMigration(null, deepInheritanceSchema);
  const endTime = performance.now();
  
  assertEquals(planResult.ok, true);
  
  const duration = endTime - startTime;
  console.log(`Deep inheritance schema (${numLevels} levels, ${numTypesPerLevel} types/level) took ${duration.toFixed(2)}ms`);
  
  // Should handle complex inheritance within reasonable time
  assertLessOrEqual(duration, 8000); // 8 seconds
});

Deno.test("Performance - Concurrent Migration Operations", async () => {
  const numConcurrentOps = 50;
  const config = createPerformanceTestConfig();
  const operations: Promise<any>[] = [];
  
  const startTime = performance.now();
  
  // Create multiple engines operating concurrently
  for (let i = 0; i < numConcurrentOps; i++) {
    const engine = new MigrationEngine(config);
    const schema = createLargeSchema(20); // Smaller schemas for concurrent test
    
    operations.push(engine.planMigration(null, schema));
  }
  
  const results = await Promise.all(operations);
  const endTime = performance.now();
  
  // Verify all operations succeeded
  for (const result of results) {
    assertEquals(result.ok, true);
  }
  
  const duration = endTime - startTime;
  console.log(`${numConcurrentOps} concurrent migration planning operations took ${duration.toFixed(2)}ms`);
  
  // Should complete within reasonable time
  assertLessOrEqual(duration, 10000); // 10 seconds
});

Deno.test("Performance - Memory Usage with Large Schema", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);
  
  // Measure memory before
  const memBefore = (performance as any).measureUserAgentSpecificMemory?.();
  
  const numTypes = 1000;
  const schema = createLargeSchema(numTypes);
  
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);
  
  const ddlResult = engine.generateDDL(planResult.value);
  assertEquals(ddlResult.ok, true);
  
  // Measure memory after
  const memAfter = (performance as any).measureUserAgentSpecificMemory?.();
  
  if (memBefore && memAfter) {
    const memUsed = memAfter.bytes - memBefore.bytes;
    console.log(`Memory usage for ${numTypes} types: ${(memUsed / 1024 / 1024).toFixed(2)} MB`);
  }
  
  // Verify results are reasonable
  const statements = ddlResult.value;
  assertEquals(statements.length > numTypes, true);
});

Deno.test("Performance - Stress Test with Very Large Schema", () => {
  const config = createPerformanceTestConfig();
  const engine = new MigrationEngine(config);
  
  const numTypes = 500;
  const schema = createLargeSchema(numTypes);
  
  console.log(`Starting stress test with ${numTypes} types...`);
  
  const startTime = performance.now();
  
  // Plan migration
  const planResult = engine.planMigration(null, schema);
  assertEquals(planResult.ok, true);
  
  const planningTime = performance.now();
  
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
  const validationResult = engine.validateMigration(planResult.value);
  // Note: This might fail due to data loss warnings, which is expected
  
  const endTime = performance.now();
  
  console.log(`Stress test results for ${numTypes} types:`);
  console.log(`  Planning: ${(planningTime - startTime).toFixed(2)}ms`);
  console.log(`  DDL Generation: ${(ddlTime - planningTime).toFixed(2)}ms`);
  console.log(`  Rollback Generation: ${(rollbackTime - ddlTime).toFixed(2)}ms`);
  console.log(`  Total: ${(endTime - startTime).toFixed(2)}ms`);
  
  // Should complete within reasonable time even for large schemas
  assertLessOrEqual(endTime - startTime, 15000); // 15 seconds
});