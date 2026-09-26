/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Same-named enums in different modules, against PostgreSQL.
 *
 * `default::Shift` and `crew::Shift` both mapped to `disc_enum_shift`, so the
 * migration failed with `type "disc_enum_shift" already exists`. The
 * non-default one now gets `disc_enum_crew__shift` while the name is shared;
 * an existing database whose `crew::Shift` is `disc_enum_shift` has that type
 * renamed in place when `default::Shift` is added, and back when it is
 * removed, with its rows intact.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const CREW = `module crew {
  scalar type Shift extending enum<Day, Night>;
  type Worker {
    required name: str;
    shift: Shift;
    multi shifts: Shift;
  };
};`;

const DEFAULT_SHIFT = `module default {
  scalar type Shift extending enum<Early, Late>;
  type Roster {
    required title: str;
    shift: Shift;
  };
};`;

const TYPES = ["disc_enum_shift", "disc_enum_crew__shift"];

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);

  for (const type of TYPES)
    await pool.query(`DROP TYPE IF EXISTS ${type} CASCADE`);
}

async function migrate(pool: ConnectionPool, sdl: string, allowUnsafe = false): Promise<void> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl, { allowUnsafe });

    if (!result.ok)
      throw result.error;
  } finally {
    await manager.close();
  }
}

async function enumLabels(pool: ConnectionPool, type: string): Promise<string[] | null> {
  const exists = await pool.query(`SELECT to_regtype($1) IS NOT NULL AS ok`, [type]);

  if (!exists.rows[0].ok)
    return null;

  const result = await pool.query(`SELECT unnest(enum_range(NULL::${type}))::text AS label`);
  return result.rows.map(row => row.label as string);
}

async function columnType(pool: ConnectionPool, table: string, column: string): Promise<string> {
  const result = await pool.query(
    `SELECT udt_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return result.rows[0].udt_name as string;
}

Deno.test({
  name: "PG enum collision: same-named enums in two modules migrate to two types",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, `${DEFAULT_SHIFT}\n${CREW}`);

      assertEquals(await enumLabels(pool, "disc_enum_shift"), ["Early", "Late"]);
      assertEquals(await enumLabels(pool, "disc_enum_crew__shift"), ["Day", "Night"]);
      assertEquals(await columnType(pool, "roster", "shift"), "disc_enum_shift");
      assertEquals(await columnType(pool, "worker", "shift"), "disc_enum_crew__shift");
      assertEquals(await columnType(pool, "worker", "shifts"), "_disc_enum_crew__shift");
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG enum collision: adding then removing a same-named default enum renames the existing type, keeping rows",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, CREW);
      assertEquals(await enumLabels(pool, "disc_enum_shift"), ["Day", "Night"]);
      await pool.query(`INSERT INTO worker (name, shift, shifts) VALUES ('ana', 'Night', '{Day,Night}')`);

      await migrate(pool, `${DEFAULT_SHIFT}\n${CREW}`);
      assertEquals(await enumLabels(pool, "disc_enum_shift"), ["Early", "Late"]);
      assertEquals(await enumLabels(pool, "disc_enum_crew__shift"), ["Day", "Night"]);
      assertEquals(await columnType(pool, "worker", "shift"), "disc_enum_crew__shift");

      await migrate(pool, CREW, true);
      assertEquals(await enumLabels(pool, "disc_enum_crew__shift"), null);
      assertEquals(await enumLabels(pool, "disc_enum_shift"), ["Day", "Night"]);
      assertEquals(await columnType(pool, "worker", "shift"), "disc_enum_shift");

      const rows = await pool.query(`SELECT shift::text AS shift, shifts::text[] AS shifts FROM worker`);
      assertEquals(rows.rows, [{ shift: "Night", shifts: ["Day", "Night"] }]);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});
