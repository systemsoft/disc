/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a global of a user scalar has the scalar's base type, and a
 * global of an enum the enum's type, in `set global`, `select global x`,
 * filters and access policies.
 *
 * A global of `scalar type Count extending int64` was read back as text, so
 * `.n > global limit` compared a bigint with text, and `global limit > 9`
 * compared as text ('10' < '9'). A bare scalar name is resolved in the
 * global's own module first, as a property's is.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
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
  scalar type Count extending int64;
  scalar type SgLevel extending enum<Low, Mid, High>;
  global limit: Count;
  global level: SgLevel;
  required global cap: Count {
    default := 1000;
  };
  type SgItem {
    required name: str;
    required n: int64;
    level: SgLevel;
    access policy capped
      allow all
      using (.n <= global cap);
  }
}
module other {
  scalar type Count extending str;
  global label: Count;
  global big: default::Count;
}`;

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);
  await pool.query("DROP TYPE IF EXISTS disc_enum_sglevel CASCADE");
}

async function withSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await reset(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query("INSERT INTO sg_item (name, n, level) VALUES ('nine', 9, 'Low'), ('ten', 10, 'Mid'), ('hundred', 100, 'High')");
    await run(pool, schema);
    await manager.close();
  } finally {
    await reset(pool);
    await pool.close();
  }
}

function compile(edgeql: string, schema: Schema): string {
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
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

/*** Run `edgeql` statements in one transaction (so `set global` holds); the single column of the last one's rows, sorted. ***/
async function run(pool: ConnectionPool, schema: Schema, ...edgeql: string[]): Promise<unknown[]> {
  const rows = await pool.transaction(async connection => {
    let last: Record<string, unknown>[] = [];
    for (const statement of edgeql) {
      last = (await connection.query(compile(statement, schema))).rows as Record<string, unknown>[];
    }
    return last;
  });
  return rows
    .map(row => {
      const value = Object.values(row)[0];
      return typeof value === "bigint" ? Number(value) : value;
    })
    .sort();
}

Deno.test({
  name: "PG scalar globals: a global of a user scalar compares as its base type",
  ignore: !canRunPgTests(),
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(schema.globals?.get("default::limit")?.pgType, "bigint");
      assertEquals(await run(pool, schema, "set global limit := 10", "select global limit"), [10]);
      // As text, '10' > '9' is false.
      assertEquals(await run(pool, schema, "set global limit := 10", "select global limit > 9"), [true]);
      assertEquals(await run(pool, schema, "set global limit := 10", "select SgItem.name filter .n > global limit"), ["hundred"]);
      assertEquals(await run(pool, schema, "set global limit := 9", "select SgItem.name filter .n > global limit"), ["hundred", "ten"]);
    })
});

Deno.test({
  name: "PG scalar globals: a policy reads a user scalar global, and its default, numerically",
  ignore: !canRunPgTests(),
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select SgItem.name"), ["hundred", "nine", "ten"]);
      assertEquals(await run(pool, schema, "set global cap := 10", "select SgItem.name"), ["nine", "ten"]);
      assertEquals(await run(pool, schema, "set global cap := 9", "select SgItem.name"), ["nine"]);
    })
});

Deno.test({
  name: "PG scalar globals: a global of an enum has the enum's type and order",
  ignore: !canRunPgTests(),
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "set global level := SgLevel.Mid", "select global level"), ["Mid"]);
      assertEquals(await run(pool, schema, "set global level := SgLevel.Mid", "select SgItem.name filter .level = global level"), ["ten"]);
      // Declaration order (Low < Mid < High), not alphabetical.
      assertEquals(await run(pool, schema, "set global level := SgLevel.Mid", "select SgItem.name filter .level >= global level"), ["hundred", "ten"]);
    })
});

Deno.test({
  name: "PG scalar globals: a bare scalar name is the global's own module's scalar",
  ignore: !canRunPgTests(),
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(schema.globals?.get("other::label")?.pgType, "text");
      assertEquals(schema.globals?.get("other::big")?.pgType, "bigint");
      assertEquals(await run(pool, schema, "set global other::label := ''", "select global other::label"), [""]);
      assertEquals(await run(pool, schema, "set global other::big := 10", "select global other::big > 9"), [true]);
    })
});
