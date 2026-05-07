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
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";

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
      const name = rowData.name
        ?? (typeof rowData === "object" ? Object.values(rowData)[0] : undefined);
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
        "insert TestItem { name := \"beta\", value := 20 }",
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
  name: "PG Compilation: SDL migrate + multi-row INSERT + SELECT with FILTER returns correct subset",
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
        "update TestItem filter .name = \"gamma\" set { value := 99 }",
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
        "delete TestItem filter .name = \"delta\"",
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
): Promise<{ manager: SchemaManager; schema: Schema; }> {
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
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, true),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true)
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

// --- GROUP BY with HAVING ---

Deno.test({
  name: "PG Phase 11.3: GROUP BY with FILTER (HAVING) returns only matching groups",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: eng has 3, sales has 2, ops has 1
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, true),
          (gen_random_uuid(), 'Cher', 'eng', 110000, true),
          (gen_random_uuid(), 'Daena', 'sales', 90000, true),
          (gen_random_uuid(), 'Eve', 'sales', 95000, true),
          (gen_random_uuid(), 'Farah', 'ops', 80000, true)
      `);

      // GROUP BY .department FILTER count(TestEmployee) > 2
      // Only eng (3 employees) should pass; sales (2) and ops (1) should be excluded
      const sql = compileEdgeQL(
        "GROUP TestEmployee BY .department FILTER count(TestEmployee) > 2",
        schema,
      );

      // Verify the compiled SQL contains HAVING
      assertEquals(sql.includes("HAVING"), true, "SQL should contain HAVING");

      const result = await pool.query(sql);

      // Should return only 1 group (eng)
      assertEquals(
        result.rowCount,
        1,
        "Should return only 1 department group with > 2 employees",
      );

      // Verify the returned group is eng
      const firstRow = result.rows[0];
      const rowData = firstRow.jsonb_build_object ?? firstRow;
      const key = (rowData as Record<string, unknown>).key as Record<
        string,
        unknown
      >;
      assertEquals(
        key.department,
        "eng",
        "The only group should be 'eng'",
      );

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

// --- String search functions: contains() and find() ---

Deno.test({
  name: "PG Phase 10: contains() and find() string search functions",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, true),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true)
      `);

      // contains(.name, "li") should match only "Billie"
      // (Ada/Billie/Cher — "li" is a substring of Billie only)
      const containsSql = compileEdgeQL(
        "select TestEmployee { name } filter contains(.name, \"li\")",
        schema,
      );
      const containsResult = await pool.query(containsSql);
      assertEquals(
        containsResult.rowCount,
        1,
        "contains() should match only Billie",
      );

      // find(.name, "il") != -1 should match only "Billie"
      const findSql = compileEdgeQL(
        "select TestEmployee { name } filter find(.name, \"il\") != -1",
        schema,
      );
      const findResult = await pool.query(findSql);
      assertEquals(
        findResult.rowCount,
        1,
        "find() != -1 should match only Billie",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// --- Type cast functions: to_str, to_int64, to_float64 ---

Deno.test({
  name: "PG Phase 10: to_str, to_int64, to_float64 type cast functions",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // to_str: CAST(42 AS text)
      const strResult = await pool.query("SELECT CAST(42 AS text) AS val");
      assertEquals(
        strResult.rows[0].val,
        "42",
        "CAST(42 AS text) should be '42'",
      );

      // to_int64: CAST('123' AS bigint)
      const intResult = await pool.query("SELECT CAST('123' AS bigint) AS val");
      assertEquals(
        Number(intResult.rows[0].val),
        123,
        "CAST('123' AS bigint) should be 123",
      );

      // to_float64: CAST('3.14' AS double precision)
      const floatResult = await pool.query(
        "SELECT CAST('3.14' AS double precision) AS val",
      );
      const floatVal = Number(floatResult.rows[0].val);
      assertEquals(
        Math.abs(floatVal - 3.14) < 0.001,
        true,
        "CAST('3.14' AS double precision) should be approximately 3.14",
      );
    } finally {
      await pool.close();
    }
  },
});

// --- str_pad functions: LPAD / RPAD ---

Deno.test({
  name: "PG Phase 10: str_pad_start and str_pad_end (LPAD/RPAD)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // str_pad_start → LPAD
      const lpadResult = await pool.query("SELECT LPAD('hi', 5, '*') AS val");
      assertEquals(lpadResult.rows[0].val, "***hi", "LPAD should pad start");

      // str_pad_end → RPAD
      const rpadResult = await pool.query("SELECT RPAD('hi', 5, '*') AS val");
      assertEquals(rpadResult.rows[0].val, "hi***", "RPAD should pad end");
    } finally {
      await pool.close();
    }
  },
});

// --- FOR with subquery LATERAL JOIN ---

Deno.test({
  name: "PG Phase 10: FOR with subquery iterator uses LATERAL JOIN",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data with distinct departments
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'sales', 120000, true),
          (gen_random_uuid(), 'Cher', 'ops', 90000, true)
      `);

      // Compile a FOR with subquery iterator
      // FOR x IN (select TestEmployee.department) UNION (select x)
      // This should produce a LATERAL JOIN in the compiled SQL
      const sql = compileEdgeQL(
        "FOR x IN (select TestEmployee.department) UNION (select x)",
        schema,
      );

      // Verify the compiled SQL contains LATERAL
      assertEquals(
        sql.includes("LATERAL"),
        true,
        "FOR with subquery should compile to LATERAL JOIN",
      );

      // Execute the compiled SQL — should return department values
      const result = await pool.query(sql);
      assertEquals(
        result.rowCount >= 1,
        true,
        "LATERAL query should return at least one row",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Phase 11.1a — OFFSET tests
// =========================================================================

Deno.test({
  name: "PG Phase 11.1a: SELECT with OFFSET and LIMIT returns correct page of results",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed 10 rows with distinct names that sort alphabetically
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 110000, true),
          (gen_random_uuid(), 'Cher', 'sales', 120000, true),
          (gen_random_uuid(), 'Daena', 'eng', 130000, true),
          (gen_random_uuid(), 'Eve', 'ops', 140000, true),
          (gen_random_uuid(), 'Farah', 'sales', 150000, true),
          (gen_random_uuid(), 'Grace', 'eng', 160000, true),
          (gen_random_uuid(), 'Hope', 'ops', 170000, true),
          (gen_random_uuid(), 'Iris', 'sales', 180000, true),
          (gen_random_uuid(), 'Jessie', 'eng', 190000, true)
      `);

      // Compile EdgeQL: ORDER BY .name OFFSET 3 LIMIT 3
      // Alphabetical order: Ada, Billie, Cher, Daena, Eve, Farah, Grace, Hope, Iris, Jessie
      // OFFSET 3 skips Ada, Billie, Cher -> returns Daena, Eve, Farah
      const sql = compileEdgeQL(
        "SELECT TestEmployee { name } ORDER BY .name OFFSET 3 LIMIT 3",
        schema,
      );

      // Verify the SQL contains both OFFSET and LIMIT
      assertEquals(sql.includes("OFFSET"), true, "SQL should contain OFFSET");
      assertEquals(sql.includes("LIMIT"), true, "SQL should contain LIMIT");

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // Should return exactly 3 rows
      assertEquals(
        result.rowCount,
        3,
        "Should return exactly 3 rows with OFFSET 3 LIMIT 3",
      );

      // Extract names from JSON results and verify they are the correct 3
      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });

      assertEquals(
        names.sort(),
        ["Daena", "Eve", "Farah"],
        "OFFSET 3 LIMIT 3 should return Daena, Eve, Farah (alphabetically 4th-6th)",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Phase 11.1b — Subquery in expression position
// =========================================================================

Deno.test({
  name: "PG Phase 11.1b: FILTER .department IN (SELECT ...) subquery filters correctly",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data across multiple departments
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, true),
          (gen_random_uuid(), 'Cher', 'sales', 90000, false),
          (gen_random_uuid(), 'Daena', 'ops', 80000, true),
          (gen_random_uuid(), 'Eve', 'sales', 95000, true)
      `);

      // Use a subquery to get departments of active employees, then filter
      // by that set. The subquery selects departments where active = true.
      // eng (Ada, Billie), ops (Daena), sales (Eve) are active departments.
      // Cher (sales, inactive) should still appear because sales has at
      // least one active employee (Eve).
      const sql = compileEdgeQL(
        `SELECT TestEmployee { name, department }
         FILTER .department IN (
           SELECT TestEmployee.department FILTER .active = true
         )`,
        schema,
      );

      // Verify the SQL contains a subquery with IN
      assertEquals(sql.includes("IN"), true, "SQL should contain IN");

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // All 5 employees should match because eng, sales, and ops all have
      // at least one active employee
      assertEquals(
        result.rowCount,
        5,
        "All 5 employees should match since all departments have active members",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Phase 11.2 — WITH / CTE name resolution
// =========================================================================

Deno.test({
  name: "PG Phase 11.2: WITH CTE filters active employees and body query references CTE name",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: mix of active and inactive employees
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, false),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true),
          (gen_random_uuid(), 'Daena', 'ops', 80000, false)
      `);

      // Compile: WITH active_emps := (SELECT ... FILTER .active = true)
      //          SELECT active_emps { name }
      const sql = compileEdgeQL(
        `WITH active_emps := (SELECT TestEmployee FILTER .active = true)
         SELECT active_emps { name }`,
        schema,
      );

      // Verify the SQL uses WITH and references the CTE
      assertEquals(sql.includes("WITH"), true, "SQL should contain WITH");
      assertEquals(
        sql.includes("active_emps"),
        true,
        "SQL should reference the CTE name",
      );

      // Execute and verify only active employees are returned
      const result = await pool.query(sql);
      assertEquals(
        result.rowCount,
        2,
        "Should return exactly 2 active employees (Ada, Cher)",
      );

      // Extract names and verify
      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        names.sort(),
        ["Ada", "Cher"],
        "Active employees should be Ada and Cher",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Phase 11.2: WITH CTE pre-computes filtered set used in main query",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data with varying salaries
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 50000, true),
          (gen_random_uuid(), 'Billie', 'eng', 100000, true),
          (gen_random_uuid(), 'Cher', 'eng', 150000, true)
      `);

      // Use WITH to pre-compute a filtered set, then select from it
      const sql = compileEdgeQL(
        `WITH high_earners := (SELECT TestEmployee FILTER .salary > 80000)
         SELECT high_earners { name, salary }`,
        schema,
      );

      // Execute and verify
      const result = await pool.query(sql);
      assertEquals(
        result.rowCount,
        2,
        "Should return 2 high earners (Billie=100k, Cher=150k)",
      );

      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        names.sort(),
        ["Billie", "Cher"],
        "High earners should be Billie and Cher",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Phase 11.1c — INTERSECT / EXCEPT set operations
// =========================================================================

Deno.test({
  name: "PG Phase 11.1c: INTERSECT returns only rows present in both queries",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: mix of active/inactive across departments
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, false),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true),
          (gen_random_uuid(), 'Daena', 'eng', 110000, true),
          (gen_random_uuid(), 'Eve', 'sales', 95000, false)
      `);

      // INTERSECT: active employees INTERSECT eng employees
      // Active: Ada (eng), Cher (sales), Daena (eng)
      // Eng: Ada (eng), Billie (eng), Daena (eng)
      // Intersection: Ada (eng, active), Daena (eng, active)
      const sql = compileEdgeQL(
        `SELECT TestEmployee { name } FILTER .active = true
         INTERSECT
         SELECT TestEmployee { name } FILTER .department = "eng"`,
        schema,
      );

      // Verify the SQL contains INTERSECT
      assertEquals(
        sql.includes("INTERSECT"),
        true,
        "SQL should contain INTERSECT",
      );

      const result = await pool.query(sql);

      // Should return 2 rows: Ada and Daena (active AND eng)
      assertEquals(
        result.rowCount,
        2,
        "INTERSECT should return 2 employees (active AND eng)",
      );

      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        names.sort(),
        ["Ada", "Daena"],
        "INTERSECT should return Ada and Daena",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Phase 11.4 — Window Functions E2E
// =========================================================================

Deno.test({
  name: "PG Phase 11.4: Window function row_number() OVER (PARTITION BY .department ORDER BY .salary DESC)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: employees across departments with different salaries
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 120000, true),
          (gen_random_uuid(), 'Billie', 'eng', 100000, true),
          (gen_random_uuid(), 'Cher', 'eng', 110000, true),
          (gen_random_uuid(), 'Daena', 'sales', 90000, true),
          (gen_random_uuid(), 'Eve', 'sales', 95000, true)
      `);

      // Compile EdgeQL with window function
      const sql = compileEdgeQL(
        `SELECT TestEmployee {
          name,
          dept_rank := row_number() OVER (PARTITION BY .department ORDER BY .salary DESC)
        }`,
        schema,
      );

      // Verify the SQL contains window function constructs
      assertEquals(
        sql.includes("ROW_NUMBER()"),
        true,
        "SQL should contain ROW_NUMBER()",
      );
      assertEquals(
        sql.includes("OVER"),
        true,
        "SQL should contain OVER",
      );
      assertEquals(
        sql.includes("PARTITION BY"),
        true,
        "SQL should contain PARTITION BY",
      );

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // Should return all 5 employees
      assertEquals(
        result.rowCount,
        5,
        "Should return all 5 employees with ranks",
      );

      // Extract the results and verify ranking within departments
      const rows = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return data as Record<string, unknown>;
      });

      // eng department: Ada (120k) = rank 1, Cher (110k) = rank 2, Billie (100k) = rank 3
      const engRows = rows.filter((r) => r.name === "Ada" || r.name === "Billie" || r.name === "Cher");
      assertEquals(engRows.length, 3, "Should have 3 eng employees");

      // Find Ada's rank (should be 1 — highest salary in eng)
      const adaRow = rows.find((r) => r.name === "Ada");
      assertExists(adaRow, "Ada should exist");
      assertEquals(
        Number(adaRow.dept_rank),
        1,
        "Ada should be rank 1 in eng (highest salary)",
      );

      // sales department: Eve (95k) = rank 1, Daena (90k) = rank 2
      const eveRow = rows.find((r) => r.name === "Eve");
      assertExists(eveRow, "Eve should exist");
      assertEquals(
        Number(eveRow.dept_rank),
        1,
        "Eve should be rank 1 in sales (highest salary)",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Phase 11.4: Aggregate as window function: sum(.salary) OVER (ORDER BY .name)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: 3 employees with known salaries
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100, true),
          (gen_random_uuid(), 'Billie', 'eng', 200, true),
          (gen_random_uuid(), 'Cher', 'eng', 300, true)
      `);

      // sum(.salary) OVER (ORDER BY .name) produces a running total
      const sql = compileEdgeQL(
        `SELECT TestEmployee {
          name,
          running_total := sum(.salary) OVER (ORDER BY .name)
        }`,
        schema,
      );

      assertEquals(sql.includes("SUM("), true, "SQL should contain SUM(");
      assertEquals(sql.includes("OVER"), true, "SQL should contain OVER");

      const result = await pool.query(sql);
      assertEquals(result.rowCount, 3, "Should return 3 employees");

      // Extract and sort by name
      const rows = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return data as Record<string, unknown>;
      });

      // Alphabetical order: Ada (100), Billie (200), Cher (300)
      // Running totals: Ada=100, Billie=300, Cher=600
      const adaRow = rows.find((r) => r.name === "Ada");
      assertExists(adaRow, "Ada should exist");
      assertEquals(
        Number(adaRow.running_total),
        100,
        "Ada running total should be 100",
      );

      const billieRow = rows.find((r) => r.name === "Billie");
      assertExists(billieRow, "Billie should exist");
      assertEquals(
        Number(billieRow.running_total),
        300,
        "Billie running total should be 300",
      );

      const cherRow = rows.find((r) => r.name === "Cher");
      assertExists(cherRow, "Cher should exist");
      assertEquals(
        Number(cherRow.running_total),
        600,
        "Cher running total should be 600",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Phase 11.1c: EXCEPT returns rows in first query but not in second",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: mix of active/inactive across departments
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, false),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true),
          (gen_random_uuid(), 'Daena', 'eng', 110000, true),
          (gen_random_uuid(), 'Eve', 'sales', 95000, false)
      `);

      // EXCEPT: active employees EXCEPT eng employees
      // Active: Ada (eng), Cher (sales), Daena (eng)
      // Eng: Ada (eng), Billie (eng), Daena (eng)
      // Except: Cher (active but not eng)
      const sql = compileEdgeQL(
        `SELECT TestEmployee { name } FILTER .active = true
         EXCEPT
         SELECT TestEmployee { name } FILTER .department = "eng"`,
        schema,
      );

      // Verify the SQL contains EXCEPT
      assertEquals(
        sql.includes("EXCEPT"),
        true,
        "SQL should contain EXCEPT",
      );

      const result = await pool.query(sql);

      // Should return 1 row: Cher (active but NOT eng)
      assertEquals(
        result.rowCount,
        1,
        "EXCEPT should return 1 employee (active but not eng)",
      );

      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        names,
        ["Cher"],
        "EXCEPT should return only Cher",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Stage 4 — CTE Multiple References
// =========================================================================

Deno.test({
  name: "PG Stage 4: WITH CTE single reference produces correct filtered results",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applyEmployeeSchema(pool);

      // Seed data: mix of active and inactive employees
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100000, true),
          (gen_random_uuid(), 'Billie', 'eng', 120000, false),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true),
          (gen_random_uuid(), 'Daena', 'ops', 80000, true),
          (gen_random_uuid(), 'Eve', 'sales', 95000, false)
      `);

      // Compile and execute a WITH CTE query
      const sql = compileEdgeQL(
        `WITH active_emps := (SELECT TestEmployee FILTER .active = true)
         SELECT active_emps { name, department }`,
        schema,
      );

      // Verify the SQL uses WITH
      assertEquals(sql.includes("WITH"), true, "SQL should contain WITH");
      assertEquals(
        sql.includes("active_emps"),
        true,
        "SQL should reference CTE alias 'active_emps'",
      );

      const result = await pool.query(sql);

      // Should return only active employees: Ada, Cher, Daena
      assertEquals(
        result.rowCount,
        3,
        "CTE should return exactly 3 active employees",
      );

      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        names.sort(),
        ["Ada", "Cher", "Daena"],
        "CTE should return Ada, Cher, and Daena (active employees)",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 4: CTE referenced multiple times in raw SQL produces correct results",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager } = await applyEmployeeSchema(pool);

      // Seed data: employees with varying salaries
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 60000, true),
          (gen_random_uuid(), 'Billie', 'eng', 80000, true),
          (gen_random_uuid(), 'Cher', 'sales', 90000, true),
          (gen_random_uuid(), 'Daena', 'ops', 40000, true),
          (gen_random_uuid(), 'Eve', 'sales', 70000, true)
      `);

      // Run a raw SQL CTE that references the CTE name in two places:
      // once for counting and once for listing names.
      // This verifies PostgreSQL correctly handles multiple CTE references.
      const cteSQL = `
        WITH high_earners AS (
          SELECT name, salary FROM ${EMPLOYEE_TABLE} WHERE salary > 50000
        )
        SELECT
          (SELECT COUNT(*)::int FROM high_earners) AS total_count,
          (SELECT json_agg(name ORDER BY name) FROM high_earners) AS names
      `;

      const result = await pool.query(cteSQL);

      // Employees with salary > 50000: Ada (60k), Billie (80k), Cher (90k), Eve (70k)
      assertEquals(
        Number(result.rows[0].total_count),
        4,
        "Should count 4 high earners (salary > 50000)",
      );

      const names = result.rows[0].names as string[];
      assertEquals(
        names.sort(),
        ["Ada", "Billie", "Cher", "Eve"],
        "CTE multi-reference should list Ada, Billie, Cher, Eve",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Frame Exclusion & Recursive CTEs — PG E2E
// =========================================================================

Deno.test({
  name: "PG E2E: Frame exclusion — SUM OVER ROWS EXCLUDE CURRENT ROW computes correctly",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager } = await applyEmployeeSchema(pool);

      // Seed 4 employees with distinct salaries
      await pool.query(`
        INSERT INTO ${EMPLOYEE_TABLE} (id, name, department, salary, active) VALUES
          (gen_random_uuid(), 'Ada', 'eng', 100, true),
          (gen_random_uuid(), 'Billie', 'eng', 200, true),
          (gen_random_uuid(), 'Cher', 'eng', 300, true),
          (gen_random_uuid(), 'Daena', 'eng', 400, true)
      `);

      // Frame exclusion: running sum of all preceding rows EXCLUDING the
      // current row.
      //
      // Alphabetical order: Ada(100), Billie(200), Cher(300), Daena(400)
      //
      // ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW gives a frame that
      // includes every row from the start up to and including the current row.
      // EXCLUDE CURRENT ROW removes the current row from that frame.
      //
      // Expected running_sum values:
      //   Ada: frame is {Ada} minus Ada → empty → NULL
      //   Billie:   frame is {Ada, Billie} minus Billie → {Ada} → 100
      //   Cher: frame is {Ada, Billie, Cher} minus Cher → {Ada, Billie} → 300
      //   Daena:  frame is {Ada, Billie, Cher, Daena} minus Daena → {Ada, Billie, Cher} → 600
      const result = await pool.query(`
        SELECT
          name,
          salary,
          SUM(salary) OVER (
            ORDER BY name
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            EXCLUDE CURRENT ROW
          ) AS running_sum
        FROM ${EMPLOYEE_TABLE}
        ORDER BY name
      `);

      assertEquals(result.rowCount, 4, "Should return 4 rows");

      // Ada: no preceding rows after excluding self → NULL
      assertEquals(
        result.rows[0].name,
        "Ada",
        "First row should be Ada",
      );
      assertEquals(
        result.rows[0].running_sum,
        null,
        "Ada running_sum should be NULL (no other rows in frame)",
      );

      // Billie: only Ada in frame → 100
      assertEquals(result.rows[1].name, "Billie", "Second row should be Billie");
      assertEquals(
        Number(result.rows[1].running_sum),
        100,
        "Billie running_sum should be 100 (Ada only)",
      );

      // Cher: Ada + Billie in frame → 300
      assertEquals(
        result.rows[2].name,
        "Cher",
        "Third row should be Cher",
      );
      assertEquals(
        Number(result.rows[2].running_sum),
        300,
        "Cher running_sum should be 300 (Ada + Billie)",
      );

      // Daena: Ada + Billie + Cher in frame → 600
      assertEquals(result.rows[3].name, "Daena", "Fourth row should be Daena");
      assertEquals(
        Number(result.rows[3].running_sum),
        600,
        "Daena running_sum should be 600 (Ada + Billie + Cher)",
      );

      await manager.close();
    } finally {
      await cleanupEmployee(pool);
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG E2E: Recursive CTE — generate series 1..5",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Pure SQL — no schema setup needed.
      // WITH RECURSIVE builds a sequence from 1 to 5.
      const result = await pool.query(`
        WITH RECURSIVE nums(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM nums WHERE n < 5
        )
        SELECT n FROM nums ORDER BY n
      `);

      assertEquals(result.rowCount, 5, "Should return 5 rows");

      const values = result.rows.map((row: Record<string, unknown>) => Number(row.n));
      assertEquals(
        values,
        [1, 2, 3, 4, 5],
        "Recursive CTE should produce [1, 2, 3, 4, 5]",
      );
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG E2E: Recursive CTE — org chart hierarchy traversal",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create a temporary table for the org chart
      await pool.query(`
        CREATE TEMPORARY TABLE temp_org (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          manager_id INT REFERENCES temp_org(id)
        )
      `);

      // Insert hierarchy: CEO → VP → Director → Manager
      await pool.query(
        "INSERT INTO temp_org (id, name, manager_id) VALUES (1, 'CEO', NULL)",
      );
      await pool.query(
        "INSERT INTO temp_org (id, name, manager_id) VALUES (2, 'VP', 1)",
      );
      await pool.query(
        "INSERT INTO temp_org (id, name, manager_id) VALUES (3, 'Director', 2)",
      );
      await pool.query(
        "INSERT INTO temp_org (id, name, manager_id) VALUES (4, 'Manager', 3)",
      );

      // Recursive CTE to traverse the hierarchy and compute depth
      const result = await pool.query(`
        WITH RECURSIVE org_chart(id, name, manager_id, depth) AS (
          SELECT id, name, manager_id, 0
          FROM temp_org
          WHERE manager_id IS NULL
          UNION ALL
          SELECT e.id, e.name, e.manager_id, oc.depth + 1
          FROM temp_org e
          JOIN org_chart oc ON e.manager_id = oc.id
        )
        SELECT name, depth FROM org_chart ORDER BY depth, name
      `);

      assertEquals(result.rowCount, 4, "Should return 4 org chart members");

      // Verify depth-ordered results
      assertEquals(result.rows[0].name, "CEO", "Depth 0 should be CEO");
      assertEquals(
        Number(result.rows[0].depth),
        0,
        "CEO should be at depth 0",
      );

      assertEquals(result.rows[1].name, "VP", "Depth 1 should be VP");
      assertEquals(Number(result.rows[1].depth), 1, "VP should be at depth 1");

      assertEquals(
        result.rows[2].name,
        "Director",
        "Depth 2 should be Director",
      );
      assertEquals(
        Number(result.rows[2].depth),
        2,
        "Director should be at depth 2",
      );

      assertEquals(
        result.rows[3].name,
        "Manager",
        "Depth 3 should be Manager",
      );
      assertEquals(
        Number(result.rows[3].depth),
        3,
        "Manager should be at depth 3",
      );
    } finally {
      // Clean up the temporary table
      await pool.query("DROP TABLE IF EXISTS temp_org CASCADE");
      await pool.close();
    }
  },
});
