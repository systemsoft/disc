/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: link properties.
 *
 * A downstream project declared `multi members: User { role: str; }` and got a
 * junction table with only `source_id`/`target_id`: `{ @role }` in a shape was
 * a parse error and `.members@role` a missing column. A link property on a
 * `multi` link is a column of the link's junction table; it is read with
 * `@prop` inside the link's shape, filtered with `.link@prop`, and written
 * with `(select Target …) { @prop := value }` in an insert or update.
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
  type LpUser {
    required name: str;
  };
  type LpProgram {
    required name: str;
    multi members: LpUser {
      role: str;
      weight: int64 {
        default := 1;
      };
    };
    multi link owners -> LpUser {
      required property level: str {
        constraint one_of("full", "limited");
      };
    };
  };
};`;

const TABLES = ["lp_program_members", "lp_program_owners", "lp_program", "lp_user"];

function makeContext(): Types.QueryContext {
  return {
    session: {
      sessionId: `link_prop_${Date.now()}`,
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
  name: "PG link properties: junction columns, @prop read/filter/order, insert and update link props",
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
      assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
      const schema = manager.getSchema()!;

      // The link properties are columns of the junction tables.
      const columns = await pool.query(
        "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns " +
          "WHERE table_name IN ('lp_program_members', 'lp_program_owners') ORDER BY table_name, column_name"
      );
      const byColumn = Object.fromEntries(columns.rows.map(r => [`${r.table_name}.${r.column_name}`, r]));
      assertEquals(byColumn["lp_program_members.role"].data_type, "text");
      assertEquals(byColumn["lp_program_members.role"].is_nullable, "YES");
      assertEquals(byColumn["lp_program_members.weight"].data_type, "bigint");
      assertEquals(byColumn["lp_program_members.weight"].column_default, "1");
      assertEquals(byColumn["lp_program_owners.level"].is_nullable, "NO");

      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema });
      const run = async (query: string, variables?: Record<string, unknown>) => {
        const res = await handler.handleRequest({ query, variables }, makeContext());
        assertEquals(res.errors, undefined, `${query}: ${JSON.stringify(res.errors)}`);
        return res.data;
      };
      const rows = async (query: string, variables?: Record<string, unknown>) => (await run(query, variables)) as Record<string, unknown>[];
      const fails = async (query: string, fragment: string) => {
        const res = await handler.handleRequest({ query }, makeContext());
        assert(res.errors && res.errors.length > 0, `${query} must fail`);
        assert(JSON.stringify(res.errors).includes(fragment), `${query}: ${JSON.stringify(res.errors)}`);
      };
      const members = async (program: string, shape = "{ name, @role, @weight } order by .name") =>
        (await rows(`select LpProgram { members: ${shape} } filter .name = "${program}"`))[0].members;

      try {
        for (const name of ["a", "b", "c"]) {
          await run(`insert LpUser { name := "${name}" }`);
        }

        // Insert with a link property per target, from a set of shaped subqueries.
        await run(
          `insert LpProgram { name := "p1", members := {
            (select LpUser filter .name = "a") { @role := "admin" },
            (select LpUser filter .name = "b") { @role := <str>$role }
          } }`,
          { role: "member" }
        );
        // A target without link properties gets the column defaults.
        await run(`insert LpProgram { name := "p2", members := (select LpUser filter .name = "c") }`);

        assertEquals(await members("p1"), [
          { name: "a", "@role": "admin", "@weight": 1 },
          { name: "b", "@role": "member", "@weight": 1 }
        ]);
        assertEquals(await members("p2"), [{ name: "c", "@role": null, "@weight": 1 }]);

        // Filter the source by a link property (true when any link matches).
        const programs = async (filter: string) => (await rows(`select LpProgram { name } filter ${filter} order by .name`)).map(r => r.name);
        assertEquals(await programs(`.members@role = "admin"`), ["p1"]);
        assertEquals(await programs(`.members@weight = 1`), ["p1", "p2"]);
        assertEquals(await programs(`"member" in .members@role`), ["p1"]);
        assertEquals(await programs(`.members@role in {"admin", "owner"}`), ["p1"]);

        // Filter and order the linked set by a link property; computed link property.
        assertEquals(await members("p1", `{ name } filter @role = "admin"`), [{ name: "a" }]);
        assertEquals(await members("p1", `{ name, @role } order by @role desc`), [
          { name: "b", "@role": "member" },
          { name: "a", "@role": "admin" }
        ]);
        assertEquals(await members("p1", `{ name, @r := @role ++ "!" } order by .name`), [
          { name: "a", "@r": "admin!" },
          { name: "b", "@r": "member!" }
        ]);

        // `+=` on an already-linked target updates the link properties it sets.
        await run(`update LpProgram filter .name = "p1" set { members += (select LpUser filter .name = "b") { @role := "owner", @weight := 5 } }`);
        // `+=` a new target adds it with its link properties.
        await run(`update LpProgram filter .name = "p1" set { members += (select LpUser filter .name = "c") { @role := "guest" } }`);
        // `+=` without link properties leaves an existing link's properties alone.
        await run(`update LpProgram filter .name = "p1" set { members += (select LpUser filter .name = "a") }`);
        assertEquals(await members("p1"), [
          { name: "a", "@role": "admin", "@weight": 1 },
          { name: "b", "@role": "owner", "@weight": 5 },
          { name: "c", "@role": "guest", "@weight": 1 }
        ]);

        // `:=` replaces the set; a kept target's link property is updated.
        await run(`update LpProgram filter .name = "p1" set { members := (select LpUser filter .name = "a") { @role := "viewer" } }`);
        assertEquals(await members("p1"), [{ name: "a", "@role": "viewer", "@weight": 1 }]);

        // `required` link property (NOT NULL) and `one_of` (CHECK) on the junction.
        await fails(`insert LpProgram { name := "p3", owners := (select LpUser filter .name = "a") }`, "null");
        await fails(`insert LpProgram { name := "p3", owners := (select LpUser filter .name = "a") { @level := "root" } }`, "check");
        await run(`insert LpProgram { name := "p3", owners := (select LpUser filter .name = "a") { @level := "limited" } }`);
        assertEquals((await rows(`select LpProgram { owners: { name, @level } } filter .name = "p3"`))[0].owners, [
          { name: "a", "@level": "limited" }
        ]);
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
  name: "PG link properties: adding, then dropping, a link property on a link that has rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const plain = await manager.applySchema(`module default {
        type LpUser { required name: str; };
        type LpProgram { required name: str; multi members: LpUser; };
      };`);
      assertEquals(plain.ok, true, plain.ok ? "" : plain.error.message);

      let handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
      await handler.handleRequest({ query: `insert LpUser { name := "a" }` }, makeContext());
      const inserted = await handler.handleRequest(
        { query: `insert LpProgram { name := "p", members := (select LpUser filter .name = "a") }` },
        makeContext()
      );
      assertEquals(inserted.errors, undefined, JSON.stringify(inserted.errors));
      await handler.close();

      const withProps = await manager.applySchema(`module default {
        type LpUser { required name: str; };
        type LpProgram {
          required name: str;
          multi members: LpUser {
            role: str;
            required rank: int64 { default := 0; };
          };
        };
      };`);
      assertEquals(withProps.ok, true, withProps.ok ? "" : withProps.error.message);

      handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
      try {
        const read = async () => {
          const res = await handler.handleRequest({ query: `select LpProgram { members: { name, @role, @rank } }` }, makeContext());
          assertEquals(res.errors, undefined, JSON.stringify(res.errors));
          return (res.data as Record<string, unknown>[])[0].members;
        };
        // The existing link keeps its row; new columns are NULL / their default.
        assertEquals(await read(), [{ name: "a", "@role": null, "@rank": 0 }]);
        const updated = await handler.handleRequest(
          { query: `update LpProgram filter .name = "p" set { members += (select LpUser filter .name = "a") { @role := "lead" } }` },
          makeContext()
        );
        assertEquals(updated.errors, undefined, JSON.stringify(updated.errors));
        assertEquals(await read(), [{ name: "a", "@role": "lead", "@rank": 0 }]);
      } finally {
        await handler.close();
      }

      // Dropping a link property is an unsafe (data-losing) column drop.
      const dropped = await manager.applySchema(
        `module default {
          type LpUser { required name: str; };
          type LpProgram { required name: str; multi members: LpUser { role: str; }; };
        };`,
        { allowUnsafe: true }
      );
      assertEquals(dropped.ok, true, dropped.ok ? "" : dropped.error.message);
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'lp_program_members' ORDER BY column_name"
      );
      assertEquals(cols.rows.map(r => r.column_name), ["role", "source_id", "target_id"]);
      const kept = await pool.query("SELECT role FROM lp_program_members");
      assertEquals(kept.rows.map(r => r.role), ["lead"]);
      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG link properties: a database migrated before link properties were stored gets the junction columns",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const sdl = `module default {
      type LpUser { required name: str; };
      type LpProgram { required name: str; multi link members -> LpUser { property role: str; }; };
    };`;

    try {
      await dropAll(pool);
      const first = new SchemaManager({ pool });
      await first.initialize();
      const applied = await first.applySchema(sdl);
      assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);
      await first.close();
      // What older Disc versions left behind: the stored schema declares the
      // link property, but the junction table has only source_id / target_id.
      await pool.query("ALTER TABLE lp_program_members DROP COLUMN role");

      const upgraded = new SchemaManager({ pool });
      await upgraded.initialize();
      const migrated = await upgraded.applySchema(sdl);
      assertEquals(migrated.ok, true, migrated.ok ? "" : migrated.error.message);
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'lp_program_members' ORDER BY column_name"
      );
      assertEquals(cols.rows.map(r => r.column_name), ["role", "source_id", "target_id"]);

      // Idempotent: the next migrate has nothing to do.
      const again = await upgraded.applySchema(sdl);
      assertEquals(again.ok, true, again.ok ? "" : again.error.message);
      assertEquals(again.ok ? again.value.length : -1, 0);
      await upgraded.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});
