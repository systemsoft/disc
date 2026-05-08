/**
 * Tests for Migration Squasher
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { MigrationSquasher, SquashableMigration } from "./squash.ts";

// ---- Helpers ----

function createMigration(
  id: string,
  overrides: Partial<SquashableMigration> = {}
): SquashableMigration {
  return {
    id,
    name: `migration_${id}`,
    statements: [`CREATE TABLE ${id} (id UUID PRIMARY KEY)`],
    rollbackStatements: [`DROP TABLE ${id}`],
    hasDataMigration: false,
    ...overrides
  };
}

// ---- squash: combining DDL ----

Deno.test("MigrationSquasher - squash combines DDL from multiple migrations", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001", {
      statements: ["CREATE TABLE users (id UUID PRIMARY KEY)"]
    }),
    createMigration("m002", {
      statements: ["CREATE TABLE posts (id UUID PRIMARY KEY)"]
    }),
    createMigration("m003", {
      statements: ["ALTER TABLE users ADD COLUMN email TEXT"]
    })
  ];

  const result = squasher.squash(migrations);

  assertEquals(result.statements.length, 3);
  assertStringIncludes(result.statements[0], "CREATE TABLE users");
  assertStringIncludes(result.statements[1], "CREATE TABLE posts");
  assertStringIncludes(result.statements[2], "ALTER TABLE users");
});

Deno.test("MigrationSquasher - squash combines rollback SQL in reverse order", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001", {
      rollbackStatements: ["DROP TABLE users"]
    }),
    createMigration("m002", {
      rollbackStatements: ["DROP TABLE posts"]
    }),
    createMigration("m003", {
      rollbackStatements: ["ALTER TABLE users DROP COLUMN email"]
    })
  ];

  const result = squasher.squash(migrations);

  assertEquals(result.rollbackStatements.length, 3);
  // Reverse order: m003 rollback first, then m002, then m001
  assertStringIncludes(
    result.rollbackStatements[0],
    "ALTER TABLE users DROP COLUMN email"
  );
  assertStringIncludes(result.rollbackStatements[1], "DROP TABLE posts");
  assertStringIncludes(result.rollbackStatements[2], "DROP TABLE users");
});

// ---- squash: name generation ----

Deno.test("MigrationSquasher - squash generates correct name", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001"),
    createMigration("m002"),
    createMigration("m003")
  ];

  const result = squasher.squash(migrations);

  assertEquals(result.name, "squashed_m001_to_m003");
});

// ---- squash: data migration rejection ----

Deno.test("MigrationSquasher - squash rejects range with data migrations", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001"),
    createMigration("m002", { hasDataMigration: true }),
    createMigration("m003")
  ];

  assertThrows(
    () => squasher.squash(migrations),
    Error,
    "Cannot squash migrations that include data migrations"
  );
});

// ---- squash: single migration ----

Deno.test("MigrationSquasher - squash handles single migration", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001", {
      statements: ["CREATE TABLE users (id UUID PRIMARY KEY)"],
      rollbackStatements: ["DROP TABLE users"]
    })
  ];

  const result = squasher.squash(migrations);

  assertEquals(result.squashedIds.length, 1);
  assertEquals(result.statements.length, 1);
  assertEquals(result.rollbackStatements.length, 1);
  assertEquals(result.name, "squashed_m001_to_m001");
});

// ---- squash: from/to range validation ----

Deno.test("MigrationSquasher - squash validates from/to order", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001"),
    createMigration("m002"),
    createMigration("m003")
  ];

  // toId comes before fromId — invalid
  assertThrows(
    () => squasher.squash(migrations, "m003", "m001"),
    Error,
    "comes after"
  );
});

// ---- squash: ID range filtering ----

Deno.test("MigrationSquasher - squash filters by ID range correctly", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001", {
      statements: ["CREATE TABLE a (id UUID PRIMARY KEY)"]
    }),
    createMigration("m002", {
      statements: ["CREATE TABLE b (id UUID PRIMARY KEY)"]
    }),
    createMigration("m003", {
      statements: ["CREATE TABLE c (id UUID PRIMARY KEY)"]
    }),
    createMigration("m004", {
      statements: ["CREATE TABLE d (id UUID PRIMARY KEY)"]
    })
  ];

  const result = squasher.squash(migrations, "m002", "m003");

  assertEquals(result.squashedIds, ["m002", "m003"]);
  assertEquals(result.statements.length, 2);
  assertStringIncludes(result.statements[0], "CREATE TABLE b");
  assertStringIncludes(result.statements[1], "CREATE TABLE c");
});

// ---- squash: statement order preservation ----

Deno.test("MigrationSquasher - squash preserves statement order within migrations", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001", {
      statements: [
        "CREATE TABLE users (id UUID PRIMARY KEY)",
        "CREATE INDEX idx_users_email ON users (email)"
      ]
    }),
    createMigration("m002", {
      statements: [
        "CREATE TABLE posts (id UUID PRIMARY KEY)",
        "CREATE INDEX idx_posts_title ON posts (title)"
      ]
    })
  ];

  const result = squasher.squash(migrations);

  assertEquals(result.statements.length, 4);
  assertStringIncludes(result.statements[0], "CREATE TABLE users");
  assertStringIncludes(result.statements[1], "idx_users_email");
  assertStringIncludes(result.statements[2], "CREATE TABLE posts");
  assertStringIncludes(result.statements[3], "idx_posts_title");
});

// ---- squash: squashed IDs ----

Deno.test("MigrationSquasher - squash result includes all squashed IDs", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001"),
    createMigration("m002"),
    createMigration("m003"),
    createMigration("m004")
  ];

  const result = squasher.squash(migrations);

  assertEquals(result.squashedIds, ["m001", "m002", "m003", "m004"]);
});

// ---- squash: empty range ----

Deno.test("MigrationSquasher - squash with empty input returns empty result", () => {
  const squasher = new MigrationSquasher();
  const result = squasher.squash([]);

  assertEquals(result.statements, []);
  assertEquals(result.rollbackStatements, []);
  assertEquals(result.squashedIds, []);
  assertEquals(result.name, "empty_squash");
});

// ---- squash: not-found IDs ----

Deno.test("MigrationSquasher - squash throws for non-existent fromId", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001"),
    createMigration("m002")
  ];

  assertThrows(
    () => squasher.squash(migrations, "m999"),
    Error,
    "not found"
  );
});

Deno.test("MigrationSquasher - squash throws for non-existent toId", () => {
  const squasher = new MigrationSquasher();
  const migrations = [
    createMigration("m001"),
    createMigration("m002")
  ];

  assertThrows(
    () => squasher.squash(migrations, undefined, "m999"),
    Error,
    "not found"
  );
});
