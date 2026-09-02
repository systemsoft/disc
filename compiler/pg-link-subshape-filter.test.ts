/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `filter` on a link sub-shape narrows the LINKED SET.
 *
 * `select Channel { videos: { * } filter .isDraft = 0 }` must return every
 * channel, each carrying only its non-draft videos. This is the counterpart
 * to a top-level `.videos.isDraft = 0` predicate, which lowers to EXISTS and
 * filters the *channel* while leaving the returned `videos` array untouched —
 * the distinction the SDK filter API surfaces as a sibling link key vs. a
 * `filter` inside that link's `select` sub-shape.
 *
 * Covers both link storage shapes, since they build different join
 * conditions in `compileLinkWithShape`: a backlink-style multi (target holds
 * the FK) and a junction-backed plain multi.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import {
  canRunPgTests,
  getTestDsn,
  makePool
} from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type SubVideo {
    required title -> str;
    required isDraft -> int64 { default := 0; };
    required channel -> SubChannel;
  }
  type SubTag {
    required label -> str;
  }
  type SubChannel {
    required slug -> str;
    videos := .<channel[is SubVideo];
    multi tags -> SubTag;
  }
}`;

const TABLES = ["sub_video", "sub_channel", "sub_tag"];
const CH_A = "01234567-89ab-7cde-8f01-00000000000a";
const CH_B = "01234567-89ab-7cde-8f01-00000000000b";
const TAG_PUB = "01234567-89ab-7cde-8f01-0000000000c1";
const TAG_HID = "01234567-89ab-7cde-8f01-0000000000c2";

async function dropAll(pool: ConnectionPool) {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS sub_channel_tags CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

function unwrap(row: Record<string, unknown>): Record<string, unknown> {
  return (row.jsonb_build_object ?? row) as Record<string, unknown>;
}

/** Rows keyed by slug, so assertions don't depend on scan order. */
function bySlug(
  rows: Record<string, unknown>[]
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const raw of rows) {
    const row = unwrap(raw);
    out[row.slug as string] = row;
  }
  return out;
}

function titles(row: Record<string, unknown>, key: string): string[] {
  const set = (row[key] ?? []) as Record<string, unknown>[];
  return set.map(v => v.title as string).sort();
}

async function seed(pool: ConnectionPool): Promise<SchemaManager> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(
    applied.ok,
    true,
    `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`
  );

  // chan-a: two public videos + one draft. chan-b: drafts only, so it proves
  // the parent row survives a sub-shape filter that matches nothing.
  await pool.query(
    `INSERT INTO sub_channel (id, slug)
     VALUES ('${CH_A}', 'chan-a'), ('${CH_B}', 'chan-b')`
  );
  // The SDL property `isDraft` is stored as `is_draft` — the migration engine
  // snake_cases camelCase property names (PG folds unquoted identifiers).
  await pool.query(
    `INSERT INTO sub_video (id, title, is_draft, channel_id) VALUES
       (gen_random_uuid(), 'pub1',  0, '${CH_A}'),
       (gen_random_uuid(), 'pub2',  0, '${CH_A}'),
       (gen_random_uuid(), 'draft1', 1, '${CH_A}'),
       (gen_random_uuid(), 'draft2', 1, '${CH_B}')`
  );
  return manager;
}

Deno.test({
  name: "PG link sub-shape filter: narrows a backlink multi, keeps the parent",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = await seed(pool);
      const schema = manager.getSchema();
      if (!schema) {
        throw new Error("no schema after applySchema");
      }

      // Unfiltered baseline: every video comes back, drafts included.
      const baseline = bySlug(
        (await pool.query(
          compileEdgeQL("select SubChannel { slug, videos: { title } }", schema)
        ))
          .rows
      );
      assertEquals(
        titles(baseline["chan-a"], "videos"),
        ["draft1", "pub1", "pub2"],
        "baseline should include drafts"
      );

      // Sub-shape filter: only non-drafts survive into the array...
      const filtered = bySlug(
        (await pool.query(
          compileEdgeQL(
            "select SubChannel { slug, videos: { title } filter .isDraft = 0 }",
            schema
          )
        ))
          .rows
      );
      assertEquals(
        titles(filtered["chan-a"], "videos"),
        ["pub1", "pub2"],
        "drafts must be excluded from the linked set"
      );

      // ...and the channel with nothing matching is STILL returned, with an
      // empty array. This is the behaviour a top-level EXISTS predicate can't
      // express — it would drop chan-b entirely.
      assertEquals(
        Object.keys(filtered).sort(),
        ["chan-a", "chan-b"],
        "sub-shape filter must not drop parent rows"
      );
      assertEquals(
        titles(filtered["chan-b"], "videos"),
        [],
        "chan-b has no public videos, so an empty array"
      );

      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG link sub-shape filter: composes with order by, and with a top-level filter",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = await seed(pool);
      const schema = manager.getSchema();
      if (!schema) {
        throw new Error("no schema after applySchema");
      }

      // `filter` then `order by` on the same link, plus an outer predicate —
      // the full shape the SDK emits for
      // `{ slug: …, select: { videos: { filter: …, order_by: ["-title"] } } }`.
      const sql = compileEdgeQL(
        "select SubChannel { slug, videos: { title } " +
          "filter .isDraft = 0 order by .title desc } " +
          "filter .slug = 'chan-a'",
        schema
      );
      const res = await pool.query(sql);
      assertEquals(res.rowCount, 1, "outer filter still selects one channel");

      const row = unwrap(res.rows[0]);
      const videos = (row.videos ?? []) as Record<string, unknown>[];
      assertEquals(
        videos.map(v => v.title),
        ["pub2", "pub1"],
        "filtered AND ordered descending"
      );

      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG link sub-shape filter: narrows a junction-backed multi link",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = await seed(pool);
      const schema = manager.getSchema();
      if (!schema) {
        throw new Error("no schema after applySchema");
      }

      await pool.query(
        `INSERT INTO sub_tag (id, label)
         VALUES ('${TAG_PUB}', 'public'), ('${TAG_HID}', 'hidden')`
      );
      // Junction rows are written directly — this suite is about read-side
      // narrowing, not the write path.
      const junction = schema
        .types
        .get("SubChannel")
        ?.links
        .get("tags")
        ?.junctionTable ?? "sub_channel_tags";
      await pool.query(
        `INSERT INTO "${junction}" (source_id, target_id)
         VALUES ('${CH_A}', '${TAG_PUB}'), ('${CH_A}', '${TAG_HID}')`
      );

      const res = await pool.query(
        compileEdgeQL(
          "select SubChannel { slug, tags: { label } filter .label = 'public' } " +
            "filter .slug = 'chan-a'",
          schema
        )
      );
      const row = unwrap(res.rows[0]);
      const tags = (row.tags ?? []) as Record<string, unknown>[];
      assertEquals(
        tags.map(t => t.label),
        ["public"],
        "junction-backed link narrows to the matching target rows"
      );

      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});
