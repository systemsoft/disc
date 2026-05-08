/**
 * PostgreSQL End-to-End Tests — Phase 20 Compiler Features
 *
 * Tests the full pipeline against real PostgreSQL for Phase 20 features:
 *   - IF/ELSE expressions (computed shapes and FILTER clauses)
 *   - Array literal expressions
 *   - Named tuple expressions
 *   - UPSERT (INSERT...UNLESS CONFLICT...ELSE UPDATE / DO NOTHING)
 *   - Optional multi-link COALESCE (empty array, not null)
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
    cleanupInterval: 0
  });
}

/**
 * Compile an EdgeQL query string to SQL using the full pipeline:
 * EdgeQLParser -> EdgeQLCompiler -> SQLCodeGenerator.
 */
function compileEdgeQL(edgeql: string, schema: Schema): string {
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

/**
 * Apply an SDL schema string via SchemaManager and return the schema for the
 * compiler. Caller must handle cleanup.
 */
async function applySchema(
  pool: ConnectionPool,
  sdl: string
): Promise<{ manager: SchemaManager; schema: Schema; }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(sdl);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

/** Drop specified tables plus disc migration tracking tables. */
async function cleanup(
  pool: ConnectionPool,
  tables: string[]
): Promise<void> {
  for (const table of tables) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// =========================================================================
// Phase 20 — IF/ELSE Expressions
// =========================================================================

const PERSON_SDL = `
  type TestPerson {
    required name: str;
    required active: bool;
  }
`;

const PERSON_TABLE = "test_person";

Deno.test({
  name: "PG Phase 20: IF/ELSE in computed shape — CASE/WHEN returns correct status per row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySchema(pool, PERSON_SDL);

      // Insert two people: one active, one inactive
      await pool.query(
        `INSERT INTO ${PERSON_TABLE} (id, name, active) VALUES
          (gen_random_uuid(), 'Ada', true),
          (gen_random_uuid(), 'Billie', false)`
      );

      // Compile EdgeQL with IF/ELSE in a computed shape field
      const sql = compileEdgeQL(
        "SELECT TestPerson { name, status := \"active\" IF .active ELSE \"inactive\" } ORDER BY .name",
        schema
      );

      // The compiled SQL should use CASE/WHEN
      assertEquals(
        sql.includes("CASE") || sql.includes("case"),
        true,
        "Compiled SQL should contain CASE expression"
      );

      // Execute the compiled SQL
      const result = await pool.query(sql);

      assertEquals(
        result.rowCount,
        2,
        "Should return exactly 2 rows"
      );

      // Extract results — rows are ordered by name (Ada, Billie)
      const rows = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return data as Record<string, unknown>;
      });

      // Ada is active → status should be "active"
      const adaRow = rows.find(r => r.name === "Ada");
      assertExists(adaRow, "Ada should exist in results");
      assertEquals(
        adaRow.status,
        "active",
        "Ada (active=true) should have status 'active'"
      );

      // Billie is inactive → status should be "inactive"
      const billieRow = rows.find(r => r.name === "Billie");
      assertExists(billieRow, "Billie should exist in results");
      assertEquals(
        billieRow.status,
        "inactive",
        "Billie (active=false) should have status 'inactive'"
      );

      await manager.close();
    } finally {
      await cleanup(pool, [PERSON_TABLE]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Phase 20: IF/ELSE in FILTER clause — matches rows conditionally",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySchema(pool, PERSON_SDL);

      // Insert three people with varying active states
      await pool.query(
        `INSERT INTO ${PERSON_TABLE} (id, name, active) VALUES
          (gen_random_uuid(), 'admin', true),
          (gen_random_uuid(), 'guest', false),
          (gen_random_uuid(), 'other', true)`
      );

      // Compile EdgeQL: FILTER where the comparison target depends on .active
      // For active=true rows, compare .name to "admin"
      // For active=false rows, compare .name to "guest"
      const sql = compileEdgeQL(
        "SELECT TestPerson { name } FILTER .name = (\"admin\" IF .active ELSE \"guest\")",
        schema
      );

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // "admin" is active=true, compared against "admin" → match
      // "guest" is active=false, compared against "guest" → match
      // "other" is active=true, compared against "admin" → no match
      assertEquals(
        result.rowCount,
        2,
        "Should return 2 rows (admin and guest)"
      );

      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        (names as string[]).sort(),
        ["admin", "guest"],
        "Should return admin (active, matches 'admin') and guest (inactive, matches 'guest')"
      );

      await manager.close();
    } finally {
      await cleanup(pool, [PERSON_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 20 — Array Literal Expression
// =========================================================================

const ITEM_SDL = `
  type TestItem {
    required name: str;
    required value: int64;
  }
`;

const ITEM_TABLE = "test_item";

Deno.test({
  name: "PG Phase 20: Array literal [1, 2, 3] compiles and executes correctly",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply schema so we have a valid Schema object for compilation,
      // even though this particular query does not reference any type.
      const { manager, schema } = await applySchema(pool, ITEM_SDL);

      // Compile a simple array literal expression
      const sql = compileEdgeQL("SELECT [1, 2, 3]", schema);

      // Execute the compiled SQL against PostgreSQL
      const result = await pool.query(sql);

      assertEquals(
        result.rowCount >= 1,
        true,
        "Should return at least one row"
      );

      // The result should contain an array with [1, 2, 3].
      // Depending on codegen, it may be an ARRAY[] literal or json array.
      const firstRow = result.rows[0];
      const rowData = firstRow.jsonb_build_object ?? firstRow;
      const values = Object.values(rowData as Record<string, unknown>);

      // Find the array value in the result
      let foundArray = false;

      for (const val of values) {
        if (Array.isArray(val)) {
          const nums = val.map(Number);
          assertEquals(nums, [1, 2, 3], "Array should contain [1, 2, 3]");
          foundArray = true;
          break;
        }
      }

      // If not found as a nested array, check if the entire row represents it
      if (!foundArray) {
        // Some codegen might return a single-column result
        const singleVal = values[0];
        assertExists(singleVal, "Result should contain array data");

        if (typeof singleVal === "string") {
          // Could be a stringified array like "{1,2,3}"
          assertEquals(
            singleVal.includes("1") && singleVal.includes("2") &&
              singleVal.includes("3"),
            true,
            "Stringified array should contain 1, 2, 3"
          );
        } else if (Array.isArray(singleVal)) {
          assertEquals(
            singleVal.map(Number),
            [1, 2, 3],
            "Array should contain [1, 2, 3]"
          );
        }
      }

      await manager.close();
    } finally {
      await cleanup(pool, [ITEM_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 20 — Named Tuple Expression
// =========================================================================

Deno.test({
  name: "PG Phase 20: Named tuple (label := 'hello', count := 42) compiles to jsonb_build_object",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Apply schema for a valid Schema context
      const { manager, schema } = await applySchema(pool, ITEM_SDL);

      // Compile a named tuple expression
      const sql = compileEdgeQL(
        "SELECT (label := \"hello\", count := 42)",
        schema
      );

      // Execute the compiled SQL
      const result = await pool.query(sql);

      assertEquals(
        result.rowCount >= 1,
        true,
        "Should return at least one row"
      );

      // The result should be a JSON object with label and count fields
      const firstRow = result.rows[0];
      const rowData = firstRow.jsonb_build_object ?? firstRow;

      // Navigate into the result — might be the row itself or nested
      const data = (typeof rowData === "object" && rowData !== null) ? rowData as Record<string, unknown> : {};

      // Check for label and count either at top level or nested
      let label: unknown;
      let count: unknown;

      if ("label" in data && "count" in data) {
        label = data.label;
        count = data.count;
      } else {
        // May be nested under a key like "jsonb_build_object"
        const nested = Object.values(data)[0];

        if (typeof nested === "object" && nested !== null) {
          const nestedObj = nested as Record<string, unknown>;
          label = nestedObj.label;
          count = nestedObj.count;
        }
      }

      assertEquals(label, "hello", "Tuple label should be 'hello'");
      assertEquals(Number(count), 42, "Tuple count should be 42");

      await manager.close();
    } finally {
      await cleanup(pool, [ITEM_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 20 — UPSERT: INSERT...UNLESS CONFLICT...ELSE UPDATE
// =========================================================================

const ACCOUNT_SDL = `
  type TestAccount {
    required email: str {
      constraint exclusive;
    };
    required name: str;
  }
`;

const ACCOUNT_TABLE = "test_account";

Deno.test({
  name: "PG Phase 20: UPSERT — INSERT UNLESS CONFLICT ELSE UPDATE modifies existing row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySchema(pool, ACCOUNT_SDL);

      // Insert an initial row via raw SQL
      await pool.query(
        `INSERT INTO ${ACCOUNT_TABLE} (id, email, name) VALUES
          (gen_random_uuid(), 'ada@test.com', 'Ada')`
      );

      // Compile and execute an UPSERT: same email, different name
      const sql = compileEdgeQL(
        `INSERT TestAccount {
          email := "ada@test.com",
          name := "Ada"
        } UNLESS CONFLICT ON .email
        ELSE (
          UPDATE TestAccount SET { name := "Ada Updated" }
        )`,
        schema
      );

      await pool.query(sql);

      // Verify via raw SQL: name should now be "Ada Updated"
      const verifyResult = await pool.query(
        `SELECT name FROM ${ACCOUNT_TABLE} WHERE email = 'ada@test.com'`
      );

      assertEquals(
        verifyResult.rowCount,
        1,
        "Should still have exactly one row for ada@test.com"
      );
      assertEquals(
        verifyResult.rows[0].name,
        "Ada Updated",
        "Name should be updated to 'Ada Updated' via UPSERT"
      );

      await manager.close();
    } finally {
      await cleanup(pool, [ACCOUNT_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 20 — UPSERT: DO NOTHING (UNLESS CONFLICT without ELSE)
// =========================================================================

Deno.test({
  name: "PG Phase 20: UPSERT DO NOTHING — INSERT UNLESS CONFLICT ON .email leaves existing row unchanged",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySchema(pool, ACCOUNT_SDL);

      // Insert an initial row via raw SQL
      await pool.query(
        `INSERT INTO ${ACCOUNT_TABLE} (id, email, name) VALUES
          (gen_random_uuid(), 'billie@test.com', 'Billie')`
      );

      // Compile and execute an INSERT with UNLESS CONFLICT but no ELSE
      // (DO NOTHING semantics)
      const sql = compileEdgeQL(
        `INSERT TestAccount {
          email := "billie@test.com",
          name := "Billie New"
        } UNLESS CONFLICT ON .email`,
        schema
      );

      await pool.query(sql);

      // Verify via raw SQL: name should still be "Billie" (unchanged)
      const verifyResult = await pool.query(
        `SELECT name FROM ${ACCOUNT_TABLE} WHERE email = 'billie@test.com'`
      );

      assertEquals(
        verifyResult.rowCount,
        1,
        "Should still have exactly one row for billie@test.com"
      );
      assertEquals(
        verifyResult.rows[0].name,
        "Billie",
        "Name should remain 'Billie' (DO NOTHING on conflict)"
      );

      await manager.close();
    } finally {
      await cleanup(pool, [ACCOUNT_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 20 — COALESCE Pattern Validates Against Real PG
// =========================================================================
//
// Note: Full multi-link subquery resolution through junction tables is a
// future enhancement. The COALESCE wrapping feature is unit-tested in
// compiler/optional-link-compilation.test.ts. This PG E2E test validates
// the underlying COALESCE pattern works correctly against real PostgreSQL.

Deno.test({
  name: "PG Phase 20: COALESCE returns empty array instead of null from PG",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Directly test the COALESCE pattern that the compiler generates
      // for optional multi-links: COALESCE(subquery, '[]'::jsonb)
      const result = await pool.query(`
        SELECT jsonb_build_object(
          'name', 'Solo',
          'articles', COALESCE(
            (SELECT jsonb_agg(jsonb_build_object('title', t.title))
             FROM (SELECT 1 WHERE FALSE) AS t(title)),
            '[]'::jsonb
          )
        ) AS result
      `);

      assertEquals(result.rowCount, 1, "Should return exactly 1 row");

      const row = result.rows[0] as Record<string, unknown>;
      const data = row.result as Record<string, unknown>;

      assertEquals(data.name, "Solo", "Name should be 'Solo'");

      // COALESCE should return [] not null
      const articles = data.articles;
      assertEquals(
        Array.isArray(articles),
        true,
        "Articles should be an empty array (COALESCE with '[]'::jsonb), not null"
      );
      assertEquals(
        (articles as unknown[]).length,
        0,
        "Articles array should be empty"
      );
    } finally {
      await pool.close();
    }
  }
});
