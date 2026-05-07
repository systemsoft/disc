/**
 * Tests for DatabaseRegistry
 */

import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { DatabaseRegistry } from "./database-registry.ts";
import { DatabaseConnection, replaceDsnDatabase } from "../lib/database.ts";
import { DatabaseRegistryError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Test helpers — mock DatabaseConnection.connect / .execute / .close
// ---------------------------------------------------------------------------

function installMocks(): {
  executedSql: string[];
  restore: () => void;
} {
  const executedSql: string[] = [];

  const origConnect = DatabaseConnection.prototype.connect;
  const origExecute = DatabaseConnection.prototype.execute;
  const origClose = DatabaseConnection.prototype.close;
  const origQuery = DatabaseConnection.prototype.query;

  DatabaseConnection.prototype.connect = function () {
    return Promise.resolve();
  };

  DatabaseConnection.prototype.execute = function (sql: string) {
    executedSql.push(sql);
    return Promise.resolve();
  };

  DatabaseConnection.prototype.close = function () {
    return Promise.resolve();
  };

  DatabaseConnection.prototype.query = function (sql: string) {
    if (sql === "SELECT 1") {
      return Promise.resolve({ rows: [{ "?column?": 1 }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return {
    executedSql,
    restore() {
      DatabaseConnection.prototype.connect = origConnect;
      DatabaseConnection.prototype.execute = origExecute;
      DatabaseConnection.prototype.close = origClose;
      DatabaseConnection.prototype.query = origQuery;
    },
  };
}

const TEST_DSN = "postgresql://disc:pass@localhost:5432/disc";

// ---------------------------------------------------------------------------
// DSN manipulation
// ---------------------------------------------------------------------------

Deno.test("replaceDsnDatabase - replaces database in DSN", () => {
  const result = replaceDsnDatabase(
    "postgresql://user:pass@host:5432/original",
    "replaced",
  );
  assertStringIncludes(result, "/replaced");
  // Should not contain original db name
  assertEquals(result.includes("/original"), false);
});

Deno.test("replaceDsnDatabase - handles DSN without port", () => {
  const result = replaceDsnDatabase(
    "postgresql://user@host/original",
    "newdb",
  );
  assertStringIncludes(result, "/newdb");
});

Deno.test("replaceDsnDatabase - handles DSN with query params", () => {
  const result = replaceDsnDatabase(
    "postgresql://user@host/original?sslmode=require",
    "newdb",
  );
  assertStringIncludes(result, "/newdb");
  assertStringIncludes(result, "sslmode=require");
});

// ---------------------------------------------------------------------------
// DatabaseRegistry initialization
// ---------------------------------------------------------------------------

Deno.test("DatabaseRegistry - initialize creates default entry", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    const defaultDb = registry.getDefaultDatabase();
    assertExists(defaultDb);
    assertEquals(defaultDb.name, "disc");
    assertEquals(defaultDb.databaseUrl, TEST_DSN);
    assertEquals(defaultDb.schema, null);
    assertEquals(defaultDb.migrationTracker, null);

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - initialize uses provided DSN", async () => {
  const { restore } = installMocks();
  try {
    const customDsn = "postgresql://admin:secret@dbhost:5433/mydisc";
    const registry = new DatabaseRegistry();
    await registry.initialize(customDsn);

    const defaultDb = registry.getDefaultDatabase();
    assertEquals(defaultDb.databaseUrl, customDsn);

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - double initialize throws", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    await assertRejects(
      () => registry.initialize(TEST_DSN),
      DatabaseRegistryError,
      "already initialized",
    );

    await registry.close();
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// createDatabase
// ---------------------------------------------------------------------------

Deno.test("DatabaseRegistry - createDatabase creates entry with pool", async () => {
  const { executedSql, restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    const entry = await registry.createDatabase("analytics");
    assertExists(entry);
    assertEquals(entry.name, "analytics");
    assertExists(entry.pool);
    assertEquals(entry.schema, null);
    assertEquals(entry.migrationTracker, null);
    // DSN should point to disc_analytics
    assertStringIncludes(entry.databaseUrl, "disc_analytics");

    // Should have issued CREATE DATABASE
    const createStmt = executedSql.find((s) => s.includes("CREATE DATABASE") && s.includes("disc_analytics"));
    assertExists(createStmt);

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - createDatabase rejects duplicate name", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);
    await registry.createDatabase("mydb");

    await assertRejects(
      () => registry.createDatabase("mydb"),
      DatabaseRegistryError,
      "already exists",
    );

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - createDatabase validates name - uppercase rejected", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    await assertRejects(
      () => registry.createDatabase("MyDb"),
      DatabaseRegistryError,
      "Invalid database name",
    );

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - createDatabase validates name - starts with digit rejected", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    await assertRejects(
      () => registry.createDatabase("123db"),
      DatabaseRegistryError,
      "Invalid database name",
    );

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - createDatabase validates name - special chars rejected", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    await assertRejects(
      () => registry.createDatabase("my-db"),
      DatabaseRegistryError,
      "Invalid database name",
    );

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - createDatabase throws when not initialized", async () => {
  const registry = new DatabaseRegistry();

  await assertRejects(
    () => registry.createDatabase("testdb"),
    DatabaseRegistryError,
    "not been initialized",
  );
});

// ---------------------------------------------------------------------------
// dropDatabase
// ---------------------------------------------------------------------------

Deno.test("DatabaseRegistry - dropDatabase removes entry and drops PG database", async () => {
  const { executedSql, restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);
    await registry.createDatabase("temp");

    assertEquals(registry.getDatabase("temp") !== undefined, true);

    await registry.dropDatabase("temp");

    assertEquals(registry.getDatabase("temp"), undefined);

    // Should have issued DROP DATABASE
    const dropStmt = executedSql.find((s) => s.includes("DROP DATABASE") && s.includes("disc_temp"));
    assertExists(dropStmt);

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - dropDatabase rejects dropping default", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    await assertRejects(
      () => registry.dropDatabase("disc"),
      DatabaseRegistryError,
      "Cannot drop the default",
    );

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - dropDatabase rejects unknown name", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    await assertRejects(
      () => registry.dropDatabase("nonexistent"),
      DatabaseRegistryError,
      "not found",
    );

    await registry.close();
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// getDatabase / getDefaultDatabase / listDatabases
// ---------------------------------------------------------------------------

Deno.test("DatabaseRegistry - getDatabase returns entry for known name", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);
    await registry.createDatabase("users");

    const entry = registry.getDatabase("users");
    assertExists(entry);
    assertEquals(entry.name, "users");

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - getDatabase returns undefined for unknown name", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    assertEquals(registry.getDatabase("nope"), undefined);

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - getDefaultDatabase returns the default entry", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);

    const defaultDb = registry.getDefaultDatabase();
    assertEquals(defaultDb.name, "disc");

    await registry.close();
  } finally {
    restore();
  }
});

Deno.test("DatabaseRegistry - listDatabases returns all names", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);
    await registry.createDatabase("alpha");
    await registry.createDatabase("beta");

    const names = registry.listDatabases();
    assertEquals(names.length, 3); // disc + alpha + beta
    assertEquals(names.includes("disc"), true);
    assertEquals(names.includes("alpha"), true);
    assertEquals(names.includes("beta"), true);

    await registry.close();
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

Deno.test("DatabaseRegistry - close drains all pools and clears registry", async () => {
  const { restore } = installMocks();
  try {
    const registry = new DatabaseRegistry();
    await registry.initialize(TEST_DSN);
    await registry.createDatabase("one");
    await registry.createDatabase("two");

    assertEquals(registry.listDatabases().length, 3);

    await registry.close();

    assertEquals(registry.listDatabases().length, 0);

    // After close, operations should fail as not initialized
    await assertRejects(
      () => registry.createDatabase("three"),
      DatabaseRegistryError,
      "not been initialized",
    );
  } finally {
    restore();
  }
});
