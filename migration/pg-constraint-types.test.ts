/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests for Stage 25 Constraint Types
 *
 * Tests that verify max_ex_value, min_ex_value, one_of, expression_on,
 * combined constraints, and delegated constraint inheritance are correctly
 * applied to a real PostgreSQL instance via the SchemaManager SDL pipeline.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import {
  canRunPgTests,
  dropTables,
  execSQL,
  getColumns,
  getTestDsn,
  makePool
} from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// =========================================================================
// Test 1: max_ex_value (strict less-than) enforced by PG
// =========================================================================

Deno.test({
  name: "PG Stage 25: max_ex_value strict less-than enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_exclusive";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestExclusive {
          required amount: float64 {
            constraint max_ex_value(1000);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Insert amount=999 -- should succeed (strictly less than 1000)
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, amount) VALUES (gen_random_uuid(), $1)`,
        [999]
      );

      // Insert amount=1000 -- should FAIL (exclusive: 1000 is NOT allowed)
      let boundaryViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, amount) VALUES (gen_random_uuid(), $1)`,
          [1000]
        );
      } catch (error: unknown) {
        boundaryViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        boundaryViolated,
        true,
        "Inserting amount=1000 should violate max_ex_value(1000) CHECK constraint (strict less-than)"
      );

      // Insert amount=1001 -- should also FAIL
      let overViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, amount) VALUES (gen_random_uuid(), $1)`,
          [1001]
        );
      } catch (error: unknown) {
        overViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        overViolated,
        true,
        "Inserting amount=1001 should violate max_ex_value(1000) CHECK constraint"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 2: min_ex_value (strict greater-than) enforced by PG
// =========================================================================

Deno.test({
  name: "PG Stage 25: min_ex_value strict greater-than enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_min_ex";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestMinEx {
          required temperature: float64 {
            constraint min_ex_value(0);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Insert temperature=1 -- should succeed (strictly greater than 0)
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, temperature) VALUES (gen_random_uuid(), $1)`,
        [1]
      );

      // Insert temperature=0 -- should FAIL (exclusive: 0 is NOT allowed)
      let boundaryViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, temperature) VALUES (gen_random_uuid(), $1)`,
          [0]
        );
      } catch (error: unknown) {
        boundaryViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        boundaryViolated,
        true,
        "Inserting temperature=0 should violate min_ex_value(0) CHECK constraint (strict greater-than)"
      );

      // Insert temperature=-1 -- should also FAIL
      let underViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, temperature) VALUES (gen_random_uuid(), $1)`,
          [-1]
        );
      } catch (error: unknown) {
        underViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        underViolated,
        true,
        "Inserting temperature=-1 should violate min_ex_value(0) CHECK constraint"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 3: one_of constraint enforced by PG
// =========================================================================

Deno.test({
  name: "PG Stage 25: one_of constraint enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_one_of";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestOneOf {
          required status: str {
            constraint one_of('active', 'inactive', 'pending');
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Insert status='active' -- should succeed
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, status) VALUES (gen_random_uuid(), $1)`,
        ["active"]
      );

      // Insert status='inactive' -- should succeed
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, status) VALUES (gen_random_uuid(), $1)`,
        ["inactive"]
      );

      // Insert status='deleted' -- should FAIL (not in allowed set)
      let oneOfViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, status) VALUES (gen_random_uuid(), $1)`,
          ["deleted"]
        );
      } catch (error: unknown) {
        oneOfViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        oneOfViolated,
        true,
        "Inserting status='deleted' should violate one_of('active','inactive','pending') CHECK constraint"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 4: expression on constraint enforced by PG
// =========================================================================

Deno.test({
  name: "PG Stage 25: expression on constraint enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_expr_on";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestExprOn {
          required percentage: int64 {
            constraint expression on (__subject__ >= 0 and __subject__ <= 100);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Insert percentage=50 -- should succeed
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, percentage) VALUES (gen_random_uuid(), $1)`,
        [50]
      );

      // Insert percentage=-1 -- should FAIL
      let underViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, percentage) VALUES (gen_random_uuid(), $1)`,
          [-1]
        );
      } catch (error: unknown) {
        underViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        underViolated,
        true,
        "Inserting percentage=-1 should violate expression on (__subject__ >= 0 and __subject__ <= 100)"
      );

      // Insert percentage=101 -- should FAIL
      let overViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, percentage) VALUES (gen_random_uuid(), $1)`,
          [101]
        );
      } catch (error: unknown) {
        overViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        overViolated,
        true,
        "Inserting percentage=101 should violate expression on (__subject__ >= 0 and __subject__ <= 100)"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 5: Combined constraints (min_ex_value + max_ex_value) enforced by PG
// =========================================================================

Deno.test({
  name: "PG Stage 25: Combined min_ex_value + max_ex_value enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_range";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestRange {
          required score: int64 {
            constraint min_ex_value(0);
            constraint max_ex_value(100);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Insert score=50 -- should succeed (within exclusive range)
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
        [50]
      );

      // Insert score=1 -- should succeed (just above exclusive lower bound)
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
        [1]
      );

      // Insert score=99 -- should succeed (just below exclusive upper bound)
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
        [99]
      );

      // Insert score=0 -- should FAIL (exclusive lower bound)
      let lowerViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
          [0]
        );
      } catch (error: unknown) {
        lowerViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        lowerViolated,
        true,
        "Inserting score=0 should violate min_ex_value(0) CHECK constraint (exclusive lower bound)"
      );

      // Insert score=100 -- should FAIL (exclusive upper bound)
      let upperViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
          [100]
        );
      } catch (error: unknown) {
        upperViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        upperViolated,
        true,
        "Inserting score=100 should violate max_ex_value(100) CHECK constraint (exclusive upper bound)"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 6: Delegated constraint inheritance enforced by PG
// =========================================================================

Deno.test({
  name: "PG Stage 25: Delegated constraint inheritance enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "person";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        abstract type Named {
          required name: str {
            constraint max_len_value(50);
          };
        };

        type Person extending Named {
          required age: int64;
        };
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify that person table has the inherited name column
      const columns = await getColumns(dsn, expectedTable);
      const columnNames = columns.map(c => c.column_name);
      assertEquals(
        columnNames.includes("name"),
        true,
        "Person table should have inherited 'name' column from Named"
      );
      assertEquals(
        columnNames.includes("age"),
        true,
        "Person table should have its own 'age' column"
      );

      // Insert person with name='Ada' (5 chars) -- should succeed
      await execSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, name, age) VALUES (gen_random_uuid(), $1, $2)`,
        ["Ada", 30]
      );

      // Insert person with name that is 60 chars -- should FAIL (inherited constraint)
      const longName = "a".repeat(60);
      let constraintViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, name, age) VALUES (gen_random_uuid(), $1, $2)`,
          [longName, 25]
        );
      } catch (error: unknown) {
        constraintViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`
        );
      }

      assertEquals(
        constraintViolated,
        true,
        "Inserting a 60-char name should violate inherited max_len_value(50) CHECK constraint"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "named",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});
