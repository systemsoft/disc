/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: selecting a COMPUTED property (a named tuple of aggregates
 * over backlinks, à la `counts := (videos := count(.<channel[is Video]), ...)`)
 * must inline its expression as correlated subqueries — NOT emit a bare
 * `<table>.<name>` column.
 *
 * Regression guard for `column <table>.counts does not exist`, which a server
 * binary predating computed-expression capture (schema-manager, 2026-06-21)
 * produced. Migrates real tables, inserts related rows, compiles the selection
 * against the post-migration schema, and verifies the aggregate VALUES.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import {
  canRunPgTests,
  getTestDsn,
  makePool
} from "../tests/pg-test-harness.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  abstract type CountBase {
    created -> datetime { default := datetime_current(); };
  }
  type CountVideo extending CountBase {
    required title -> str;
    required channel -> CountChannel;
    required size -> int64;
  }
  type CountPost extending CountBase {
    required body -> str;
    required channel -> CountChannel;
  }
  type CountChannel extending CountBase {
    required name -> str;
    counts := (
      videos := count(.<channel[is CountVideo]),
      posts := count(.<channel[is CountPost])
    );
    storage := (
      bytes := sum(.<channel[is CountVideo].size)
    );
  }
}`;

const TABLES = ["count_video", "count_post", "count_channel"];
const CH_ID = "01234567-89ab-7cde-8f01-23456789abcd";

async function dropAll(pool: { query: (sql: string) => Promise<unknown>; }) {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// Compiled `select X { ... }` returns one jsonb column per row.
function unwrap(row: Record<string, unknown>): Record<string, unknown> {
  return (row.jsonb_build_object ?? row) as Record<string, unknown>;
}

Deno.test({
  name: "PG computed selection: counts/storage named-tuple inlines as subqueries",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const applied = await manager.applySchema(SDL);
      assertEquals(
        applied.ok,
        true,
        `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`
      );
      const schema = manager.getSchema();
      if (!schema)
        throw new Error("no schema after applySchema");

      // ch1 with two videos (sizes 100, 200) and one post.
      await pool.query(
        `INSERT INTO count_channel (id, name) VALUES ('${CH_ID}', 'ch1')`
      );
      await pool.query(
        `INSERT INTO count_video (id, title, channel_id, size)
         VALUES (gen_random_uuid(), 'v1', '${CH_ID}', 100),
                (gen_random_uuid(), 'v2', '${CH_ID}', 200)`
      );
      await pool.query(
        `INSERT INTO count_post (id, body, channel_id)
         VALUES (gen_random_uuid(), 'p1', '${CH_ID}')`
      );

      // Top-level computed selection. Throws here (compile or SQL exec) if the
      // computed props regress to `countchannel.counts` column references.
      const sql = compileEdgeQL(
        "select CountChannel { name, counts, storage }",
        schema
      );
      const res = await pool.query(sql);
      assertEquals(res.rowCount, 1);

      const row = unwrap(res.rows[0]);
      assertEquals(row.name, "ch1");
      const counts = row.counts as Record<string, unknown>;
      const storage = row.storage as Record<string, unknown>;
      assertEquals(Number(counts.videos), 2, "counts.videos");
      assertEquals(Number(counts.posts), 1, "counts.posts");
      assertEquals(Number(storage.bytes), 300, "storage.bytes = 100 + 200");

      // Filtering on a computed tuple field: `.counts.videos` inlines the
      // aggregate. ch1 has 2 videos → matches `>= 2`, not `>= 3`.
      const matchSql = compileEdgeQL(
        "select CountChannel { name } filter .counts.videos >= 2",
        schema
      );
      assertEquals((await pool.query(matchSql)).rowCount, 1, "videos >= 2 matches");

      const noMatchSql = compileEdgeQL(
        "select CountChannel { name } filter .counts.videos >= 3",
        schema
      );
      assertEquals((await pool.query(noMatchSql)).rowCount, 0, "videos >= 3 excludes");

      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});

// Regression: selecting a computed property INSIDE a nested link shape
// (`select CountVideo { channel: { counts } }`) must inline the computed
// expression correlated to the LINK's subquery table — not emit a bare
// `count_channel.counts` column. `compileLinkWithShape` now compiles the
// sub-shape via `compileShapeElement` under a scope aliasing the linked type.
Deno.test({
  name: "PG computed selection: nested computed through a link",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    try {
      await dropAll(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(SDL);
      assertEquals(applied.ok, true);
      const schema = manager.getSchema();
      if (!schema)
        throw new Error("no schema");

      await pool.query(
        `INSERT INTO count_channel (id, name) VALUES ('${CH_ID}', 'ch1')`
      );
      await pool.query(
        `INSERT INTO count_video (id, title, channel_id, size)
         VALUES (gen_random_uuid(), 'v1', '${CH_ID}', 100)`
      );

      // Single links come back wrapped in a one-element array.
      const sql = compileEdgeQL(
        "select CountVideo { title, channel: { name, counts } }",
        schema
      );
      const res = await pool.query(sql);
      const vrow = unwrap(res.rows[0]);
      const chRaw = vrow.channel;
      const ch = (Array.isArray(chRaw) ? chRaw[0] : chRaw) as Record<
        string,
        unknown
      >;
      assertEquals(ch.name, "ch1");
      assertEquals(Number((ch.counts as Record<string, unknown>).videos), 1);

      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});
