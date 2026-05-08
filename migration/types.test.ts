/**
 * Migration types module tests
 */

import { assertEquals, assertExists } from "@std/assert";
import { Result } from "../lib/result.ts";
import * as Types from "./types.ts";

Deno.test("MigrationConfig - default values", () => {
  const config: Types.MigrationConfig = {
    migrationsDir: "./migrations",
    schemaFile: "./schema.disc",
    databaseUrl: "postgresql://localhost:5432/disc_dev",
    dryRun: false,
    autoApprove: false,
    backupBeforeMigration: true,
    rollbackOnError: true
  };

  assertEquals(config.migrationsDir, "./migrations");
  assertEquals(config.dryRun, false);
  assertEquals(config.autoApprove, false);
  assertEquals(config.backupBeforeMigration, true);
  assertEquals(config.rollbackOnError, true);
});

Deno.test("MigrationState - structure", () => {
  const state: Types.MigrationState = {
    appliedMigrations: ["migration-001"],
    currentSchemaHash: "abc123",
    lastMigrationId: "migration-001"
  };

  assertEquals(state.appliedMigrations.length, 1);
  assertEquals(state.currentSchemaHash, "abc123");
  assertEquals(state.lastMigrationId, "migration-001");
});

Deno.test("MigrationPlan - structure", () => {
  const plan: Types.MigrationPlan = {
    migrations: [
      {
        id: "test-migration",
        name: "Initial schema",
        description: "Create initial types",
        createdAt: new Date(),
        schemaHash: "hash123",
        operations: [
          {
            kind: "CreateType",
            typeName: "User",
            properties: [],
            links: []
          } as Types.CreateTypeOperation
        ]
      }
    ],
    targetSchemaHash: "hash123",
    operationsCount: 1,
    estimatedDuration: 100
  };

  assertEquals(plan.migrations.length, 1);
  assertEquals(plan.operationsCount, 1);
  assertEquals(plan.estimatedDuration, 100);
  assertEquals(plan.migrations[0].operations[0].kind, "CreateType");
});

Deno.test("CreateTypeOperation - structure", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: ["min_length(1)"],
        annotations: { description: "User name" }
      }
    ],
    links: [
      {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        annotations: {}
      }
    ]
  };

  assertEquals(operation.kind, "CreateType");
  assertEquals(operation.typeName, "User");
  assertEquals(operation.properties.length, 1);
  assertEquals(operation.links.length, 1);
  assertEquals(operation.properties[0].constraints.length, 1);
});

Deno.test("AlterTypeOperation - structure", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    typeName: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "email",
          type: "str",
          required: true,
          multi: false,
          constraints: ["exclusive"],
          annotations: {}
        }
      } as Types.AddPropertyOperation,
      {
        kind: "DropProperty",
        propertyName: "old_field"
      } as Types.DropPropertyOperation
    ]
  };

  assertEquals(operation.kind, "AlterType");
  assertEquals(operation.typeName, "User");
  assertEquals(operation.operations.length, 2);
  assertEquals(operation.operations[0].kind, "AddProperty");
  assertEquals(operation.operations[1].kind, "DropProperty");
});

Deno.test("DropTypeOperation - structure", () => {
  const operation: Types.DropTypeOperation = {
    kind: "DropType",
    typeName: "ObsoleteType"
  };

  assertEquals(operation.kind, "DropType");
  assertEquals(operation.typeName, "ObsoleteType");
});

Deno.test("PropertyDefinition - all fields", () => {
  const property: Types.PropertyDefinition = {
    name: "createdAt",
    type: "datetime",
    required: false,
    multi: false,
    default: "datetime_current()",
    constraints: ["readonly"],
    annotations: {
      description: "Creation timestamp",
      computed: true
    }
  };

  assertEquals(property.name, "createdAt");
  assertEquals(property.type, "datetime");
  assertEquals(property.required, false);
  assertEquals(property.multi, false);
  assertEquals(property.default, "datetime_current()");
  assertEquals(property.constraints.length, 1);
  assertEquals(property.constraints[0], "readonly");
  assertEquals(property.annotations.description, "Creation timestamp");
  assertEquals(property.annotations.computed, true);
});

Deno.test("LinkDefinition - single and multi links", () => {
  const singleLink: Types.LinkDefinition = {
    name: "author",
    target: "User",
    required: true,
    multi: false,
    annotations: {}
  };

  const multiLink: Types.LinkDefinition = {
    name: "tags",
    target: "Tag",
    required: false,
    multi: true,
    annotations: {
      description: "Associated tags",
      onDelete: "restrict"
    }
  };

  assertEquals(singleLink.multi, false);
  assertEquals(singleLink.required, true);

  assertEquals(multiLink.multi, true);
  assertEquals(multiLink.required, false);
  assertEquals(multiLink.annotations.onDelete, "restrict");
});

Deno.test("MigrationResult - success case", () => {
  const result: Types.MigrationResult = {
    migrationId: "migration-001",
    success: true,
    durationMs: 250,
    appliedAt: new Date()
  };

  assertEquals(result.success, true);
  assertEquals(result.durationMs, 250);
  assertExists(result.appliedAt);
});

Deno.test("MigrationResult - failure case", () => {
  const result: Types.MigrationResult = {
    migrationId: "migration-002",
    success: false,
    durationMs: 100,
    appliedAt: new Date(),
    error: "Constraint violation: duplicate key"
  };

  assertEquals(result.success, false);
  assertEquals(result.error, "Constraint violation: duplicate key");
});

Deno.test("AddPropertyOperation - structure", () => {
  const operation: Types.AddPropertyOperation = {
    kind: "AddProperty",
    property: {
      name: "status",
      type: "str",
      required: false,
      multi: false,
      default: "active",
      constraints: ["enum('active', 'inactive', 'pending')"],
      annotations: { description: "User status" }
    }
  };

  assertEquals(operation.kind, "AddProperty");
  assertEquals(operation.property.default, "active");
  assertEquals(operation.property.constraints.length, 1);
});

Deno.test("DropPropertyOperation - structure", () => {
  const operation: Types.DropPropertyOperation = {
    kind: "DropProperty",
    propertyName: "deprecated_field"
  };

  assertEquals(operation.kind, "DropProperty");
  assertEquals(operation.propertyName, "deprecated_field");
});

Deno.test("AlterPropertyOperation - structure", () => {
  const operation: Types.AlterPropertyOperation = {
    kind: "AlterProperty",
    propertyName: "email",
    changes: [
      {
        kind: "ChangeRequired",
        oldValue: false,
        newValue: true
      },
      {
        kind: "AddConstraint",
        newValue: "exclusive"
      },
      {
        kind: "DropConstraint",
        oldValue: "min_length(3)"
      }
    ]
  };

  assertEquals(operation.kind, "AlterProperty");
  assertEquals(operation.propertyName, "email");
  assertEquals(operation.changes.length, 3);
  assertEquals(operation.changes[0].kind, "ChangeRequired");
  assertEquals(operation.changes[1].kind, "AddConstraint");
  assertEquals(operation.changes[2].kind, "DropConstraint");
});

Deno.test("MigrationOperation - discriminated union", () => {
  const operations: Types.MigrationOperation[] = [
    {
      kind: "CreateType",
      typeName: "User",
      properties: [],
      links: []
    } as Types.CreateTypeOperation,
    { kind: "DropType", typeName: "OldType" } as Types.DropTypeOperation,
    {
      kind: "AlterType",
      typeName: "User",
      operations: []
    } as Types.AlterTypeOperation
  ];

  assertEquals(operations[0].kind, "CreateType");
  assertEquals(operations[1].kind, "DropType");
  assertEquals(operations[2].kind, "AlterType");

  // TypeScript should properly discriminate the union
  const op0 = operations[0] as Types.CreateTypeOperation;
  assertExists(op0.properties);
  assertExists(op0.links);

  const op1 = operations[1] as Types.DropTypeOperation;
  assertExists(op1.typeName);

  const op2 = operations[2] as Types.AlterTypeOperation;
  assertExists(op2.operations);
});

Deno.test("Result type - success and error cases", () => {
  const successResult: Result<string, Error> = {
    ok: true,
    value: "success"
  };

  const errorResult: Result<string, Error> = {
    ok: false,
    error: new Error("Something went wrong")
  };

  assertEquals(successResult.ok, true);
  if (successResult.ok) {
    assertEquals(successResult.value, "success");
  }

  assertEquals(errorResult.ok, false);
  if (!errorResult.ok) {
    assertEquals(errorResult.error.message, "Something went wrong");
  }
});
