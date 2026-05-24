/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG-backed integration test for the live-schema-diff apply endpoint
 * (Bundle K — Disc-original feature #3a).
 *
 * Skipped when no PG harness is available.
 *
 * Covers:
 *   - happy-path apply: add a fresh type to the on-disk SDL and POST
 *     /admin/schema-apply; the migration runs end-to-end through the
 *     real engine, the table appears in PG.
 *   - unsafe-op gate: drop a type and confirm the apply refuses
 *     without `?force=true` and succeeds with it.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn, parseDsn } from "../../tests/pg-test-harness.ts";
import { handleSchemaApply } from "./schema-apply.ts";

const RUN_PG = canRunPgTests();
const SUFFIX = `bundlek_${Date.now()}`;
const TYPE_NAME = `BkType${Date.now() % 100000}`;
const TABLE_NAME = `bk_type${Date.now() % 100000}`;

async function withTempSdl(
  initial: string,
  fn: (path: string) => Promise<void>
): Promise<void> {
  const tmp = await Deno.makeTempFile({ suffix: `_${SUFFIX}.disc` });
  await Deno.writeTextFile(tmp, initial);
  try {
    await fn(tmp);
  } finally {
    try {
      await Deno.remove(tmp);
    } catch {
      // best-effort
    }
  }
}

async function tableExists(dsn: string, name: string): Promise<boolean> {
  const client = new Client(parseDsn(dsn));
  await client.connect();
  try {
    const r = await client.queryArray<[boolean]>(
      `SELECT EXISTS(SELECT 1 FROM pg_tables WHERE tablename = $1)`,
      [name.toLowerCase()]
    );
    return r.rows[0]?.[0] === true;
  } finally {
    await client.end();
  }
}

async function dropTableIfExists(dsn: string, name: string): Promise<void> {
  const client = new Client(parseDsn(dsn));
  await client.connect();
  try {
    await client.queryArray(
      `DROP TABLE IF EXISTS "${name.toLowerCase()}" CASCADE`
    );
  } finally {
    await client.end();
  }
}

Deno.test({
  name: "Bundle K — apply happy path: new type via /admin/schema-apply creates the PG table",
  ignore: !RUN_PG,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    // Make sure we're starting clean.
    await dropTableIfExists(dsn, TABLE_NAME);

    const sdl = `module default {\n  type ${TYPE_NAME} {\n    required name: str;\n  };\n};`;
    await withTempSdl(sdl, async path => {
      const res = await handleSchemaApply({
        request: new Request("http://localhost/admin/schema-apply", {
          method: "POST"
        }),
        url: new URL("http://localhost/admin/schema-apply"),
        source: { kind: "file", path },
        databaseUrl: dsn
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.ok, true);
      assertEquals(Array.isArray(body.applied), true);

      const exists = await tableExists(dsn, TABLE_NAME);
      assertEquals(exists, true);
    });

    // Cleanup so re-running the suite doesn't leak.
    await dropTableIfExists(dsn, TABLE_NAME);
  }
});

Deno.test({
  name: "Bundle K — apply gate refuses unsafe drop without force=true, accepts with force",
  ignore: !RUN_PG,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const dropTypeName = `BkDrop${Date.now() % 100000}`;
    const dropTableName = `bk_drop${Date.now() % 100000}`;
    await dropTableIfExists(dsn, dropTableName);

    // Step 1: create the type via apply.
    const sdlWith = `module default {\n  type ${dropTypeName} {\n    required name: str;\n  };\n};`;
    await withTempSdl(sdlWith, async path => {
      const res = await handleSchemaApply({
        request: new Request("http://localhost/admin/schema-apply", {
          method: "POST"
        }),
        url: new URL("http://localhost/admin/schema-apply"),
        source: { kind: "file", path },
        databaseUrl: dsn
      });
      assertEquals(res.status, 200);
    });
    assertEquals(await tableExists(dsn, dropTableName), true);

    // Step 2: drop the type from SDL — should be refused without force.
    // Pass the previous SDL as the applied-baseline so the unsafe-op
    // gate has a real before/after to compare. Without this, the
    // SchemaManager would start from `null` and treat the drop as
    // a no-op (silently bypassing the gate).
    const sdlEmpty = `module default {};`;
    await withTempSdl(sdlEmpty, async path => {
      const refused = await handleSchemaApply({
        request: new Request("http://localhost/admin/schema-apply", {
          method: "POST"
        }),
        url: new URL("http://localhost/admin/schema-apply"),
        source: { kind: "file", path },
        databaseUrl: dsn,
        appliedSdl: sdlWith
      });
      assertEquals(refused.status, 400);
      const body = await refused.json();
      assertEquals(body.gateRefusal, true);
      assertEquals(body.force, false);
      // Table should still exist — gate fired before any DDL ran.
      assertEquals(await tableExists(dsn, dropTableName), true);

      // Step 3: same payload with force=true succeeds.
      const forced = await handleSchemaApply({
        request: new Request("http://localhost/admin/schema-apply?force=true", {
          method: "POST"
        }),
        url: new URL("http://localhost/admin/schema-apply?force=true"),
        source: { kind: "file", path },
        databaseUrl: dsn,
        appliedSdl: sdlWith
      });
      assertEquals(forced.status, 200);
      const okBody = await forced.json();
      assertEquals(okBody.ok, true);
      assertEquals(okBody.force, true);
      assertEquals(await tableExists(dsn, dropTableName), false);
    });

    await dropTableIfExists(dsn, dropTableName);
  }
});
