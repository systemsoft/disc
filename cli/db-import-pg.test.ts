/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stage 3/4 integration tests for `disc db import` — PG-backed.
 *
 * Migrates a small schema (a type with a single-link FK to another type, plus
 * an enum, a numeric, and a JSONB-tuple property, plus a multi-link), writes a
 * couple of fixture export CSVs to a temp dir, runs the importer, and asserts
 * that:
 *   - object + junction row counts match the CSVs,
 *   - the explicit `id` from each CSV is preserved verbatim,
 *   - the single-link FK column is populated,
 *   - the tuple property landed as JSONB.
 *
 * Requires DISC_PG_TEST_URL or DISC_PG_AUTO=1; skipped cleanly otherwise.
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { DbImport } from "./db-import.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

import {
  canRunPgTests,
  dropTables,
  getTestDsn,
  makePool,
  queryRows
} from "../tests/pg-test-harness.ts";

import type { CLIArgs } from "./commands.ts";

const RUN_PG = canRunPgTests();

const SDL = `
scalar type BookStatus extending enum<DRAFT, PUBLISHED>;

type Shelf {
  required name: str;
}

type Book {
  required title: str;
  required status: BookStatus;
  rating: float64;
  source: tuple<name: str, url: str>;
  required shelf: Shelf;
  multi labels: Label;
}

type Label {
  required name: str;
}
`;

/*** Stable UUIDs so we can assert id preservation directly. ***/
const SHELF_ID = "11111111-1111-1111-1111-111111111111";
const LABEL_X = "44444444-4444-4444-4444-444444444444";
const LABEL_Y = "55555555-5555-5555-5555-555555555555";
const BOOK_A = "22222222-2222-2222-2222-222222222222";
const BOOK_B = "33333333-3333-3333-3333-333333333333";

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    const dir = await Deno.makeTempDir({ prefix: "disc-import-test-" });

    try {
      await pool.initialize();

      /*** Migrate the schema into the live DB. ***/
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(SDL);
      assertEquals(applied.ok, true, `applySchema should succeed: ${applied.ok ? "" : JSON.stringify(applied)}`);
      const schema = manager.getSchema()!;

      /*** Write fixture export CSVs. ***/
      await Deno.writeTextFile(`${dir}/public_Shelf.csv`, `id,__type__,name\n${SHELF_ID},sometypeid,Main Shelf\n`);
      await Deno.writeTextFile(`${dir}/public_Label.csv`, `id,__type__,name\n${LABEL_X},t,fiction\n${LABEL_Y},t,classic\n`);

      /*** Book rows: enum, float, tuple (PG composite text), single-link FK. ***/
      await Deno.writeTextFile(
        `${dir}/public_Book.csv`,
        `id,__type__,title,status,rating,source,shelf_id\n` +
          `${BOOK_A},v,First,DRAFT,8.976667,"(""Example Source"",https://example.test)",${SHELF_ID}\n` +
          `${BOOK_B},v,Second,PUBLISHED,12.5,"(""Example Source"",https://example.test)",${SHELF_ID}\n`
      );

      /*** Junction: Book.labels. ***/
      await Deno.writeTextFile(
        `${dir}/public_Book.labels.csv`,
        `source,target\n${BOOK_A},${LABEL_X}\n${BOOK_A},${LABEL_Y}\n${BOOK_B},${LABEL_X}\n`
      );

      const args = { _: [] } as CLIArgs;
      const importer = new DbImport(schema, pool, dir, args);
      await importer.run();

      /*** Row counts. ***/
      const shelfCount = await queryRows<{ n: number; }>(dsn, `SELECT count(*)::int AS n FROM "shelf"`);
      assertEquals(Number(shelfCount[0].n), 1);

      const bookCount = await queryRows<{ n: number; }>(dsn, `SELECT count(*)::int AS n FROM "book"`);
      assertEquals(Number(bookCount[0].n), 2);

      const labelCount = await queryRows<{ n: number; }>(dsn, `SELECT count(*)::int AS n FROM "label"`);
      assertEquals(Number(labelCount[0].n), 2);

      /*** id preserved + FK populated + tuple landed as JSONB. ***/
      const books = await queryRows<{
        id: string;
        rating: number;
        shelf_id: string;
        source: { name: string; url: string; };
        status: string;
      }>(
        dsn,
        `SELECT id::text, shelf_id::text, rating, status, source FROM "book" ORDER BY title`
      );

      assertEquals(books[0].id, BOOK_A);
      assertEquals(books[0].shelf_id, SHELF_ID);
      assertEquals(Number(books[0].rating), 8.976667);
      assertEquals(books[0].status, "DRAFT");
      /*** deno-postgres decodes jsonb to a JS object. ***/
      assertEquals(books[0].source.name, "Example Source");
      assertEquals(books[0].source.url, "https://example.test");

      assertEquals(books[1].id, BOOK_B);
      assertEquals(books[1].status, "PUBLISHED");

      /*** Junction rows. ***/
      const junctionCount = await queryRows<{ n: number; }>(dsn, `SELECT count(*)::int AS n FROM "book_labels"`);
      assertEquals(Number(junctionCount[0].n), 3);

      const pair = await queryRows<{ n: number; }>(
        dsn,
        `SELECT count(*)::int AS n FROM "book_labels" WHERE source_id = $1 AND target_id = $2`,
        [BOOK_A, LABEL_X]
      );

      assertEquals(Number(pair[0].n), 1);
    } finally {
      await pool.close();
      await dropTables(dsn, "book_labels", "book", "label", "shelf");
      await Deno.remove(dir, { recursive: true });
    }
  },
  ignore: !RUN_PG,
  name: "db import: Pass 1 + Pass 2 load objects, FKs, tuple JSONB, junctions (id preserved)"
});
