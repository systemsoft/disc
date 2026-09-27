/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Changing a property's type, against PostgreSQL.
 *
 * The type change had no `USING`, so `str` → enum, `array<str>` →
 * `array<Enum>`, `str` → `int64` and `int32` → `str` failed on a table with
 * rows. Stored values now convert with a cast, and a value that does not
 * convert fails the migration naming the column and the value, without
 * changing anything.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

const BEFORE = `module default {
  scalar type ApPriority extending enum<Low, High>;
  scalar type ApLevel extending enum<Low, High, Top>;
  type ApItem {
    required label: str;
    status: str {
      default := "Low";
    };
    tags: array<str>;
    grade: ApPriority;
    count: str;
    big: str;
    small: int32;
    multi nums: str;
  };
};`;

const AFTER = `module default {
  scalar type ApPriority extending enum<Low, High>;
  scalar type ApLevel extending enum<Low, High, Top>;
  type ApItem {
    required label: str;
    status: ApPriority {
      default := "Low";
    };
    tags: array<ApPriority>;
    grade: ApLevel;
    count: int64;
    big: bigint;
    small: str;
    multi nums: int64;
  };
};`;

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);
  await pool.query(`DROP TYPE IF EXISTS disc_enum_appriority CASCADE`);
  await pool.query(`DROP TYPE IF EXISTS disc_enum_aplevel CASCADE`);
}

async function migrate(pool: ConnectionPool, sdl: string): Promise<Types.MigrationResult[]> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl, { allowUnsafe: true });

    if (!result.ok)
      throw result.error;

    return result.value;
  } finally {
    await manager.close();
  }
}

async function columnTypes(pool: ConnectionPool): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'ap_item' AND column_name <> 'id'`
  );
  return Object.fromEntries(result.rows.map(row => [row.column_name as string, row.udt_name as string]));
}

Deno.test({
  name: "PG AlterProperty type change: stored values convert with a cast; the next migrate is a no-op",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, BEFORE);
      await pool.query(`INSERT INTO ap_item (label, status, tags, grade, count, big, small, nums) VALUES
        ('full', 'High', '{Low,High}', 'High', '42', '12345678901234567890', 7, '{1,-2}'),
        ('empty', NULL, NULL, NULL, NULL, NULL, NULL, '{}')`);

      const applied = await migrate(pool, AFTER);
      assertEquals(applied.length, 1);
      assertEquals(await columnTypes(pool), {
        big: "numeric",
        count: "int8",
        grade: "disc_enum_aplevel",
        label: "text",
        nums: "_int8",
        small: "text",
        status: "disc_enum_appriority",
        tags: "_disc_enum_appriority"
      });

      const rows = await pool.query(
        `SELECT label, status::text AS status, tags::text[] AS tags, grade::text AS grade, count::text AS count,
                (big + 1)::text AS next, small, nums::text[] AS nums
           FROM ap_item ORDER BY label`
      );
      assertEquals(rows.rows, [
        { count: null, grade: null, label: "empty", next: null, nums: [], small: null, status: null, tags: null },
        {
          count: "42",
          grade: "High",
          label: "full",
          next: "12345678901234567891",
          nums: ["1", "-2"],
          small: "7",
          status: "High",
          tags: ["Low", "High"]
        }
      ]);

      // Defaults survive the change: the enum default and the multi's empty set.
      await pool.query(`INSERT INTO ap_item (label) VALUES ('defaulted')`);
      const defaulted = await pool.query(`SELECT status::text AS status, nums::text[] AS nums FROM ap_item WHERE label = 'defaulted'`);
      assertEquals(defaulted.rows, [{ nums: [], status: "Low" }]);

      assertEquals(await migrate(pool, AFTER), []);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG AlterProperty type change: a value that does not convert fails the migration, naming the column and the value",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, BEFORE);
      await pool.query(`INSERT INTO ap_item (label, status, count) VALUES ('ok', 'Low', '1'), ('bad', 'Medium', '2')`);

      let error: Error | undefined;
      try {
        await migrate(pool, AFTER);
      } catch (caught) {
        error = caught as Error;
      }

      assert(error, "expected the migration to fail");
      assertStringIncludes(error.message, "Cannot convert ap_item.status from str to ApPriority");
      assertStringIncludes(error.message, "stored value 'Medium' is not a valid ApPriority");

      // Nothing changed: every column keeps its type and the rows are intact.
      const types = await columnTypes(pool);
      assertEquals([types.status, types.count, types.nums], ["text", "text", "_text"]);
      const rows = await pool.query(`SELECT label, status, count FROM ap_item ORDER BY label`);
      assertEquals(rows.rows, [{ count: "2", label: "bad", status: "Medium" }, { count: "1", label: "ok", status: "Low" }]);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG AlterProperty type change: a bad element of a multi property fails the migration, naming the column and the value",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, BEFORE);
      await pool.query(`INSERT INTO ap_item (label, nums) VALUES ('bad', '{1,lots}')`);

      let error: Error | undefined;
      try {
        await migrate(pool, AFTER);
      } catch (caught) {
        error = caught as Error;
      }

      assert(error, "expected the migration to fail");
      assertStringIncludes(error.message, "Cannot convert ap_item.nums from str to int64");
      assertStringIncludes(error.message, `stored value '{1,lots}' is not a set of int64 values`);
      assertEquals((await columnTypes(pool)).nums, "_text");
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});
