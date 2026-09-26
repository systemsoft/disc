/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Drift repair looks tables up by the name PostgreSQL stores: a quoted
 * identifier keeps its case (a camelCase link's junction is created as
 * `"channel_pinnedVideo"`), a bare one folds to lowercase.
 */

import { assertEquals } from "@std/assert";
import { reconcileCreateTables, withoutDropsOf, type ExistingColumn } from "./reconcile.ts";

const JUNCTION: ExistingColumn[] = [
  { dataType: "uuid", name: "source_id" },
  { dataType: "uuid", name: "target_id" }
];

const CREATE_JUNCTION = `CREATE TABLE "channel_pinnedVideo" (source_id UUID NOT NULL, target_id UUID NOT NULL);`;
const JUNCTION_CONSTRAINT = `ALTER TABLE "channel_pinnedVideo" ADD CONSTRAINT "uk_channel_pinnedVideo_source_target" UNIQUE (source_id, target_id);`;

Deno.test("reconcileCreateTables finds an existing quoted mixed-case table and skips its CREATE and dependents", async () => {
  const asked: string[] = [];
  const result = await reconcileCreateTables([CREATE_JUNCTION, JUNCTION_CONSTRAINT], tableName => {
    asked.push(tableName);
    return Promise.resolve(tableName === "channel_pinnedVideo" ? JUNCTION : null);
  });

  assertEquals(asked, ["channel_pinnedVideo"]);
  assertEquals(result.statements, []);
  assertEquals([...result.skippedTables], ["channel_pinnedVideo"]);
});

Deno.test("reconcileCreateTables folds a bare table name to lowercase", async () => {
  const asked: string[] = [];
  await reconcileCreateTables([`CREATE TABLE Widget (id UUID NOT NULL);`], tableName => {
    asked.push(tableName);
    return Promise.resolve(null);
  });

  assertEquals(asked, ["widget"]);
});

Deno.test("withoutDropsOf keeps a skipped quoted mixed-case table", () => {
  const rollback = [`DROP TABLE IF EXISTS "channel_pinnedVideo" CASCADE;`, `DROP TABLE IF EXISTS video CASCADE;`];

  assertEquals(withoutDropsOf(rollback, new Set(["channel_pinnedVideo"])), [`DROP TABLE IF EXISTS video CASCADE;`]);
});

Deno.test("reconcileCreateTables skips indexes on a skipped quoted table", async () => {
  const result = await reconcileCreateTables(
    [`CREATE TABLE "user" (id UUID NOT NULL);`, `CREATE UNIQUE INDEX uk_user_id ON "user" (id);`],
    tableName => Promise.resolve(tableName === "user" ? [{ dataType: "uuid", name: "id" }] : null)
  );

  assertEquals(result.statements, []);
});
