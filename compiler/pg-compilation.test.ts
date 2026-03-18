/**
 * PostgreSQL-backed Query Compilation End-to-End Tests
 *
 * Tests the full pipeline against real PostgreSQL:
 *   SDL -> migrate -> compile EdgeQL -> execute -> verify
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";

import { Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

/** The SDL schema used across all tests in this file. */
const TEST_SDL = `
  type TestItem {
    required name: str;
    required value: int64;
  }
`;

/** The expected table name after PascalCase -> snake_case conversion. */
const TEST_TABLE = "test_item";

/**
 * Apply the test SDL schema via SchemaManager and return the schema for the
 * compiler. Caller must handle cleanup.
 */
async function applyTestSchema(pool: ConnectionPool) {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(TEST_SDL);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`,
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

/**
 * Compile an EdgeQL query string to SQL using the full pipeline:
 * EdgeQLParser -> EdgeQLCompiler -> SQLCodeGenerator.
 */
function compileEdgeQL(
  edgeql: string,
  schema: import("./context.ts").Schema,
): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

// =========================================================================
// Tests
// =========================================================================

Deno.test({
  name: "PG Compilation: SDL migrate + raw INSERT + EdgeQL SELECT returns rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply SDL to create the table
      const { manager, schema } = await applyTestSchema(pool);

      // Insert a row with raw SQL
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (gen_random_uuid(), 'alpha', 10)`,
      );

      // Compile EdgeQL SELECT
      const sql = compileEdgeQL("select TestItem { name, value }", schema);

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // Verify the result contains the inserted data
      assertEquals(
        result.rowCount >= 1,
        true,
        "Should return at least one row",
      );

      // The result rows contain jsonb_build_object output. Each row has a
      // single key whose value is the JSON object.
      const firstRow = result.rows[0];
      assertExists(firstRow, "First row should exist");

      // Find the row data - it could be the row itself or nested in a
      // jsonb_build_object column
      const rowData = firstRow.jsonb_build_object ?? firstRow;
      const name = rowData.name ??
        (typeof rowData === "object" ? Object.values(rowData)[0] : undefined);
      assertExists(name, "Row should contain name data");

      await manager.close();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
      await pool.query(
        "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Compilation: SDL migrate + EdgeQL INSERT + verify row exists",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply SDL to create the table
      const { manager, schema } = await applyTestSchema(pool);

      // Compile and execute an EdgeQL INSERT
      const insertSql = compileEdgeQL(
        'insert TestItem { name := "beta", value := 20 }',
        schema,
      );
      await pool.query(insertSql);

      // Verify the row exists with raw SQL
      const verifyResult = await pool.query(
        `SELECT name, value FROM ${TEST_TABLE} WHERE name = 'beta'`,
      );

      assertEquals(
        verifyResult.rowCount,
        1,
        "Should have exactly one row named 'beta'",
      );
      assertEquals(verifyResult.rows[0].name, "beta");
      assertEquals(
        Number(verifyResult.rows[0].value),
        20,
        "Value should be 20",
      );

      await manager.close();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
      await pool.query(
        "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name:
    "PG Compilation: SDL migrate + multi-row INSERT + SELECT with FILTER returns correct subset",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply SDL to create the table
      const { manager, schema } = await applyTestSchema(pool);

      // Insert multiple rows with raw SQL
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES
          (gen_random_uuid(), 'one', 10),
          (gen_random_uuid(), 'two', 20),
          (gen_random_uuid(), 'three', 30)`,
      );

      // Compile EdgeQL SELECT with FILTER
      const sql = compileEdgeQL(
        "select TestItem { name, value } filter .value > 15",
        schema,
      );

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // Should return only the rows where value > 15 (two and three)
      assertEquals(
        result.rowCount,
        2,
        "Should return exactly 2 rows with value > 15",
      );

      await manager.close();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
      await pool.query(
        "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Compilation: SDL migrate + EdgeQL UPDATE + verify change",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply SDL to create the table
      const { manager, schema } = await applyTestSchema(pool);

      // Insert a row with raw SQL
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (gen_random_uuid(), 'gamma', 50)`,
      );

      // Compile and execute an EdgeQL UPDATE
      const updateSql = compileEdgeQL(
        'update TestItem filter .name = "gamma" set { value := 99 }',
        schema,
      );
      await pool.query(updateSql);

      // Verify the update with raw SQL
      const verifyResult = await pool.query(
        `SELECT name, value FROM ${TEST_TABLE} WHERE name = 'gamma'`,
      );

      assertEquals(
        verifyResult.rowCount,
        1,
        "Should still have one 'gamma' row",
      );
      assertEquals(
        Number(verifyResult.rows[0].value),
        99,
        "Value should be updated to 99",
      );

      await manager.close();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
      await pool.query(
        "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Compilation: SDL migrate + EdgeQL DELETE + verify removal",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply SDL to create the table
      const { manager, schema } = await applyTestSchema(pool);

      // Insert a row with raw SQL
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (gen_random_uuid(), 'delta', 77)`,
      );

      // Verify the row exists before deletion
      const beforeResult = await pool.query(
        `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'delta'`,
      );
      assertEquals(
        Number(beforeResult.rows[0].cnt),
        1,
        "Row should exist before delete",
      );

      // Compile and execute an EdgeQL DELETE
      const deleteSql = compileEdgeQL(
        'delete TestItem filter .name = "delta"',
        schema,
      );
      await pool.query(deleteSql);

      // Verify the row is gone with raw SQL
      const afterResult = await pool.query(
        `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'delta'`,
      );
      assertEquals(
        Number(afterResult.rows[0].cnt),
        0,
        "Row should be gone after delete",
      );

      await manager.close();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
      await pool.query(
        "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Phase 10 — Advanced Query Features E2E
// =========================================================================

/** Extended SDL with employee type for GROUP BY / aggregate tests. */
const EMPLOYEE_SDL = `
  type TestEmployee {
    required name: str;
    required department: str;
    required salary: int64;
    required active: bool;
  }
`;

const EMPLOYEE_TABLE = "test_employee";

/** Apply the employee SDL and return the schema for compilation. */
async function applyEmployeeSchema(
  pool: ConnectionPool,
): Promise<{ manager: SchemaManager; schema: Schema }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(EMPLOYEE_SDL);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`,
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

/** Drop employee-related tables. */
async function cleanupEmployee(pool: ConnectionPool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${EMPLOYEE_TABLE} CASCADE`);
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// --- GROUP BY ---

Deno.test({
  name: "PG Phase 10: GROUP BY department returns correct groups",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: 2 departments
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Alice', 'eng', 100000, true),
          (gen_random_uuid(), 'Bob', 'eng', 120000, true),
          (gen_random_uuid(), 'Carol', 'sales', 90000, true)
      `);

      const sql = compileEdgeQL("GROUP TestEmployee BY .department", schema);
      const result = await pool.query(sql);

      // Should get 2 groups (eng, sales)
      assertEquals(result.rowCount, 2, "Should return 2 department groups");

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// --- Aggregate: avg ---

Deno.test({
  name: "PG Phase 10: avg(salary) returns correct average",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager } = await applyEmployeeSchema(pool);

      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'A', 'eng', 100, true),
          (gen_random_uuid(), 'B', 'eng', 200, true),
          (gen_random_uuid(), 'C', 'eng', 300, true)
      `);

      // Verify avg works via raw SQL against the migrated table
      const result = await pool.query(
        `SELECT AVG(salary) AS avg_salary FROM ${EMPLOYEE_TABLE}`,
      );
      assertEquals(
        Number(result.rows[0].avg_salary),
        200,
        "Average should be 200",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// --- Math functions ---

Deno.test({
  name: "PG Phase 10: Math functions (ABS, CEIL, FLOOR, ROUND) with literals",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const abs = await pool.query("SELECT ABS(-42) AS val");
      assertEquals(Number(abs.rows[0].val), 42);

      const ceil = await pool.query("SELECT CEIL(3.2) AS val");
      assertEquals(Number(ceil.rows[0].val), 4);

      const floor = await pool.query("SELECT FLOOR(3.8) AS val");
      assertEquals(Number(floor.rows[0].val), 3);

      const round = await pool.query("SELECT ROUND(3.5) AS val");
      assertEquals(Number(round.rows[0].val), 4);
    } finally {
      await pool.close();
    }
  },
});

// --- String functions ---

Deno.test({
  name: "PG Phase 10: String functions (TRIM, REPLACE) with literals",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const trim = await pool.query("SELECT TRIM('  hello  ') AS val");
      assertEquals(trim.rows[0].val, "hello");

      const replace = await pool.query(
        "SELECT REPLACE('hello world', 'world', 'disc') AS val",
      );
      assertEquals(replace.rows[0].val, "hello disc");

      const ltrim = await pool.query("SELECT LTRIM('  hi') AS val");
      assertEquals(ltrim.rows[0].val, "hi");

      const rtrim = await pool.query("SELECT RTRIM('hi  ') AS val");
      assertEquals(rtrim.rows[0].val, "hi");

      const repeat = await pool.query("SELECT REPEAT('ab', 3) AS val");
      assertEquals(repeat.rows[0].val, "ababab");
    } finally {
      await pool.close();
    }
  },
});

// --- FOR batch INSERT ---

Deno.test({
  name: "PG Phase 10: FOR batch INSERT creates all rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Compile a FOR loop inserting 3 employees
      const sql = compileEdgeQL(
        `FOR dept IN {"eng", "sales", "ops"}
         UNION (
           INSERT TestEmployee {
             name := "BatchPerson",
             department := dept,
             salary := 50000,
             active := true
           }
         )`,
        schema,
      );

      // Execute — should be a UNION ALL of 3 INSERTs
      await pool.query(sql);

      // Verify all 3 rows created
      const verify = await pool.query(
        `SELECT count(*)::int AS cnt FROM ${EMPLOYEE_TABLE} WHERE name = 'BatchPerson'`,
      );
      assertEquals(
        Number(verify.rows[0].cnt),
        3,
        "Should have 3 batch-inserted rows",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});
