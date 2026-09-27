/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The `chk_<table>_<column>_finite` CHECKs against PostgreSQL: a `decimal` or
 * `bigint` column (single, multi, array, link property) holds no NaN or
 * ±Infinity, and a bigint no fractional part, whatever writes it — as Gel's
 * `bigint_t` domain and decimal casts guarantee. A database migrated before
 * the checks existed gets them from the drift repair, once; when its rows
 * already hold such a value, the repair fails naming the column and the
 * value, and nothing changes.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const SDL = `module default {
  type Sensor { required name: str; };
  type Reading {
    required label: str;
    big: bigint;
    dec: decimal;
    multi decs: decimal;
    bigs: array<bigint>;
    f64: float64;
    multi sensors: Sensor { weight: decimal; };
  };
};`;

const CHECKS = [
  "chk_reading_big_finite",
  "chk_reading_bigs_finite",
  "chk_reading_dec_finite",
  "chk_reading_decs_finite",
  "chk_reading_sensors_weight_finite"
];

async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

/*** Apply `sdl` (type changes allowed); the number of migrations it recorded, or the error's message. ***/
async function migrate(pool: ConnectionPool, sdl: string): Promise<number | string> {
  const result = await withManager(pool, manager => manager.applySchema(sdl, { allowUnsafe: true }));
  return result.ok ? result.value.length : result.error.message;
}

async function finiteChecks(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query(`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%\\_finite' ORDER BY conname`);
  return result.rows.map(row => row.conname as string);
}

/*** The SQLSTATE `sql` fails with, or "ok". ***/
async function sqlState(pool: ConnectionPool, sql: string): Promise<string> {
  try {
    await pool.query(sql);
    return "ok";
  } catch (error) {
    const fields = (error as { fields?: { code?: string; }; }).fields;
    return fields?.code ?? String(error);
  }
}

async function run(fn: (pool: ConnectionPool) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    await fn(pool);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG finite checks: decimal and bigint columns reject NaN, ±Infinity and fractional bigints written in raw SQL",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, SDL), 1);
      assertEquals(await finiteChecks(pool), CHECKS);

      const insert = (columns: string, values: string): Promise<string> => sqlState(pool, `INSERT INTO reading (label, ${columns}) VALUES ('x', ${values})`);

      for (const special of ["NaN", "Infinity", "-Infinity"]) {
        assertEquals(await insert("dec", `'${special}'`), "23514", `dec ${special}`);
        assertEquals(await insert("big", `'${special}'`), "23514", `big ${special}`);
        assertEquals(await insert("decs", `'{1,${special}}'`), "23514", `decs ${special}`);
        assertEquals(await insert("bigs", `'{1,${special}}'`), "23514", `bigs ${special}`);
      }
      assertEquals(await insert("big", "1.5"), "23514");
      assertEquals(await insert("big", "'12.0'"), "23514");
      assertEquals(await insert("bigs", "'{1,2.5}'"), "23514");
      assertEquals(await insert("dec, f64", "1.5, 'NaN'"), "ok", "a float keeps NaN");
      assertEquals(await insert("big, bigs, decs", "12, '{1,2}', '{}'"), "ok");
      assertEquals(await insert("big, bigs", "NULL, NULL"), "ok");

      const reading = (await pool.query(`SELECT id FROM reading LIMIT 1`)).rows[0].id as string;
      const sensor = (await pool.query(`INSERT INTO sensor (name) VALUES ('s') RETURNING id`)).rows[0].id as string;
      assertEquals(
        await sqlState(pool, `INSERT INTO reading_sensors (source_id, target_id, weight) VALUES ('${reading}', '${sensor}', 'NaN')`),
        "23514"
      );
    })
});

Deno.test({
  name: "PG finite checks: a type change moves the check with the column",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const reading = (value: string): string => `module default { type Reading { required label: str; value: ${value}; }; };`;

      assertEquals(await migrate(pool, reading("decimal")), 1);
      assertEquals(await finiteChecks(pool), ["chk_reading_value_finite"]);

      assertEquals(await migrate(pool, reading("float64")), 1);
      assertEquals(await finiteChecks(pool), []);
      await pool.query(`INSERT INTO reading (label, value) VALUES ('nan', 'NaN'), ('half', 2.5)`);

      /*** Back to decimal, a stored NaN fails the change naming the column and the value; nothing changes. ***/
      const failed = await migrate(pool, reading("decimal"));
      assertStringIncludes(String(failed), "reading.value");
      assertStringIncludes(String(failed), "'NaN'");
      assertEquals(await finiteChecks(pool), []);

      await pool.query(`DELETE FROM reading WHERE label = 'nan'`);
      assertEquals(await migrate(pool, reading("decimal")), 1);
      assertEquals(await finiteChecks(pool), ["chk_reading_value_finite"]);

      /*** decimal → bigint: 2.5 has a fractional part. ***/
      const fractional = await migrate(pool, reading("bigint"));
      assertStringIncludes(String(fractional), "reading.value");
      assertStringIncludes(String(fractional), "'2.5'");

      await pool.query(`UPDATE reading SET value = 3`);
      assertEquals(await migrate(pool, reading("bigint")), 1);
      assertEquals(await sqlState(pool, `UPDATE reading SET value = 3.5`), "23514");
    })
});

Deno.test({
  name: "PG finite checks: the drift repair adds missing checks once, and fails naming the column and value when rows violate them",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, SDL), 1);

      /*** A database migrated before the checks existed, with a NaN written before the compiler rejected it. ***/
      for (const check of CHECKS) {
        const table = check === "chk_reading_sensors_weight_finite" ? "reading_sensors" : "reading";
        await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${check}`);
      }
      await pool.query(`INSERT INTO reading (label, dec, decs) VALUES ('bad', 1.5, '{2,NaN}')`);
      const recorded = (await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n as number;

      const failed = await migrate(pool, SDL);
      assert(typeof failed === "string", `the repair should fail, recorded ${failed}`);
      assertStringIncludes(failed, "reading.decs");
      assertStringIncludes(failed, "'NaN'");
      assertEquals(await finiteChecks(pool), [], "nothing changes");
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n, recorded);

      await pool.query(`UPDATE reading SET decs = '{2}' WHERE label = 'bad'`);
      assertEquals(await migrate(pool, SDL), 1);
      assertEquals(await finiteChecks(pool), CHECKS);
      assertEquals(await migrate(pool, SDL), 0, "the second migrate is a no-op");
    })
});
