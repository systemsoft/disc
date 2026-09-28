/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: schema computeds written in the EdgeQL expression grammar
 * the SDL expression parser alone does not cover — set operators (`union`,
 * `except`, `intersect`), `is` / `is not`, `//`, `^`, array literals and
 * bigint, bytes and decimal literals; a path off a parenthesized select
 * (`(select .teams order by .name limit 1).name`); and link properties
 * through computed links (a one-hop alias carries them; a multi-hop computed
 * link does not, as in Gel, but a path to one does:
 * `.teams.members@role`). (Calls of SDL-declared functions are typed by their
 * declared return type — codegen/computed-results.test.ts — but Disc does
 * not run them yet.)
 *
 * Expected values are Gel 7.1's for the same schema and data.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Schema } from "./context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type CeTeam {
    required name: str;
    multi members: CeMember { role: str; };
    ms := .members;
  }
  type CeMember {
    required name: str;
  }
  type CeOrg {
    required name: str;
    multi teams: CeTeam;
    team_roles := .teams.members;
    first_team_name := (select .teams order by .name limit 1).name;
    roles := .teams.members@role;
    names := .name union 'x';
    exc := {'a', 'b'} except 'a';
    inter := {'a', 'b'} intersect 'a';
    is_team := .teams is CeTeam;
    not_member := .teams is not CeMember;
    fdiv := len(.name) // 2;
    pw := len(.name) ^ 2;
    md := len(.name) % 2;
    ar := [.name, .name];
    big := 1n;
    bts := b'ab';
    dec := 1.5n;
  }
}`;

const TABLES = ["ce_org_teams", "ce_team_members", "ce_org", "ce_team", "ce_member"];
const M1 = "00000000-0000-7000-8000-0000000000e1";
const M2 = "00000000-0000-7000-8000-0000000000e2";
const TA = "00000000-0000-7000-8000-0000000000ea";
const TB = "00000000-0000-7000-8000-0000000000eb";
const O1 = "00000000-0000-7000-8000-0000000000f1";
const O2 = "00000000-0000-7000-8000-0000000000f2";

type Pool = ReturnType<typeof makePool>;

async function dropAll(pool: Pool): Promise<void> {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Migrate, then: team b has m1 (lead), team a has m1 and m2 (dev); org1 has both teams, org2 none. ***/
async function setup(pool: Pool): Promise<{ manager: SchemaManager; schema: Schema; }> {
  await dropAll(pool);
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
  const schema = manager.getSchema();
  if (!schema)
    throw new Error("no schema after applySchema");

  await pool.query(`INSERT INTO ce_member (id, name) VALUES ('${M1}', 'm1'), ('${M2}', 'm2')`);
  await pool.query(`INSERT INTO ce_team (id, name) VALUES ('${TA}', 'a'), ('${TB}', 'b')`);
  await pool.query(
    `INSERT INTO ce_team_members (source_id, target_id, role) VALUES ('${TB}', '${M1}', 'lead'), ('${TA}', '${M1}', 'dev'), ('${TA}', '${M2}', 'dev')`
  );
  await pool.query(`INSERT INTO ce_org (id, name) VALUES ('${O1}', 'org1'), ('${O2}', 'org2')`);
  await pool.query(`INSERT INTO ce_org_teams (source_id, target_id) VALUES ('${O1}', '${TA}'), ('${O1}', '${TB}')`);
  return { manager, schema };
}

async function rows(pool: Pool, schema: Schema, query: string): Promise<Record<string, unknown>[]> {
  const res = await pool.query(compileEdgeQL(query, schema));
  return res.rows.map(row => (row as Record<string, unknown>).jsonb_build_object as Record<string, unknown>);
}

function pgTest(name: string, fn: (pool: Pool, schema: Schema) => Promise<void>): void {
  Deno.test({
    name: `PG computed expressions: ${name}`,
    ignore: !RUN_PG,
    fn: async () => {
      const pool = makePool(await getTestDsn());
      await pool.initialize();
      try {
        const { manager, schema } = await setup(pool);
        try {
          await fn(pool, schema);
        } finally {
          await manager.close();
        }
      } finally {
        await dropAll(pool);
        await pool.close();
      }
    }
  });
}

/*** A multi value's elements sorted, so a comparison does not depend on their order. ***/
function sorted(value: unknown): unknown {
  return Array.isArray(value) ? [...value].sort() : value;
}

pgTest("set operators, is, //, ^, %, arrays and bigint, bytes and decimal literals", async (pool, schema) => {
  const [org1, org2] = await rows(
    pool,
    schema,
    "select CeOrg { name, names, exc, inter, is_team, not_member, fdiv, pw, md, ar, big, bts, dec } order by .name"
  );
  assertEquals({ ...org1, names: sorted(org1.names) }, {
    ar: ["org1", "org1"],
    big: 1,
    bts: "YWI=",
    dec: 1.5,
    exc: ["b"],
    fdiv: 2,
    inter: "a",
    is_team: [true, true],
    md: 0,
    name: "org1",
    names: ["org1", "x"],
    not_member: [true, true],
    pw: 16
  });
  assertEquals({ ...org2, names: sorted(org2.names) }, {
    ar: ["org2", "org2"],
    big: 1,
    bts: "YWI=",
    dec: 1.5,
    exc: ["b"],
    fdiv: 2,
    inter: "a",
    is_team: [],
    md: 0,
    name: "org2",
    names: ["org2", "x"],
    not_member: [],
    pw: 16
  });
});

pgTest("a path off a parenthesized select", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select CeOrg { name, first_team_name } order by .name"), [
    { first_team_name: "a", name: "org1" },
    { first_team_name: null, name: "org2" }
  ]);
  assertEquals(await rows(pool, schema, "select CeOrg { name } filter .first_team_name = 'a'"), [{ name: "org1" }]);
  assertEquals(await rows(pool, schema, "select CeOrg { name, t := (select .teams order by .name desc limit 1).name } order by .name"), [
    { name: "org1", t: "b" },
    { name: "org2", t: null }
  ]);
});

pgTest("link properties through computed links", async (pool, schema) => {
  // A one-hop alias of a link carries its link properties.
  assertEquals(await rows(pool, schema, "select CeTeam { name, ms: { name, @role } order by .name } order by .name"), [
    { ms: [{ "@role": "dev", name: "m1" }, { "@role": "dev", name: "m2" }], name: "a" },
    { ms: [{ "@role": "lead", name: "m1" }], name: "b" }
  ]);
  // A path to a link property through several links reads it on the last one.
  const [org1, org2] = await rows(pool, schema, "select CeOrg { name, roles, r := .teams.members@role } order by .name");
  assertEquals({ ...org1, r: sorted(org1.r), roles: sorted(org1.roles) }, { name: "org1", r: ["dev", "dev", "lead"], roles: ["dev", "dev", "lead"] });
  assertEquals(org2, { name: "org2", r: [], roles: [] });
  // A multi-hop computed link has no link properties (Gel: InvalidReferenceError).
  await assertRejects(
    () => rows(pool, schema, "select CeOrg { team_roles: { name, @role } }"),
    Error,
    "link 'team_roles' of object type 'default::CeOrg' has no property 'role'"
  );
});
