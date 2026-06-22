/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stage 5 end-to-end test for `disc db import` — PG-backed, query-through.
 *
 * Proves the imported data is queryable THROUGH Disc's EdgeQL layer, not just
 * present as rows. Steps:
 *   1. Define a small schema with a single-link and a multi-link.
 *   2. Migrate it into a live DB via SchemaManager.
 *   3. Write fixture export CSVs (object files + a `.link` junction file).
 *   4. Run the importer.
 *   5. Compile and execute an EdgeQL `select` that walks both links and assert
 *      the imported graph comes back correctly.
 *
 * Note: single links come back wrapped as one-element arrays
 * ([[project_single_links_return_arrays]]); the assertions unwrap accordingly.
 *
 * Requires DISC_PG_TEST_URL or DISC_PG_AUTO=1; skipped cleanly otherwise.
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertExists } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { compileEdgeQL } from "../compiler/test-helpers.ts";
import { DbImport } from "./db-import.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

import type { CLIArgs } from "./commands.ts";

const RUN_PG = canRunPgTests();

/*** A single-link (Book.shelf) and a multi-link (Book.labels). ***/
const SDL = `
type Shelf {
  required name: str;
}

type Book {
  required title: str;
  required shelf: Shelf;
  multi labels: Label;
}

type Label {
  required name: str;
}
`;

/*** Stable UUIDs so the imported graph is deterministic. ***/
const SHELF_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LABEL_X = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LABEL_Y = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BOOK_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    const dir = await Deno.makeTempDir({ prefix: "disc-import-e2e-" });

    try {
      await pool.initialize();

      /*** Drop anything left behind by a prior run, then migrate fresh. ***/
      await pool.query(`DROP TABLE IF EXISTS "book_labels" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "book" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "label" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS "shelf" CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS disc_migrations CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE`);

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(SDL);

      assertEquals(applied.ok, true, `applySchema should succeed: ${applied.ok ? "" : JSON.stringify(applied)}`);
      const schema = manager.getSchema()!;

      /*** Fixture export CSVs: object files + a junction file. ***/
      await Deno.writeTextFile(`${dir}/public_Shelf.csv`, `id,__type__,name\n${SHELF_ID},t,Main Shelf\n`);
      await Deno.writeTextFile(`${dir}/public_Label.csv`, `id,__type__,name\n${LABEL_X},t,fiction\n${LABEL_Y},t,classic\n`);
      await Deno.writeTextFile(`${dir}/public_Book.csv`, `id,__type__,title,shelf_id\n${BOOK_ID},v,My Book,${SHELF_ID}\n`);
      await Deno.writeTextFile(`${dir}/public_Book.labels.csv`, `source,target\n${BOOK_ID},${LABEL_X}\n${BOOK_ID},${LABEL_Y}\n`);

      /*** Run the import. ***/
      const args = { _: [] } as CLIArgs;
      const importer = new DbImport(schema, pool, dir, args);
      await importer.run();

      /*** Now query THROUGH Disc: compile EdgeQL → SQL, execute it, and assert
           the imported graph (scalar + single-link + multi-link) round-trips. ***/
      const sql = compileEdgeQL(
        `SELECT Book {
           title,
           shelf: { name },
           labels: { name }
         } FILTER .title = "My Book"`,
        schema
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1, "should return the single imported book");

      const row = result.rows[0];

      const data = typeof row.jsonb_build_object === "string" ?
        JSON.parse(row.jsonb_build_object) :
        row.jsonb_build_object;

      /*** Scalar. ***/
      assertEquals(data.title, "My Book");

      /*** Single link comes back wrapped as a one-element array. ***/
      assertExists(data.shelf, "should have shelf");
      const shelf = Array.isArray(data.shelf) ? data.shelf[0] : data.shelf;
      assertEquals(shelf.name, "Main Shelf");

      /*** Multi link via junction table. ***/
      assertExists(data.labels, "should have labels");

      const names = data
        .labels
        .map((l: { name: string; }) => l.name)
        .sort();

      assertEquals(names, ["classic", "fiction"]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "book_labels" CASCADE`).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS "book" CASCADE`).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS "label" CASCADE`).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS "shelf" CASCADE`).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS disc_migrations CASCADE`).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE`).catch(() => {});
      await pool.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
  ignore: !RUN_PG,
  name: "db import: imported graph is queryable through the EdgeQL compiler (single + multi link)"
});
