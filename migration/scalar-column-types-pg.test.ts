/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Column types of Gel's scalar types, against PostgreSQL.
 *
 * `big: bigint;` got a TEXT column, so `.big / 2` failed with "operator does
 * not exist: text / integer". New columns get the type's PostgreSQL type. A
 * column created as TEXT before is converted by the next migrate — values
 * that convert keep them, anything else fails the migration naming the
 * column and the value — and the migrate after that is a no-op.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

const SDL = `module default {
  scalar type SctCount extending int64;
  type SctItem {
    required label: str;
    big: bigint {
      default := 0;
    };
    count: SctCount;
    spans: array<duration>;
    bounds: range<float32>;
  };
};`;

/*** Stored `multi` and `array<range>` properties, for the legacy `text[]` / TEXT column conversions. ***/
const ARRAY_SDL = `module default {
  scalar type SctLevel extending enum<Low, High>;
  type SctBag {
    required label: str;
    multi bigs: bigint;
    multi levels: SctLevel;
    multi waits: duration;
    slots: array<range<int32>>;
  };
};`;

async function migrate(pool: ConnectionPool, sdl = SDL): Promise<Types.MigrationResult[]> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl);

    if (!result.ok)
      throw result.error;

    return result.value;
  } finally {
    await manager.close();
  }
}

async function columnType(pool: ConnectionPool, column: string, table = "sct_item"): Promise<string> {
  const result = await pool.query(
    `SELECT udt_name FROM information_schema.columns WHERE table_name = $2 AND column_name = $1`,
    [column, table]
  );
  return result.rows[0].udt_name as string;
}

/** Recreate the column as TEXT, as Disc created it before it mapped the column's type. */
async function makeLegacyTextColumn(pool: ConnectionPool, column: string, defaultSql?: string): Promise<void> {
  await pool.query(`ALTER TABLE sct_item DROP COLUMN ${column}`);
  await pool.query(`ALTER TABLE sct_item ADD COLUMN ${column} TEXT${defaultSql ? ` DEFAULT ${defaultSql}` : ""}`);
}

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `scalar_column_types_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

Deno.test({
  name: "PG scalar column types: bigint is numeric; insert, select and arithmetic through the compiler",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await migrate(pool);
      assertEquals(await columnType(pool, "big"), "numeric");
      assertEquals(await columnType(pool, "count"), "int8");
      assertEquals(await columnType(pool, "spans"), "_interval");
      assertEquals(await columnType(pool, "bounds"), "numrange");

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      await manager.applySchema(SDL);
      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
      await manager.close();

      const run = async (query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
        const response = await handler.handleRequest({ query, variables }, makeContext());
        assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
        return response.data as Record<string, unknown>[];
      };

      await run(`insert SctItem { label := "a", big := 7n, count := 7 }`);
      await run(`insert SctItem { label := "b" }`);
      await pool.query(`INSERT INTO sct_item (label, big) VALUES ('huge', 12345678901234567890)`);

      const rows = await run(`select SctItem { label, half := .big / 2, next := .big + 1, doubled := .count * 2 } order by .label`);
      assertEquals(rows.slice(0, 2).map(row => [row.label, String(row.half), String(row.next), String(row.doubled)]), [
        ["a", "3.5", "8", "14"],
        ["b", "0", "1", "null"]
      ]);

      const filtered = await run(`select SctItem { label } filter .big > 100n`);
      assertEquals(filtered, [{ label: "huge" }]);

      // Numeric keeps every digit (the JSON result above carries numbers as doubles).
      const huge = await pool.query(`SELECT (big + 1)::text AS next FROM sct_item WHERE label = 'huge'`);
      assertEquals(huge.rows, [{ next: "12345678901234567891" }]);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG scalar column types: migrate converts legacy TEXT columns, keeping values and defaults; the next migrate is a no-op",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await migrate(pool);
      await makeLegacyTextColumn(pool, "big", "0");
      await makeLegacyTextColumn(pool, "count");
      await makeLegacyTextColumn(pool, "spans");

      await pool.query(`INSERT INTO sct_item (label, big, count, spans) VALUES
        ('huge', '12345678901234567890', '7', '{"1 day","02:00:00"}'),
        ('json', '-3', NULL, '["1 hour"]'),
        ('unset', NULL, NULL, NULL)`);

      const applied = await migrate(pool);
      assertEquals(applied.length, 1);
      assertEquals(await columnType(pool, "big"), "numeric");
      assertEquals(await columnType(pool, "count"), "int8");
      assertEquals(await columnType(pool, "spans"), "_interval");

      const rows = await pool.query(
        `SELECT label, (big + 1)::text AS next, count::text AS count, spans::text[] AS spans FROM sct_item ORDER BY label`
      );
      assertEquals(rows.rows, [
        { count: "7", label: "huge", next: "12345678901234567891", spans: ["P1D", "PT2H"] },
        { count: null, label: "json", next: "-2", spans: ["PT1H"] },
        { count: null, label: "unset", next: null, spans: null }
      ]);

      await pool.query(`INSERT INTO sct_item (label) VALUES ('defaulted')`);
      const defaulted = await pool.query(`SELECT big FROM sct_item WHERE label = 'defaulted'`);
      assertEquals(String(defaulted.rows[0].big), "0");

      assertEquals(await migrate(pool), []);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG scalar column types: a legacy TEXT value that does not convert fails the migration, naming the column and the value",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await migrate(pool);
      await makeLegacyTextColumn(pool, "big");
      await pool.query(`INSERT INTO sct_item (label, big) VALUES ('ok', '12'), ('bad', 'lots')`);

      let error: Error | undefined;
      try {
        await migrate(pool);
      } catch (caught) {
        error = caught as Error;
      }

      assert(error, "expected the migration to fail");
      assertStringIncludes(error.message, "Cannot convert sct_item.big from text to bigint");
      assertStringIncludes(error.message, "stored value 'lots' is not a valid bigint");

      // Nothing changed: the column is still TEXT and both rows are intact.
      assertEquals(await columnType(pool, "big"), "text");
      const rows = await pool.query(`SELECT label, big FROM sct_item ORDER BY label`);
      assertEquals(rows.rows, [{ big: "lots", label: "bad" }, { big: "12", label: "ok" }]);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

async function resetArrays(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);
  await pool.query(`DROP TYPE IF EXISTS disc_enum_sctlevel CASCADE`);
}

/** Recreate a multi column as `text[]`, as Disc created it before it mapped the element type. */
async function makeLegacyTextArrayColumn(pool: ConnectionPool, column: string): Promise<void> {
  await pool.query(`ALTER TABLE sct_bag DROP COLUMN ${column}`);
  await pool.query(`ALTER TABLE sct_bag ADD COLUMN ${column} TEXT[] NOT NULL DEFAULT '{}'`);
}

Deno.test({
  name: "PG scalar column types: migrate converts legacy text[] multi columns and TEXT array<range> columns; the next migrate is a no-op",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetArrays(pool);
      await migrate(pool, ARRAY_SDL);
      assertEquals(await columnType(pool, "bigs", "sct_bag"), "_numeric");
      assertEquals(await columnType(pool, "levels", "sct_bag"), "_disc_enum_sctlevel");
      assertEquals(await columnType(pool, "waits", "sct_bag"), "_interval");
      assertEquals(await columnType(pool, "slots", "sct_bag"), "_int4range");

      await makeLegacyTextArrayColumn(pool, "bigs");
      await makeLegacyTextArrayColumn(pool, "levels");
      await makeLegacyTextArrayColumn(pool, "waits");
      await pool.query(`ALTER TABLE sct_bag DROP COLUMN slots`);
      await pool.query(`ALTER TABLE sct_bag ADD COLUMN slots TEXT`);

      await pool.query(`INSERT INTO sct_bag (label, bigs, levels, waits, slots) VALUES
        ('full', '{12345678901234567890,-3}', '{High,Low}', '{"1 day","02:00:00"}', '{"[1,5)","[7,9)"}'),
        ('empty', '{}', '{}', '{}', NULL)`);

      const applied = await migrate(pool, ARRAY_SDL);
      assertEquals(applied.length, 1);
      assertEquals(await columnType(pool, "bigs", "sct_bag"), "_numeric");
      assertEquals(await columnType(pool, "levels", "sct_bag"), "_disc_enum_sctlevel");
      assertEquals(await columnType(pool, "waits", "sct_bag"), "_interval");
      assertEquals(await columnType(pool, "slots", "sct_bag"), "_int4range");

      const rows = await pool.query(
        `SELECT label, bigs::text[] AS bigs, levels::text[] AS levels, waits::text[] AS waits, slots::text[] AS slots,
                bigs[1] + 1 = 12345678901234567891 AS exact, levels[1] > levels[2] AS ordered
           FROM sct_bag ORDER BY label`
      );
      assertEquals(rows.rows, [
        { bigs: [], exact: null, label: "empty", levels: [], ordered: null, slots: null, waits: [] },
        {
          bigs: ["12345678901234567890", "-3"],
          exact: true,
          label: "full",
          levels: ["High", "Low"],
          ordered: true,
          slots: ["[1,5)", "[7,9)"],
          waits: ["P1D", "PT2H"]
        }
      ]);

      // The empty-set default survives the conversion.
      await pool.query(`INSERT INTO sct_bag (label) VALUES ('defaulted')`);
      const defaulted = await pool.query(`SELECT bigs::text[] AS bigs, levels::text[] AS levels FROM sct_bag WHERE label = 'defaulted'`);
      assertEquals(defaulted.rows, [{ bigs: [], levels: [] }]);

      assertEquals(await migrate(pool, ARRAY_SDL), []);
    } finally {
      await resetArrays(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG scalar column types: a legacy text[] element that does not convert fails the migration, naming the column and the value",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetArrays(pool);
      await migrate(pool, ARRAY_SDL);
      await makeLegacyTextArrayColumn(pool, "levels");
      await pool.query(`INSERT INTO sct_bag (label, levels) VALUES ('ok', '{Low}'), ('bad', '{High,Medium}')`);

      let error: Error | undefined;
      try {
        await migrate(pool, ARRAY_SDL);
      } catch (caught) {
        error = caught as Error;
      }

      assert(error, "expected the migration to fail");
      assertStringIncludes(error.message, "Cannot convert sct_bag.levels from text[] to SctLevel");
      assertStringIncludes(error.message, "stored value 'Medium' is not a valid SctLevel");

      // Nothing changed: the column is still text[] and both rows are intact.
      assertEquals(await columnType(pool, "levels", "sct_bag"), "_text");
      const rows = await pool.query(`SELECT label, levels FROM sct_bag ORDER BY label`);
      assertEquals(rows.rows, [{ label: "bad", levels: ["High", "Medium"] }, { label: "ok", levels: ["Low"] }]);
    } finally {
      await resetArrays(pool);
      await pool.close();
    }
  }
});
