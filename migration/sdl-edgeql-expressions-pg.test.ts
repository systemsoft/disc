/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: SDL constraint expressions and arguments, access policies,
 * globals' defaults and aliases written in EdgeQL the SDL expression grammar
 * does not cover (set and array literals, `//`, `^`, `union`, a shape), as
 * Gel's SDL allows them. Each is kept as written and compiled from that text.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const SDL = `module default {
  scalar type Even extending int64 {
    constraint expression on (__subject__ % 2 = 0 and __subject__ // 2 < 100);
  };
  global tiers: array<str> {
    default := ['gold', 'silver'];
  };
  type XqItem {
    required name: str {
      constraint max_len_value(2 ^ 3);
    };
    tier: str;
    n: Even;
    constraint expression on (.tier in {'gold', 'silver', 'bronze'});
    access policy all_ok allow all;
    access policy hide_bronze deny select using (.tier in {'bronze'});
  };
  alias XqNamed := XqItem { name, loud := str_upper(.name) };
  alias XqTiers := XqItem.tier union 'none';
}`;

/*** `edgeql` as SQL, with every type's access policies applied, as the server compiles it. ***/
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

async function values(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  return (await pool.query(compile(schema, edgeql))).rows.map(row => Object.values(row)[0]);
}

Deno.test({
  name: "PG SDL EdgeQL expressions: constraints, policies, a global's default and aliases beyond the SDL grammar",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();
    const manager = new SchemaManager({ pool });
    try {
      await resetTestDatabase(pool);
      await manager.initialize();
      const applied = await manager.applySchema(SDL);
      assert(applied.ok, applied.ok ? "" : applied.error.message);
      const schema = manager.getSchema();
      assert(schema);

      for (const [name, tier, n] of [["a", "gold", 2], ["b", "bronze", 4], ["c", "silver", 6]]) {
        await values(pool, schema, `insert XqItem { name := '${name}', tier := '${tier}', n := ${n} }`);
      }

      await t.step("constraint expressions and arguments hold", async () => {
        for (const insert of ["name := 'd', tier := 'tin'", "name := 'd', n := 3", "name := 'd', n := 400", "name := 'too-long-name'"]) {
          await assertRejects(() => values(pool, schema, `insert XqItem { ${insert} }`), Error, undefined, insert);
        }
      });

      await t.step("a policy's condition reads its set literal", async () => {
        assertEquals(await values(pool, schema, "select XqItem.name order by XqItem.name"), ["a", "c"]);
      });

      await t.step("a global's default is its array", async () => {
        assertEquals(await values(pool, schema, "select global tiers"), [["gold", "silver"]]);
      });

      await t.step("an alias of a shape", async () => {
        assertEquals(await values(pool, schema, "select XqNamed { name } order by .name"), [{ name: "a" }, { name: "c" }]);
      });

      await t.step("an alias's computed reads as a property of its objects", async () => {
        assertEquals(await values(pool, schema, "select XqNamed { name, loud } order by .name"), [{ loud: "A", name: "a" }, { loud: "C", name: "c" }]);
        assertEquals(await values(pool, schema, "select XqNamed { name } filter .loud = 'C'"), [{ name: "c" }]);
      });

      await t.step("an alias of values is its values", async () => {
        assertEquals((await values(pool, schema, "select XqTiers")).sort(), ["gold", "none", "silver"]);
        assertEquals(await values(pool, schema, "select count(XqTiers)"), [3n]);
        assertEquals((await values(pool, schema, "select XqTiers filter XqTiers != 'none'")).sort(), ["gold", "silver"]);
      });
    } finally {
      await manager.close();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});
