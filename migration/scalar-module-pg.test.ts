/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Same-named user scalars in different modules, against PostgreSQL.
 *
 * The migrator resolved a property's scalar by its bare name, which is the
 * default module's scalar when two modules declare one: with
 * `default::Money extending decimal` and `ledger::Money extending int64`,
 * `ledger::Entry.amount: Money` got a `numeric` column (and a finite CHECK)
 * instead of `bigint`. A bare name now resolves in the property's own module
 * first, then default — as the runtime schema's `baseType` does. A column
 * created with the wrong type is converted by the next migrate, failing on a
 * value that doesn't convert, and the migrate after that is a no-op.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

const DEFAULT_MODULE = `module default {
  scalar type SmmMoney extending decimal;
  scalar type SmmSerial extending sequence;
  scalar type SmmLevel extending enum<Low, High>;
  type SmmInvoice {
    required title: str;
    total: SmmMoney;
    serial: SmmSerial;
    level: SmmLevel;
  };
};`;

const SDL = `${DEFAULT_MODULE}
module ledger {
  scalar type SmmMoney extending int64;
  scalar type SmmSerial extending str;
  scalar type SmmLevel extending int32;
  type SmmAccount {
    required name: str;
  };
  type SmmEntry {
    required memo: str;
    amount: SmmMoney;
    amounts: array<SmmMoney>;
    multi parts: SmmMoney;
    serial: SmmSerial;
    level: SmmLevel;
    multi accounts: SmmAccount {
      weight: SmmMoney;
    };
  };
};`;

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);
  await pool.query(`DROP TYPE IF EXISTS disc_enum_smmlevel CASCADE`);
  await pool.query(`DROP SEQUENCE IF EXISTS disc_seq_smmserial`);
}

async function migrate(pool: ConnectionPool, sdl = SDL, allowUnsafe = false): Promise<Types.MigrationResult[]> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl, { allowUnsafe });

    if (!result.ok)
      throw result.error;

    return result.value;
  } finally {
    await manager.close();
  }
}

async function column(pool: ConnectionPool, table: string, name: string): Promise<{ default: string | null; type: string; }> {
  const result = await pool.query(
    `SELECT udt_name, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, name]
  );
  return { default: result.rows[0].column_default as string | null, type: result.rows[0].udt_name as string };
}

async function checks(pool: ConnectionPool, table: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname`,
    [table]
  );
  return result.rows.map(row => row.conname as string);
}

Deno.test({
  name: "PG scalar modules: a bare scalar name resolves in the property's own module before default",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool);

      assertEquals((await column(pool, "smm_invoice", "total")).type, "numeric");
      assertEquals((await column(pool, "smm_invoice", "level")).type, "disc_enum_smmlevel");
      assertStringIncludes((await column(pool, "smm_invoice", "serial")).default ?? "", "disc_seq_smmserial");
      assertEquals((await checks(pool, "smm_invoice")).filter(name => name.endsWith("_finite")), ["chk_smm_invoice_total_finite"]);

      assertEquals((await column(pool, "smm_entry", "amount")).type, "int8");
      assertEquals((await column(pool, "smm_entry", "amounts")).type, "_int8");
      assertEquals((await column(pool, "smm_entry", "parts")).type, "_int8");
      assertEquals((await column(pool, "smm_entry", "level")).type, "int4");
      assertEquals(await column(pool, "smm_entry", "serial"), { default: null, type: "text" });
      assertEquals((await column(pool, "smm_entry_accounts", "weight")).type, "int8");
      assertEquals((await checks(pool, "smm_entry")).filter(name => name.endsWith("_finite")), []);

      assertEquals(await migrate(pool), []);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG scalar modules: adding a property of, or changing one to, a module's own scalar uses its type",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();
    const before = `${DEFAULT_MODULE}
module ledger {
  scalar type SmmMoney extending int64;
  type SmmEntry {
    required memo: str;
    note: str;
  };
};`;
    const after = `${DEFAULT_MODULE}
module ledger {
  scalar type SmmMoney extending int64;
  type SmmEntry {
    required memo: str;
    note: SmmMoney;
    fee: SmmMoney;
  };
};`;

    try {
      await reset(pool);
      await migrate(pool, before);
      await pool.query(`INSERT INTO smm_entry (memo, note) VALUES ('a', '5')`);

      await migrate(pool, after, true);
      assertEquals((await column(pool, "smm_entry", "note")).type, "int8");
      assertEquals((await column(pool, "smm_entry", "fee")).type, "int8");
      assertEquals((await checks(pool, "smm_entry")).filter(name => name.endsWith("_finite")), []);

      const rows = await pool.query(`SELECT note::text AS note FROM smm_entry`);
      assertEquals(rows.rows, [{ note: "5" }]);
      assertEquals(await migrate(pool, after), []);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

/** Give the ledger columns the types the bare-name resolution created them with. */
async function makeMistypedColumns(pool: ConnectionPool): Promise<void> {
  await pool.query(`ALTER TABLE smm_entry ALTER COLUMN amount TYPE numeric`);
  await pool.query(`ALTER TABLE smm_entry ADD CONSTRAINT chk_smm_entry_amount_finite CHECK (amount NOT IN ('NaN', 'Infinity', '-Infinity'))`);
  await pool.query(`ALTER TABLE smm_entry ALTER COLUMN parts DROP DEFAULT, ALTER COLUMN parts TYPE numeric[], ALTER COLUMN parts SET DEFAULT '{}'`);
  await pool.query(`ALTER TABLE smm_entry ALTER COLUMN level TYPE disc_enum_smmlevel USING NULL`);
  await pool.query(`ALTER TABLE smm_entry ALTER COLUMN serial TYPE bigint USING NULL, ALTER COLUMN serial SET DEFAULT nextval('disc_seq_smmserial')`);
  await pool.query(`ALTER TABLE smm_entry_accounts ALTER COLUMN weight TYPE numeric`);
}

Deno.test({
  name: "PG scalar modules: migrate converts a column created with another module's scalar type, keeping values; the next migrate is a no-op",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool);
      await makeMistypedColumns(pool);
      await pool.query(`INSERT INTO smm_entry (memo, amount, parts) VALUES ('a', 42, '{1,2}'), ('b', NULL, '{}')`);
      assertEquals((await column(pool, "smm_entry", "amount")).type, "numeric");

      const applied = await migrate(pool);
      assertEquals(applied.length, 1);
      assertEquals((await column(pool, "smm_entry", "amount")).type, "int8");
      assertEquals((await column(pool, "smm_entry", "parts")).type, "_int8");
      assertEquals((await column(pool, "smm_entry", "level")).type, "int4");
      assertEquals(await column(pool, "smm_entry", "serial"), { default: null, type: "text" });
      assertEquals((await column(pool, "smm_entry_accounts", "weight")).type, "int8");
      assertEquals((await checks(pool, "smm_entry")).filter(name => name.endsWith("_finite")), []);

      const rows = await pool.query(`SELECT memo, amount::text AS amount, parts::text[] AS parts FROM smm_entry ORDER BY memo`);
      assertEquals(rows.rows, [{ amount: "42", memo: "a", parts: ["1", "2"] }, { amount: null, memo: "b", parts: [] }]);

      // The multi column keeps its empty-set default.
      await pool.query(`INSERT INTO smm_entry (memo) VALUES ('c')`);
      const defaulted = await pool.query(`SELECT parts::text[] AS parts FROM smm_entry WHERE memo = 'c'`);
      assertEquals(defaulted.rows, [{ parts: [] }]);

      assertEquals(await migrate(pool), []);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG scalar modules: a mistyped column's value that does not convert fails the migration, naming the column and the value",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool);
      await makeMistypedColumns(pool);
      await pool.query(`INSERT INTO smm_entry (memo, amount) VALUES ('ok', 42), ('bad', 42.5)`);

      let error: Error | undefined;
      try {
        await migrate(pool);
      } catch (caught) {
        error = caught as Error;
      }

      assert(error, "expected the migration to fail");
      assertStringIncludes(error.message, "Cannot convert smm_entry.amount from numeric to ledger::SmmMoney");
      assertStringIncludes(error.message, "stored value '42.5' is not a valid ledger::SmmMoney");

      // Nothing changed: the column is still numeric and both rows are intact.
      assertEquals((await column(pool, "smm_entry", "amount")).type, "numeric");
      const rows = await pool.query(`SELECT memo, amount::text AS amount FROM smm_entry ORDER BY memo`);
      assertEquals(rows.rows, [{ amount: "42.5", memo: "bad" }, { amount: "42", memo: "ok" }]);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});
