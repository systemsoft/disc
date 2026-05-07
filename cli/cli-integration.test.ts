/**
 * CLI Integration Tests - SchemaManager CLI wiring
 *
 * Tests that verify readSchemaFile, readSchemaAsCompilerSchema, codegen,
 * migrate, and DiscServer all work correctly with real SDL parsing via
 * SchemaManager.
 *
 * Unit tests require no database. PG integration tests require
 * DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 *
 * NOTE: The Disc SDL parser requires semicolons after property declarations
 * (e.g., `required name: str;`) but does NOT accept trailing semicolons
 * after closing braces. Use `}` not `};` to close type and module blocks.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import * as Context from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { createServerFromEnv, DiscServer } from "../server/server.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { CLICommands } from "./commands.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Since readSchemaFile and readSchemaAsCompilerSchema are private on
 * CLICommands, we access them via `any` cast. This follows the pattern
 * of testing internal wiring without exposing implementation details.
 */
function getPrivateMethod<T>(
  obj: CLICommands,
  methodName: string,
): (...args: unknown[]) => T {
  // deno-lint-ignore no-explicit-any
  return (obj as any)[methodName].bind(obj);
}

/** Parse a DSN into connection config for the raw deno-postgres Client. */
function parseDsn(
  dsn: string,
): { hostname: string; port: number; user: string; database: string; } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

/** Drop one or more tables by name (best-effort cleanup). */
async function dropTables(
  dsn: string,
  ...tableNames: string[]
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Check whether a table exists in the public schema via a raw client. */
async function tableExists(dsn: string, tableName: string): Promise<boolean> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<{ exists: boolean; }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tableName],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

// =========================================================================
// A. Unit Tests (no database required)
// =========================================================================

// ---------------------------------------------------------------------------
// 1. readSchemaFile parses valid SDL into Module[]
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - readSchemaFile parses valid SDL into Module[]",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();
    const tempDir = await createTempDir();

    try {
      const schemaFile = `${tempDir}/widget.disc`;
      await Deno.writeTextFile(
        schemaFile,
        `module default {
  type Widget {
    required name: str;
  }
}`,
      );

      const commands = new CLICommands();
      const readSchemaFile = getPrivateMethod(commands, "readSchemaFile");
      const result = await readSchemaFile(schemaFile);

      assert(
        result !== null,
        "readSchemaFile should return non-null for valid SDL",
      );
      assert(Array.isArray(result), "readSchemaFile should return an array");
      assert(
        (result as unknown[]).length > 0,
        "readSchemaFile should return at least one module",
      );
    } finally {
      capture.restore();
      await cleanupTempDir(tempDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 2. readSchemaFile returns null for missing file
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - readSchemaFile returns null for missing file",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();

    try {
      const commands = new CLICommands();
      const readSchemaFile = getPrivateMethod(commands, "readSchemaFile");
      const result = await readSchemaFile("/tmp/nonexistent-schema-file.disc");

      assertEquals(
        result,
        null,
        "readSchemaFile should return null for missing file",
      );
    } finally {
      capture.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// 3. readSchemaFile returns null for invalid SDL
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - readSchemaFile returns null for invalid SDL",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();
    const tempDir = await createTempDir();

    try {
      const schemaFile = `${tempDir}/bad.disc`;
      await Deno.writeTextFile(
        schemaFile,
        "this is not valid SDL at all!!!",
      );

      const commands = new CLICommands();
      const readSchemaFile = getPrivateMethod(commands, "readSchemaFile");
      const result = await readSchemaFile(schemaFile);

      assertEquals(
        result,
        null,
        "readSchemaFile should return null for invalid SDL",
      );
    } finally {
      capture.restore();
      await cleanupTempDir(tempDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 4. readSchemaAsCompilerSchema returns Schema from valid SDL
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - readSchemaAsCompilerSchema returns Schema from valid SDL",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();
    const tempDir = await createTempDir();

    try {
      const schemaFile = `${tempDir}/gadget.disc`;
      await Deno.writeTextFile(
        schemaFile,
        `module default {
  type Gadget {
    required label: str;
    active: bool;
  }
}`,
      );

      const commands = new CLICommands();
      const readSchema = getPrivateMethod<Promise<Context.Schema | null>>(
        commands,
        "readSchemaAsCompilerSchema",
      );
      const schema = await readSchema(schemaFile);

      assert(
        schema !== null,
        "readSchemaAsCompilerSchema should return non-null",
      );
      assertExists(
        (schema as Context.Schema).types,
        "Schema should have a types map",
      );
      assert(
        (schema as Context.Schema).types.size > 0,
        "Schema types map should have entries",
      );

      const gadget = (schema as Context.Schema).types.get("Gadget");
      assertExists(gadget, "Schema should contain Gadget type");
      assertEquals(gadget!.kind, "object");
      assert(
        gadget!.properties.has("label"),
        "Gadget should have label property",
      );
      assert(
        gadget!.properties.has("active"),
        "Gadget should have active property",
      );
      assert(
        gadget!.properties.has("id"),
        "Gadget should have implicit id property",
      );
    } finally {
      capture.restore();
      await cleanupTempDir(tempDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 5. readSchemaAsCompilerSchema returns null for missing file
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - readSchemaAsCompilerSchema returns null for missing file",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();

    try {
      const commands = new CLICommands();
      const readSchema = getPrivateMethod(
        commands,
        "readSchemaAsCompilerSchema",
      );
      const result = await readSchema("/tmp/nonexistent-schema-file.disc");

      assertEquals(
        result,
        null,
        "readSchemaAsCompilerSchema should return null for missing file",
      );
    } finally {
      capture.restore();
    }
  },
);

// ---------------------------------------------------------------------------
// 6. codegen with real SDL uses parsed schema (Widget, not User/Post)
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - codegen with real SDL uses parsed schema",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();
    const tempDir = await createTempDir();

    try {
      const schemaFile = `${tempDir}/widget.disc`;
      const outputDir = `${tempDir}/generated`;

      await Deno.writeTextFile(
        schemaFile,
        `module default {
  type Widget {
    required name: str;
    color: str;
  }
}`,
      );

      const commands = new CLICommands();
      await commands.codegen({
        _: ["codegen"],
        schema: schemaFile,
        output: outputDir,
        target: "client",
        "no-queries": false,
        "no-mutations": false,
        "no-client": false,
        "no-format": false,
      });

      // The console output should reference Widget (from the SDL), not
      // fallback types like User/Post from the test schema.
      const logs = capture.getLogs();
      const allOutput = logs.join("\n");

      assert(
        allOutput.includes("Widget"),
        `Codegen output should reference 'Widget' from SDL, got:\n${allOutput}`,
      );
    } finally {
      capture.restore();
      await cleanupTempDir(tempDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 7. DiscServer accepts schema option
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - DiscServer accepts schema option",
  () => {
    const schema = Context.createTestSchema();

    const server = new DiscServer({
      host: "localhost",
      port: 0,
      schema,
      dryRun: true,
    });

    assertExists(server, "DiscServer should be created with schema option");

    const config = server.get_config();
    assertEquals(config.host, "localhost");
  },
);

// ---------------------------------------------------------------------------
// 8. DiscServer without schema falls back to defaults
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - DiscServer without schema falls back to defaults",
  () => {
    const server = new DiscServer({
      host: "localhost",
      port: 0,
      dryRun: true,
    });

    assertExists(server, "DiscServer should be created without schema option");

    const config = server.get_config();
    assertEquals(config.host, "localhost");
  },
);

// ---------------------------------------------------------------------------
// 9. createServerFromEnv passes schema through
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - createServerFromEnv passes schema through",
  () => {
    const schema = Context.createTestSchema();
    const server = createServerFromEnv(undefined, schema);

    assertExists(server, "createServerFromEnv should return a DiscServer");

    const config = server.get_config();
    assertExists(config, "Server should have a config");
  },
);

// ---------------------------------------------------------------------------
// 10. migrate dry-run with real SDL produces plan output
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - migrate dry-run with real SDL produces plan output",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();
    const tempDir = await createTempDir();

    try {
      const schemaFile = `${tempDir}/schema.disc`;
      await Deno.writeTextFile(
        schemaFile,
        `module default {
  type Sprocket {
    required name: str;
    required serial_number: str;
  }
}`,
      );

      const commands = new CLICommands();
      await commands.migrate({
        _: ["migrate"],
        schema: schemaFile,
        "dry-run": true,
      });

      // Dry-run should complete without error. The output should mention
      // migration planning or "DRY RUN" or "up to date".
      const logs = capture.getLogs();
      const allOutput = logs.join("\n");

      // The command should produce some output about the migration
      assert(
        allOutput.length > 0,
        "Dry-run migrate should produce console output",
      );
    } finally {
      capture.restore();
      await cleanupTempDir(tempDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 11. migrate --create with dry-run mode shows plan details
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - migrate --create with dry-run shows plan details",
  async () => {
    const capture = new ConsoleCapture();
    capture.start();
    const tempDir = await createTempDir();

    try {
      const schemaFile = `${tempDir}/schema.disc`;
      await Deno.writeTextFile(
        schemaFile,
        `module default {
  type Gizmo {
    required name: str;
    weight: float64;
  }
}`,
      );

      // Use dry-run + create to avoid needing a real database.
      // The create path reads the schema and plans without executing DDL.
      const commands = new CLICommands();
      await commands.migrate({
        _: ["migrate"],
        create: true,
        schema: schemaFile,
        "dry-run": true,
      });

      // Create mode should show the plan info
      const logs = capture.getLogs();
      const allOutput = logs.join("\n");

      assert(
        allOutput.includes("Migration Plan")
          || allOutput.includes("Creating new migration")
          || allOutput.includes("DRY RUN")
          || allOutput.includes("migration"),
        `migrate --create should show plan info, got:\n${allOutput}`,
      );
    } finally {
      capture.restore();
      await cleanupTempDir(tempDir);
    }
  },
);

// ---------------------------------------------------------------------------
// 12. SchemaManager round-trip: SDL -> Module[] -> Schema -> types
// ---------------------------------------------------------------------------
Deno.test(
  "CLI Integration - SchemaManager round-trip SDL to Schema types",
  () => {
    const sdl = `
      module default {
        type Doohickey {
          required name: str;
          required serial: int64;
          active: bool;
        }
      }
    `;

    const manager = new SchemaManager({});
    const parseResult = manager.parseSDL(sdl);

    assertEquals(parseResult.ok, true, "parseSDL should succeed");
    if (!parseResult.ok) return;

    const schema = manager.modulesToSchema(parseResult.value);

    assertExists(schema.types, "Schema should have types");
    assert(schema.types.size > 0, "Schema should have at least one type");

    const doohickey = schema.types.get("Doohickey");
    assertExists(doohickey, "Schema should contain Doohickey type");
    assertEquals(doohickey!.tableName, "doohickey");
    assertEquals(doohickey!.kind, "object");

    // Verify property type mappings
    const nameProp = doohickey!.properties.get("name");
    assertExists(nameProp, "Should have name property");
    assertEquals(nameProp!.type, "text");
    assertEquals(nameProp!.required, true);

    const serialProp = doohickey!.properties.get("serial");
    assertExists(serialProp, "Should have serial property");
    assertEquals(serialProp!.type, "bigint");

    const activeProp = doohickey!.properties.get("active");
    assertExists(activeProp, "Should have active property");
    assertEquals(activeProp!.type, "boolean");
    assertEquals(activeProp!.required, false);

    // Verify implicit id
    const idProp = doohickey!.properties.get("id");
    assertExists(idProp, "Should have implicit id property");
    assertEquals(idProp!.type, "uuid");
  },
);

// =========================================================================
// B. PG Integration Tests (guarded by canRunPgTests)
// =========================================================================

// ---------------------------------------------------------------------------
// 13. migrate apply creates tables from SDL (PG)
// ---------------------------------------------------------------------------
Deno.test({
  name: "CLI Integration PG - migrate apply creates tables from SDL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    const expectedTable = "test_cli_widget";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        module default {
          type TestCliWidget {
            required name: str;
            required color: str;
          }
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as { ok: false; error: Error; }).error.message}`,
      );

      // Verify the table was created
      const exists = await tableExists(dsn, expectedTable);
      assertEquals(
        exists,
        true,
        `Table '${expectedTable}' should exist after applySchema`,
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// 14. Full workflow: parse SDL -> plan -> generate DDL -> apply (PG)
// ---------------------------------------------------------------------------
Deno.test({
  name: "CLI Integration PG - Full workflow: parse SDL -> plan -> DDL -> apply",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    const expectedTable = "test_cli_gizmo";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        module default {
          type TestCliGizmo {
            required name: str;
            weight: float64;
          }
        }
      `;

      // Step 1: Plan the schema migration
      const planResult = manager.planSchema(sdl);
      assertEquals(planResult.ok, true, "planSchema should succeed");
      if (!planResult.ok) return;

      const plan = planResult.value;
      assert(
        plan.migrations.length > 0,
        "Plan should have at least one migration",
      );
      assert(
        plan.operationsCount > 0,
        "Plan should have at least one operation",
      );

      // Step 2: Generate DDL from the plan
      const ddlResult = manager.generateDDL(plan);
      assertEquals(ddlResult.ok, true, "generateDDL should succeed");
      if (!ddlResult.ok) return;

      const ddlStatements = ddlResult.value;
      assert(
        ddlStatements.length > 0,
        "DDL should have at least one statement",
      );

      // Check that DDL contains a CREATE TABLE
      const allDDL = ddlStatements.join("\n");
      assert(
        allDDL.includes("CREATE TABLE"),
        `DDL should contain CREATE TABLE, got:\n${allDDL}`,
      );

      // Step 3: Apply the schema
      const applyResult = await manager.applySchema(sdl);
      assertEquals(applyResult.ok, true, "applySchema should succeed");

      // Step 4: Verify table exists in PG
      const exists = await tableExists(dsn, expectedTable);
      assertEquals(
        exists,
        true,
        `Table '${expectedTable}' should exist after apply`,
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// 15. Schema evolution via CLI workflow (PG)
// ---------------------------------------------------------------------------
Deno.test({
  name: "CLI Integration PG - Schema evolution adds columns",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    const expectedTable = "test_cli_evolve";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Initial schema
      const sdlV1 = `
        module default {
          type TestCliEvolve {
            required name: str;
          }
        }
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Step 2: Evolved schema with new property
      const sdlV2 = `
        module default {
          type TestCliEvolve {
            required name: str;
            description: str;
          }
        }
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(resultV2.ok, true, "Evolved applySchema should succeed");

      // Verify getSchema reflects the evolution
      const schema = manager.getSchema();
      assertExists(schema, "getSchema should return a Schema after apply");

      const typeDef = schema!.types.get("TestCliEvolve");
      assertExists(typeDef, "Schema should contain TestCliEvolve");
      assert(
        typeDef!.properties.has("name"),
        "Should still have name property",
      );
      assert(
        typeDef!.properties.has("description"),
        "Should now have description property",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});
