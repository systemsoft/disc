/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `multi` scalar properties.
 *
 * A downstream project declared `multi scopes: str { constraint one_of(…) }`
 * and got a single `text` column: a two-element insert failed the one-of
 * check, `scopes := array_unpack(<array<str>>$s)` inserted one row per
 * element, and reads returned one string. A multi scalar property is a set of
 * values; Disc stores it as a PostgreSQL array column (`text[]`), with the
 * property's constraints applied to every element.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type MultiToken {
    required name: str;
    multi scopes: str {
      constraint one_of("read", "write", "admin");
    };
    multi ports: int64 {
      constraint min_value(1);
    };
    multi tags: str {
      constraint max_len_value(5);
      constraint regexp("^[a-z]+$");
    };
  };
  type MultiGrant {
    required name: str;
    required multi roles: str;
  };
};`;

const TABLES = ["multi_token", "multi_grant", "multi_convert"];

function makeContext(): Types.QueryContext {
  return {
    session: {
      sessionId: `multi_prop_${Date.now()}`,
      database: "disc_test",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: `req_${Date.now()}`,
    startedAt: new Date()
  };
}

async function dropAll(pool: { query: (sql: string) => Promise<unknown>; }): Promise<void> {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

Deno.test({
  name: "PG multi scalar property: array storage, per-element constraints, insert/select/filter/update",
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
      assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
      const schema = manager.getSchema()!;

      // The column is a text[] (not a single text), and empty by default.
      const column = await pool.query(
        "SELECT data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'multi_token' AND column_name = 'scopes'"
      );
      assertEquals(column.rows[0].data_type, "ARRAY");
      assertEquals(column.rows[0].udt_name, "_text");
      assertEquals(column.rows[0].is_nullable, "NO");

      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema });
      const run = async (query: string, variables?: Record<string, unknown>) => {
        const res = await handler.handleRequest({ query, variables }, makeContext());
        assertEquals(res.errors, undefined, `${query}: ${JSON.stringify(res.errors)}`);
        return res.data;
      };
      const tokens = async (query: string, variables?: Record<string, unknown>) => (await run(query, variables)) as Record<string, unknown>[];
      const count = async () => Number((await pool.query("SELECT count(*) AS n FROM multi_token")).rows[0].n);

      try {
        // Set literal → one row holding both values.
        await run(`insert MultiToken { name := "lit", scopes := {"read", "write"}, ports := {80, 443} }`);
        assertEquals(await count(), 1, "set literal inserts one row");

        // array_unpack of a two-element array param → one row, not one per element.
        await run(`insert MultiToken { name := "unpack", scopes := array_unpack(<array<str>>$s) }`, { s: ["read", "admin"] });
        assertEquals(await count(), 2, "array_unpack inserts one row");

        // A single value, and the empty set.
        await run(`insert MultiToken { name := "one", scopes := <str>$one }`, { one: "write" });
        await run(`insert MultiToken { name := "none", scopes := {} }`);
        await run(`insert MultiToken { name := "omitted" }`);
        assertEquals(await count(), 5);

        // Read back as arrays; `{ * }` includes the multi property.
        const read = await tokens("select MultiToken { name, scopes, ports } order by .name");
        const byName = Object.fromEntries(read.map(r => [r.name, r]));
        assertEquals(byName.lit.scopes, ["read", "write"]);
        assertEquals(byName.lit.ports, [80, 443]);
        assertEquals(byName.unpack.scopes, ["read", "admin"]);
        assertEquals(byName.one.scopes, ["write"]);
        assertEquals(byName.none.scopes, []);
        assertEquals(byName.omitted.scopes, []);
        const splat = await tokens(`select MultiToken { * } filter .name = "lit"`);
        assertEquals(splat[0].scopes, ["read", "write"]);

        // Filters: membership, any-element equality, count, exists.
        const names = async (filter: string, variables?: Record<string, unknown>) =>
          (await tokens(`select MultiToken { name } filter ${filter} order by .name`, variables)).map(r => r.name);
        assertEquals(await names(`"read" in .scopes`), ["lit", "unpack"]);
        assertEquals(await names(`.scopes = "write"`), ["lit", "one"]);
        assertEquals(await names(`.scopes = <str>$s`, { s: "admin" }), ["unpack"]);
        assertEquals(await names(`count(.scopes) = 2`), ["lit", "unpack"]);
        assertEquals(await names(`exists .scopes`), ["lit", "one", "unpack"]);
        assertEquals(await names(`not exists .scopes`), ["none", "omitted"]);
        assertEquals(await names(`.scopes in array_unpack(<array<str>>$s)`, { s: ["admin", "nope"] }), ["unpack"]);
        const counted = await tokens(`select MultiToken { name, n := count(.scopes) } filter .name = "lit"`);
        assertEquals(Number(counted[0].n), 2);

        // A disallowed element fails the per-element one_of check.
        const bad = await handler.handleRequest(
          { query: `insert MultiToken { name := "bad", scopes := {"read", "delete"} }` },
          makeContext()
        );
        assert(bad.errors && bad.errors.length > 0, "disallowed scope must be rejected");
        assert(JSON.stringify(bad.errors).includes("check"), JSON.stringify(bad.errors));
        const badPort = await handler.handleRequest(
          { query: `insert MultiToken { name := "badport", ports := {8080, 0} }` },
          makeContext()
        );
        assert(badPort.errors && badPort.errors.length > 0, "port 0 must fail min_value(1)");
        for (const tags of [`{"toolong"}`, `{"ok", "Caps"}`]) {
          const badTags = await handler.handleRequest(
            { query: `insert MultiToken { name := "badtags", tags := ${tags} }` },
            makeContext()
          );
          assert(badTags.errors && badTags.errors.length > 0, `tags ${tags} must fail the per-element checks`);
        }
        assertEquals(await count(), 5, "rejected inserts wrote nothing");
        await run(`update MultiToken filter .name = "lit" set { tags := {"ab", "cd"} }`);
        assertEquals(await names(`.tags like "a%"`), ["lit"]);

        // Update: replace, append, remove.
        await run(`update MultiToken filter .name = "one" set { scopes := {"admin"} }`);
        assertEquals((await tokens(`select MultiToken { scopes } filter .name = "one"`))[0].scopes, ["admin"]);
        await run(`update MultiToken filter .name = "one" set { scopes += "read" }`);
        assertEquals((await tokens(`select MultiToken { scopes } filter .name = "one"`))[0].scopes, ["admin", "read"]);
        await run(`update MultiToken filter .name = "one" set { scopes += array_unpack(<array<str>>$s) }`, { s: ["write"] });
        assertEquals((await tokens(`select MultiToken { scopes } filter .name = "one"`))[0].scopes, ["admin", "read", "write"]);
        await run(`update MultiToken filter .name = "one" set { scopes -= {"admin", "write"} }`);
        assertEquals((await tokens(`select MultiToken { scopes } filter .name = "one"`))[0].scopes, ["read"]);
        await run(`update MultiToken filter .name = "one" set { scopes := {} }`);
        assertEquals((await tokens(`select MultiToken { scopes } filter .name = "one"`))[0].scopes, []);
        const badUpdate = await handler.handleRequest(
          { query: `update MultiToken filter .name = "one" set { scopes += "delete" }` },
          makeContext()
        );
        assert(badUpdate.errors && badUpdate.errors.length > 0, "update must honor one_of per element");

        // The insert response maps the array column back to the property.
        const inserted = await run(`insert MultiToken { name := "resp", scopes := {"read"} }`) as Record<string, unknown>;
        const insertedRow = (Array.isArray(inserted) ? inserted[0] : inserted) as Record<string, unknown>;
        assertEquals(insertedRow.scopes, ["read"]);

        // `required multi` rejects an empty set.
        await run(`insert MultiGrant { name := "g", roles := {"x"} }`);
        const emptyRequired = await handler.handleRequest(
          { query: `insert MultiGrant { name := "empty", roles := {} }` },
          makeContext()
        );
        assert(emptyRequired.errors && emptyRequired.errors.length > 0, "required multi must reject {}");
      } finally {
        await handler.close();
      }
      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG multi scalar property: single → multi migration keeps each value as a one-element set",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const single = await manager.applySchema(`module default { type MultiConvert { required name: str; scope: str; }; };`);
      assertEquals(single.ok, true, JSON.stringify(single));
      await pool.query("INSERT INTO multi_convert (name, scope) VALUES ('set', 'read'), ('unset', NULL)");

      const multi = await manager.applySchema(
        `module default { type MultiConvert { required name: str; multi scope: str { constraint one_of("read", "write"); }; }; };`
      );
      assertEquals(multi.ok, true, multi.ok ? "" : multi.error.message);

      const rows = await pool.query("SELECT name, scope FROM multi_convert ORDER BY name");
      assertEquals(rows.rows.map(r => [r.name, r.scope]), [["set", ["read"]], ["unset", []]]);
      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});
