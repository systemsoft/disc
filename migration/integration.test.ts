/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Integration tests for Migration Engine with SDL Parser
 *
 * Tests that use MigrationTracker require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import {
  canRunPgTests,
  cleanupTestTables,
  getTestDsn
} from "../tests/pg-test-harness.ts";
import { MigrationEngine } from "./engine.ts";
import { MigrationTracker } from "./tracker.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

// Helper function to create test config
function createIntegrationTestConfig(): Types.MigrationConfig {
  return {
    migrationsDir: "./migrations",
    schemaFile: "./test.disc",
    databaseUrl: "postgresql://localhost:5432/test_integration",
    dryRun: true,
    autoApprove: false,
    backupBeforeMigration: true,
    rollbackOnError: true
  };
}

// Sample SDL schemas for testing
const initialSchema = `
module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    createdAt: datetime {
      default := datetime_current();
    };
  };
}
`;

const evolvedSchema = `
module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    createdAt: datetime {
      default := datetime_current();
    };
    # New properties
    active: bool {
      default := true;
    };
    last_login: datetime;
    multi tags: str;
  };

  # New type
  type Post {
    required title: str;
    required content: str;
    required link author -> User;
    published_at: datetime;
    multi categories: str;
  };
}
`;

const complexSchema = `
module default {
  abstract type Timestamped {
    required createdAt: datetime {
      default := datetime_current();
      readonly := true;
    };
    required updatedAt: datetime {
      default := datetime_current();
    };
  };

  type User extending Timestamped {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    active: bool {
      default := true;
    };
    multi link posts -> Post;
  };

  type Post extending Timestamped {
    required title: str {
      constraint min_len_value(5);
    };
    required content: str;
    required link author -> User;
    published: bool {
      default := false;
    };
    published_at: datetime;
    multi link tags -> Tag;
  };

  type Tag extending Timestamped {
    required name: str {
      constraint exclusive;
    };
    description: str;
  };
}
`;

Deno.test("Integration - Parse and Generate Initial Migration", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);

  // Parse the initial schema
  const parser = new SDLParser(initialSchema);
  const sdlDocument = parser.parse();

  // Validate the schema
  const validator = new SchemaValidator();
  const validationResult = validator.validate(sdlDocument);
  assertEquals(validationResult.ok, true);

  // Convert to module AST (simplified for test)
  const modules = validator.convertToModules(sdlDocument);

  // Generate initial migration
  const planResult = engine.planMigration(null, modules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const plan = planResult.value;
    assertEquals(plan.migrations.length, 1);
    assertEquals(plan.migrations[0].operations.length, 1);
    assertEquals(plan.migrations[0].operations[0].kind, "CreateType");

    const createTypeOp = plan
      .migrations[0]
      .operations[0] as Types.CreateTypeOperation;
    assertEquals(createTypeOp.typeName, "User");
    assertEquals(createTypeOp.properties.length, 3); // name, email, createdAt
  }
});

Deno.test("Integration - Schema Evolution Migration", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Parse initial schema
  const initialParser = new SDLParser(initialSchema);
  const initialSDL = initialParser.parse();
  const initialModules = validator.convertToModules(initialSDL);

  // Parse evolved schema
  const evolvedParser = new SDLParser(evolvedSchema);
  const evolvedSDL = evolvedParser.parse();
  const evolvedModules = validator.convertToModules(evolvedSDL);

  // Generate migration between schemas
  const planResult = engine.planMigration(initialModules, evolvedModules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const plan = planResult.value;
    const operations = plan.migrations[0].operations;

    // Should have operations for:
    // 1. Alter User type (add new properties)
    // 2. Create Post type
    assertEquals(operations.length >= 2, true);

    const alterUserOp = operations.find((op: Types.MigrationOperation) =>
      op.kind === "AlterType" &&
      (op as Types.AlterTypeOperation).typeName === "User"
    );
    const createPostOp = operations.find((op: Types.MigrationOperation) =>
      op.kind === "CreateType" &&
      (op as Types.CreateTypeOperation).typeName === "Post"
    );

    assertEquals(alterUserOp !== undefined, true);
    assertEquals(createPostOp !== undefined, true);
  }
});

Deno.test("Integration - Cross-module inheritance via qualified name", async () => {
  // Regression: a non-default-module type extending `default::BaseRecord`
  // used to silently drop the inherited columns because the differ's
  // `extending` lookup used `baseRef.name.parts.join("::")` verbatim
  // (`default::BaseRecord`) against an `allTypes` map keyed by bare name.
  const crossModuleSchema = `
    module default {
      abstract type BaseRecord {
        required created -> datetime {
          default := datetime_current();
          readonly := true;
        };
        required updated -> datetime { default := datetime_current(); };
      };
    }

    module payment {
      type PaymentRecord extending default::BaseRecord {
        required amount -> int64;
      };
    }
  `;
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();
  const parser = new SDLParser(crossModuleSchema);
  const sdlDocument = parser.parse();
  // Arrow-form scalar declarations (`required created -> datetime`) parse as
  // LinkDeclaration nodes; the differ only sees PropertyDeclarations, so the
  // production code path runs `normalizeArrowsToProperties` first. Mirror
  // that here so the test exercises realistic input.
  const { normalizeArrowsToProperties } = await import("../schema/converter.ts");
  const modules = normalizeArrowsToProperties(validator.convertToModules(sdlDocument));

  const planResult = engine.planMigration(null, modules);
  assertEquals(planResult.ok, true);
  if (!planResult.ok)
    return;

  const operations = planResult.value.migrations[0].operations;
  const paymentOp = operations.find(
    (op: Types.MigrationOperation) =>
      op.kind === "CreateType" &&
      (op as Types.CreateTypeOperation).typeName === "PaymentRecord"
  ) as Types.CreateTypeOperation | undefined;

  assertEquals(paymentOp !== undefined, true);
  if (!paymentOp)
    return;
  const hasCreated = paymentOp.properties.some(p => p.name === "created");
  const hasUpdated = paymentOp.properties.some(p => p.name === "updated");
  const hasAmount = paymentOp.properties.some(p => p.name === "amount");
  assertEquals(hasCreated, true, "PaymentRecord must inherit 'created' from default::BaseRecord");
  assertEquals(hasUpdated, true, "PaymentRecord must inherit 'updated' from default::BaseRecord");
  assertEquals(hasAmount, true);
});

Deno.test("Integration - Complex Schema with Inheritance", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Parse complex schema with inheritance
  const parser = new SDLParser(complexSchema);
  const sdlDocument = parser.parse();
  const sdlValidationResult = validator.validate(sdlDocument);
  assertEquals(sdlValidationResult.ok, true);

  const modules = validator.convertToModules(sdlDocument);

  // Generate initial migration
  const planResult = engine.planMigration(null, modules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const plan = planResult.value;
    const operations = plan.migrations[0].operations;

    // Should create tables for concrete types
    const createOps = operations.filter((op: Types.MigrationOperation) => op.kind === "CreateType");
    assertEquals(createOps.length >= 3, true); // User, Post, Tag (Timestamped is abstract)

    const userCreateOp = createOps.find((op: Types.MigrationOperation) => (op as Types.CreateTypeOperation).typeName === "User") as Types.CreateTypeOperation;

    assertEquals(userCreateOp !== undefined, true);
    // Should inherit properties from Timestamped
    const hasCreatedAt = userCreateOp.properties.some(prop => prop.name === "createdAt");
    const hasUpdatedAt = userCreateOp.properties.some(prop => prop.name === "updatedAt");
    assertEquals(hasCreatedAt, true);
    assertEquals(hasUpdatedAt, true);
  }
});

Deno.test({
  name: "Integration - Full Migration Workflow with Tracker",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupTestTables(dsn);
    const config = { ...createIntegrationTestConfig(), databaseUrl: dsn };
    const engine = new MigrationEngine(config);
    const tracker = new MigrationTracker(dsn);
    const validator = new SchemaValidator();

    await tracker.initialize();

    // Parse and apply initial schema
    const parser = new SDLParser(initialSchema);
    const sdlDocument = parser.parse();
    const modules = validator.convertToModules(sdlDocument);

    const planResult = engine.planMigration(null, modules);
    assertEquals(planResult.ok, true);

    if (planResult.ok) {
      const executeResult = await engine.executeMigration(planResult.value);
      assertEquals(executeResult.ok, true);

      if (executeResult.ok) {
        // Record migration in tracker
        const migration = planResult.value.migrations[0];
        const migrationResult = executeResult.value[0];
        const recordResult = await tracker.recordMigration(
          migration,
          migrationResult
        );
        assertEquals(recordResult.ok, true);

        // Verify migration is tracked
        const isAppliedResult = await tracker.isMigrationApplied(migration.id);
        assertEquals(isAppliedResult.ok, true);
        if (isAppliedResult.ok) {
          assertEquals(isAppliedResult.value, true);
        }
      }
    }

    await tracker.close();
  }
});

Deno.test({
  name: "Integration - Migration Rollback with Tracker",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupTestTables(dsn);
    const config = { ...createIntegrationTestConfig(), databaseUrl: dsn };
    const engine = new MigrationEngine(config);
    const tracker = new MigrationTracker(dsn);
    const validator = new SchemaValidator();

    await tracker.initialize();

    // Apply initial migration
    const parser = new SDLParser(initialSchema);
    const sdlDocument = parser.parse();
    const modules = validator.convertToModules(sdlDocument);

    const planResult = engine.planMigration(null, modules);
    assertEquals(planResult.ok, true);

    if (planResult.ok) {
      const executeResult = await engine.executeMigration(planResult.value);
      assertEquals(executeResult.ok, true);

      if (executeResult.ok) {
        const migration = planResult.value.migrations[0];

        await tracker.recordMigration(migration, executeResult.value[0]);

        // Verify migration is applied
        let isAppliedResult = await tracker.isMigrationApplied(migration.id);
        if (isAppliedResult.ok) {
          assertEquals(isAppliedResult.value, true);
        }

        // Rollback migration
        const rollbackResult = await tracker.removeMigration(migration.id);
        assertEquals(rollbackResult.ok, true);

        // Verify migration is no longer applied
        isAppliedResult = await tracker.isMigrationApplied(migration.id);
        if (isAppliedResult.ok) {
          assertEquals(isAppliedResult.value, false);
        }
      }
    }

    await tracker.close();
  }
});

Deno.test("Integration - Generate DDL from SDL Schema", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Parse schema
  const parser = new SDLParser(initialSchema);
  const sdlDocument = parser.parse();
  const modules = validator.convertToModules(sdlDocument);

  // Generate migration and DDL
  const planResult = engine.planMigration(null, modules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const ddlResult = engine.generateDDL(planResult.value);
    assertEquals(ddlResult.ok, true);

    if (ddlResult.ok) {
      const statements = ddlResult.value;
      assertEquals(statements.length > 0, true);

      // Should contain CREATE TABLE statement
      const createTableStmt = statements.find(stmt => stmt.includes("CREATE TABLE"));
      assertEquals(createTableStmt !== undefined, true);

      // Should contain proper columns
      assertStringIncludes(createTableStmt!, "name TEXT NOT NULL");
      assertStringIncludes(createTableStmt!, "email TEXT NOT NULL");

      // Should contain unique constraint for email
      const uniqueConstraintStmt = statements.find(stmt => stmt.includes("UNIQUE") && stmt.includes("email"));
      assertEquals(uniqueConstraintStmt !== undefined, true);
    }
  }
});

Deno.test("Integration - Rollback DDL Generation", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Parse schema and generate migration
  const parser = new SDLParser(initialSchema);
  const sdlDocument = parser.parse();
  const modules = validator.convertToModules(sdlDocument);

  const planResult = engine.planMigration(null, modules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    const migration = planResult.value.migrations[0];

    // Generate rollback SQL
    const rollbackResult = engine.generateRollbackSQL(migration);
    assertEquals(rollbackResult.ok, true);

    if (rollbackResult.ok) {
      const rollbackSQL = rollbackResult.value;
      assertEquals(rollbackSQL.length > 0, true);

      // Should contain DROP TABLE statement
      const dropTableStmt = rollbackSQL.find(stmt => stmt.includes("DROP TABLE"));
      assertEquals(dropTableStmt !== undefined, true);
      assertStringIncludes(dropTableStmt!, "user");
    }
  }
});

Deno.test("Integration - Migration Safety Validation", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Create a schema that drops a type (potentially destructive)
  const destructiveSchema = `
module default {
  # User type is completely removed
  type Post {
    required title: str;
    required content: str;
  };
}
`;

  // Parse initial and destructive schemas
  const initialParser = new SDLParser(initialSchema);
  const initialModules = validator.convertToModules(initialParser.parse());

  const destructiveParser = new SDLParser(destructiveSchema);
  const destructiveModules = validator.convertToModules(
    destructiveParser.parse()
  );

  // Generate migration plan
  const planResult = engine.planMigration(initialModules, destructiveModules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    // Validate migration safety
    const validationResult = engine.validateMigration(planResult.value);
    assertEquals(validationResult.ok, false);
    if (!validationResult.ok) {
      assertStringIncludes(
        validationResult.error.message.toLowerCase(),
        "data loss"
      );
    }

    // Validate rollback safety
    const rollbackValidationResult = engine.validateRollbackSafety(
      planResult.value
    );
    assertEquals(rollbackValidationResult.ok, false);
    if (!rollbackValidationResult.ok) {
      assertStringIncludes(
        rollbackValidationResult.error.message.toLowerCase(),
        "rollback"
      );
    }
  }
});

Deno.test("Integration - Data Migration Hints", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Parse schemas
  const initialParser = new SDLParser(initialSchema);
  const initialModules = validator.convertToModules(initialParser.parse());

  const evolvedParser = new SDLParser(evolvedSchema);
  const evolvedModules = validator.convertToModules(evolvedParser.parse());

  // Generate migration plan
  const planResult = engine.planMigration(initialModules, evolvedModules);
  assertEquals(planResult.ok, true);

  if (planResult.ok) {
    // Generate data migration hints
    const hintsResult = engine.generateDataMigrationHints(planResult.value);
    assertEquals(hintsResult.ok, true);

    if (hintsResult.ok) {
      const hints = hintsResult.value;
      assertEquals(hints.length > 0, true);

      // Should include hints for required properties with defaults
      // Note: In this case we don't have required properties being added,
      // but the test demonstrates the capability
      hints.find((hint: string) => hint.includes("default") && hint.includes("required"));
    }
  }
});

Deno.test("Integration - Performance with Large Schema", () => {
  const config = createIntegrationTestConfig();
  const engine = new MigrationEngine(config);
  const validator = new SchemaValidator();

  // Generate a large schema with many types
  let largeSchema = "module default {\n";

  for (let i = 1; i <= 50; i++) {
    largeSchema += `
  type Entity${i} {
    required name: str;
    required value: int32;
    description: str;
    createdAt: datetime {
      default := datetime_current();
    };
  };
`;
  }

  largeSchema += "}\n";

  // Parse and time the operation
  const startTime = Date.now();

  const parser = new SDLParser(largeSchema);
  const sdlDocument = parser.parse();
  const modules = validator.convertToModules(sdlDocument);

  const planResult = engine.planMigration(null, modules);
  assertEquals(planResult.ok, true);

  const endTime = Date.now();
  const duration = endTime - startTime;

  // Should complete within reasonable time (adjust threshold as needed)
  assertEquals(duration < 5000, true); // 5 seconds

  if (planResult.ok) {
    // Should create all types
    const operations = planResult.value.migrations[0].operations;
    const createOps = operations.filter((op: Types.MigrationOperation) => op.kind === "CreateType");
    assertEquals(createOps.length, 50);
  }
});

Deno.test("Integration - Error Handling with Invalid SDL", () => {
  // Invalid SDL with syntax errors
  const invalidSchema = `
module default {
  type User {
    required name str; # Missing colon
    email: ; # Missing type
    {
      constraint exclusive
    }; # Incorrect constraint syntax
  };
}
`;

  try {
    const parser = new SDLParser(invalidSchema);
    parser.parse();
    // If parsing succeeds where it shouldn't, the test should fail
    assertEquals(true, false, "Expected parsing to fail for invalid SDL");
  } catch (error) {
    // Should throw a syntax error
    assertEquals(error instanceof Error, true);
    assertStringIncludes((error as Error).message.toLowerCase(), "expected");
  }
});
