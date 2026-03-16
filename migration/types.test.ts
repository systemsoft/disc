/**
 * Migration types module tests
 */

import { assertEquals, assertExists } from "@std/assert";
import * as Types from "./types.ts";
import { Result } from "../lib/result.ts";

Deno.test("MigrationConfig - default values", () => {
  const config: Types.MigrationConfig = {
    migrations_dir: "./migrations",
    schema_file: "./schema.esdl",
    database_url: "postgresql://localhost:5432/disc_dev",
    dry_run: false,
    auto_approve: false,
    backup_before_migration: true,
    rollback_on_error: true,
  };

  assertEquals(config.migrations_dir, "./migrations");
  assertEquals(config.dry_run, false);
  assertEquals(config.auto_approve, false);
  assertEquals(config.backup_before_migration, true);
  assertEquals(config.rollback_on_error, true);
});

Deno.test("MigrationState - structure", () => {
  const state: Types.MigrationState = {
    applied_migrations: ["migration-001"],
    current_schema_hash: "abc123",
    last_migration_id: "migration-001",
  };

  assertEquals(state.applied_migrations.length, 1);
  assertEquals(state.current_schema_hash, "abc123");
  assertEquals(state.last_migration_id, "migration-001");
});

Deno.test("MigrationPlan - structure", () => {
  const plan: Types.MigrationPlan = {
    migrations: [
      {
        id: "test-migration",
        name: "Initial schema",
        description: "Create initial types",
        created_at: new Date(),
        schema_hash: "hash123",
        operations: [
          {
            kind: "CreateType",
            type_name: "User",
            properties: [],
            links: [],
          } as Types.CreateTypeOperation,
        ],
      },
    ],
    target_schema_hash: "hash123",
    operations_count: 1,
    estimated_duration: 100,
  };

  assertEquals(plan.migrations.length, 1);
  assertEquals(plan.operations_count, 1);
  assertEquals(plan.estimated_duration, 100);
  assertEquals(plan.migrations[0].operations[0].kind, "CreateType");
});

Deno.test("CreateTypeOperation - structure", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    type_name: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: ["min_length(1)"],
        annotations: { description: "User name" },
      },
    ],
    links: [
      {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        annotations: {},
      },
    ],
  };

  assertEquals(operation.kind, "CreateType");
  assertEquals(operation.type_name, "User");
  assertEquals(operation.properties.length, 1);
  assertEquals(operation.links.length, 1);
  assertEquals(operation.properties[0].constraints.length, 1);
});

Deno.test("AlterTypeOperation - structure", () => {
  const operation: Types.AlterTypeOperation = {
    kind: "AlterType",
    type_name: "User",
    operations: [
      {
        kind: "AddProperty",
        property: {
          name: "email",
          type: "str",
          required: true,
          multi: false,
          constraints: ["exclusive"],
          annotations: {},
        },
      } as Types.AddPropertyOperation,
      {
        kind: "DropProperty",
        property_name: "old_field",
      } as Types.DropPropertyOperation,
    ],
  };

  assertEquals(operation.kind, "AlterType");
  assertEquals(operation.type_name, "User");
  assertEquals(operation.operations.length, 2);
  assertEquals(operation.operations[0].kind, "AddProperty");
  assertEquals(operation.operations[1].kind, "DropProperty");
});

Deno.test("DropTypeOperation - structure", () => {
  const operation: Types.DropTypeOperation = {
    kind: "DropType",
    type_name: "ObsoleteType",
  };

  assertEquals(operation.kind, "DropType");
  assertEquals(operation.type_name, "ObsoleteType");
});

Deno.test("PropertyDefinition - all fields", () => {
  const property: Types.PropertyDefinition = {
    name: "created_at",
    type: "datetime",
    required: false,
    multi: false,
    default: "datetime_current()",
    constraints: ["readonly"],
    annotations: {
      description: "Creation timestamp",
      computed: true,
    },
  };

  assertEquals(property.name, "created_at");
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
    annotations: {},
  };

  const multiLink: Types.LinkDefinition = {
    name: "tags",
    target: "Tag",
    required: false,
    multi: true,
    annotations: {
      description: "Associated tags",
      on_delete: "restrict",
    },
  };

  assertEquals(singleLink.multi, false);
  assertEquals(singleLink.required, true);

  assertEquals(multiLink.multi, true);
  assertEquals(multiLink.required, false);
  assertEquals(multiLink.annotations.on_delete, "restrict");
});

Deno.test("MigrationResult - success case", () => {
  const result: Types.MigrationResult = {
    migration_id: "migration-001",
    success: true,
    duration_ms: 250,
    applied_at: new Date(),
  };

  assertEquals(result.success, true);
  assertEquals(result.duration_ms, 250);
  assertExists(result.applied_at);
});

Deno.test("MigrationResult - failure case", () => {
  const result: Types.MigrationResult = {
    migration_id: "migration-002",
    success: false,
    duration_ms: 100,
    applied_at: new Date(),
    error: "Constraint violation: duplicate key",
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
      annotations: { description: "User status" },
    },
  };

  assertEquals(operation.kind, "AddProperty");
  assertEquals(operation.property.default, "active");
  assertEquals(operation.property.constraints.length, 1);
});

Deno.test("DropPropertyOperation - structure", () => {
  const operation: Types.DropPropertyOperation = {
    kind: "DropProperty",
    property_name: "deprecated_field",
  };

  assertEquals(operation.kind, "DropProperty");
  assertEquals(operation.property_name, "deprecated_field");
});

Deno.test("AlterPropertyOperation - structure", () => {
  const operation: Types.AlterPropertyOperation = {
    kind: "AlterProperty",
    property_name: "email",
    changes: [
      {
        kind: "ChangeRequired",
        old_value: false,
        new_value: true,
      },
      {
        kind: "AddConstraint",
        new_value: "exclusive",
      },
      {
        kind: "DropConstraint",
        old_value: "min_length(3)",
      },
    ],
  };

  assertEquals(operation.kind, "AlterProperty");
  assertEquals(operation.property_name, "email");
  assertEquals(operation.changes.length, 3);
  assertEquals(operation.changes[0].kind, "ChangeRequired");
  assertEquals(operation.changes[1].kind, "AddConstraint");
  assertEquals(operation.changes[2].kind, "DropConstraint");
});

Deno.test("MigrationOperation - discriminated union", () => {
  const operations: Types.MigrationOperation[] = [
    { kind: "CreateType", type_name: "User", properties: [], links: [] } as Types.CreateTypeOperation,
    { kind: "DropType", type_name: "OldType" } as Types.DropTypeOperation,
    { kind: "AlterType", type_name: "User", operations: [] } as Types.AlterTypeOperation,
  ];

  assertEquals(operations[0].kind, "CreateType");
  assertEquals(operations[1].kind, "DropType");
  assertEquals(operations[2].kind, "AlterType");

  // TypeScript should properly discriminate the union
  const op0 = operations[0] as Types.CreateTypeOperation;
  assertExists(op0.properties);
  assertExists(op0.links);

  const op1 = operations[1] as Types.DropTypeOperation;
  assertExists(op1.type_name);

  const op2 = operations[2] as Types.AlterTypeOperation;
  assertExists(op2.operations);
});

Deno.test("Result type - success and error cases", () => {
  const successResult: Result<string, Error> = {
    ok: true,
    value: "success",
  };

  const errorResult: Result<string, Error> = {
    ok: false,
    error: new Error("Something went wrong"),
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
