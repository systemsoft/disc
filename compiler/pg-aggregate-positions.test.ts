/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: aggregates over one value of the current object (`any`,
 * `all`, `count`, `sum`, `min`, `max`) wherever a condition or a sort key
 * sits: a filter, an order by, an update's and a delete's filter, a nested
 * shape's filter and an access policy's condition all aggregate that
 * object's set of at most one element (never the rows of the enclosing
 * statement, which PostgreSQL rejects in WHERE: "aggregate functions are not
 * allowed in WHERE"), through a chain of single links (`.best.lead.name`)
 * too. A group's filter aggregates the group's rows.
 *
 * Compiled SQL: `compiler/aggregate-positions.test.ts`.
 *
 * Seed: leads x, y; posts P1 (lead x), P2 (lead y), P3 (no lead); users ann
 * (team a, visits 3, best P1), bob (team a, visits 1, best P2), cat (team b,
 * best P3) and dan (team b, nothing else); guarded g1 (best P1), g2 (best P2).
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `module default {
  type AgLead {
    required name: str;
  };
  type AgPost {
    required title: str;
    lead: AgLead;
  };
  type AgUser {
    required name: str;
    team: str;
    visits: int64;
    best: AgPost;
  };
  type AgGuarded {
    required name: str;
    best: AgPost;
    access policy see {
      allow select;
      using (any(.best.lead.name = 'x'));
    };
    access policy write {
      allow insert, update, delete;
    };
  };
};`;

type Run = (edgeql: string) => Promise<unknown[]>;

function compile(schema: Schema, edgeql: string): string {
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    accessContext: {},
    enableAccessControl: true
  });
  for (const typeDef of schema.types.values()) {
    for (const policy of typeDef.accessPolicies ?? []) {
      compiler.registerAccessPolicy(policy);
    }
  }
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(`Compilation failed for ${edgeql}: ${result.error.message}`);
  }
  return new SQLCodeGenerator().generate(result.value);
}

/*** Run `fn` against the seeded schema: `run` returns each row's one column. ***/
async function withSeed(fn: (run: Run) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool: ConnectionPool = makePool(dsn);
  await pool.initialize();
  try {
    await resetTestDatabase(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const schema = manager.getSchema()!;
    await manager.close();

    const run: Run = async edgeql => (await pool.query(compile(schema, edgeql))).rows.map(row => Object.values(row)[0]);
    await run("insert AgLead { name := 'x' }");
    await run("insert AgLead { name := 'y' }");
    await run("insert AgPost { title := 'P1', lead := (select AgLead filter .name = 'x' limit 1) }");
    await run("insert AgPost { title := 'P2', lead := (select AgLead filter .name = 'y' limit 1) }");
    await run("insert AgPost { title := 'P3' }");
    await run("insert AgUser { name := 'ann', team := 'a', visits := 3, best := (select AgPost filter .title = 'P1' limit 1) }");
    await run("insert AgUser { name := 'bob', team := 'a', visits := 1, best := (select AgPost filter .title = 'P2' limit 1) }");
    await run("insert AgUser { name := 'cat', team := 'b', best := (select AgPost filter .title = 'P3' limit 1) }");
    await run("insert AgUser { name := 'dan', team := 'b' }");
    await run("insert AgGuarded { name := 'g1', best := (select AgPost filter .title = 'P1' limit 1) }");
    await run("insert AgGuarded { name := 'g2', best := (select AgPost filter .title = 'P2' limit 1) }");

    await fn(run);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

const names = (rows: unknown[]): unknown[] => rows.map(row => (row as { name: string; }).name);

Deno.test({
  name: "PG aggregates over one value in a filter and an order by: per object, through a chain of single links",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSeed(async run => {
      const filtered = async (filter: string): Promise<unknown[]> => names(await run(`select AgUser { name } filter ${filter} order by .name`));
      assertEquals(await filtered("any(.best.lead.name = 'x')"), ["ann"]);
      assertEquals(await filtered("not any(.best.lead.name = 'y')"), ["ann", "cat", "dan"]);
      // `all` of no element is true: cat's best has no lead, dan has no best.
      assertEquals(await filtered("all(.best.lead.name = 'x')"), ["ann", "cat", "dan"]);
      assertEquals(await filtered("any(.visits > 1)"), ["ann"]);
      assertEquals(await filtered("count(.best.lead) = 1"), ["ann", "bob"]);
      assertEquals(await filtered("exists .best.lead"), ["ann", "bob"]);
      assertEquals(await filtered("count(.best.lead.name) = 0"), ["cat", "dan"]);
      assertEquals(await filtered("sum(.visits) = 0"), ["cat", "dan"]);
      assertEquals(await filtered("max(.best.lead.name) = 'y'"), ["bob"]);
      assertEquals(await filtered("min(.best.title) = 'P3'"), ["cat"]);

      assertEquals(names(await run("select AgUser { name } order by any(.best.lead.name = 'y') desc then .name")), ["bob", "ann", "cat", "dan"]);
      assertEquals(names(await run("select AgUser { name } order by count(.best.lead) desc then sum(.visits) then .name")), [
        "bob",
        "ann",
        "cat",
        "dan"
      ]);
    });
  }
});

Deno.test({
  name: "PG aggregates over one value in an update's, a delete's and a nested shape's filter",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSeed(async run => {
      await run("update AgUser filter any(.best.lead.name = 'y') set { visits := 9 }");
      assertEquals(names(await run("select AgUser { name } filter .visits = 9")), ["bob"]);

      await run("delete AgUser filter all(.best.lead.name = 'nobody') and count(.best) = 0");
      assertEquals(names(await run("select AgUser { name } order by .name")), ["ann", "bob", "cat"]);

      assertEquals(
        await run("select AgPost { title, lead: { name } filter any(.name = 'x') } order by .title"),
        [{ lead: [{ name: "x" }], title: "P1" }, { lead: null, title: "P2" }, { lead: null, title: "P3" }]
      );
    });
  }
});

Deno.test({
  name: "PG aggregates over one value in an access policy's condition, and over a group's rows in its filter",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSeed(async run => {
      assertEquals(names(await run("select AgGuarded { name }")), ["g1"]);

      const teams = async (filter: string): Promise<unknown[]> =>
        (await run(`group AgUser by .team filter ${filter}`)).map(group => (group as { key: { team: string; }; }).key.team).sort();
      assertEquals(await teams("any(.best.lead.name = 'x')"), ["a"]);
      assertEquals(await teams("sum(.visits) > 3"), ["a"]);
      assertEquals(await teams("count(.visits) = 0"), ["b"]);
      assertEquals(await teams("count(AgUser) = 2"), ["a", "b"]);
    });
  }
});
