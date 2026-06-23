/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the primary-key `id` default.
 *
 * Disc diverges from Gel here: every object type's `id` defaults to
 * `disc_uuidv7()` (time-ordered UUIDv7, RFC 9562) instead of random v4.
 * The pure-DDL test below pins the emitted default; the integration test
 * (gated on a real PostgreSQL) verifies the bootstrapped function actually
 * produces well-formed, time-ordered v7 UUIDs.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DDLGenerator } from "./ddl.ts";
import * as Types from "./types.ts";
import { bootstrapStdlib } from "../lib/stdlib-sql.ts";
import {
  canRunPgTests,
  getTestDsn,
  makePool,
  queryRows
} from "../tests/pg-test-harness.ts";

function createTypeOp(typeName: string): Types.CreateTypeOperation {
  return {
    kind: "CreateType",
    typeName,
    properties: [
      {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {}
      }
    ],
    links: []
  };
}

Deno.test("id default — generated CREATE TABLE uses disc_uuidv7()", () => {
  const statements = new DDLGenerator().generateDDL([createTypeOp("Widget")]);
  const createTable = statements.find(s => s.includes("CREATE TABLE"));
  if (!createTable)
    throw new Error("no CREATE TABLE emitted");

  assertStringIncludes(createTable, "id UUID PRIMARY KEY");
  assertStringIncludes(createTable, "DEFAULT disc_uuidv7()");
  // The old random v4 default must be gone.
  assertEquals(createTable.includes("gen_random_uuid()"), false);
});

Deno.test({
  name: "id default — disc_uuidv7() emits well-formed, time-ordered v7 UUIDs",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    try {
      await pool.initialize();
      // Bootstrap installs pgcrypto + disc_uuidv7() (idempotent).
      await bootstrapStdlib(pool);

      // Generate a batch in creation order.
      const rows = await queryRows<{ id: string; n: number; }>(
        dsn,
        `SELECT disc_uuidv7() AS id, g AS n
         FROM generate_series(1, 50) AS g`
      );
      assertEquals(rows.length, 50);

      for (const { id } of rows) {
        // Canonical UUID shape.
        assertEquals(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
            .test(id),
          true,
          `not a canonical uuid: ${id}`
        );
        // Version nibble (first hex of 3rd group) must be 7.
        assertEquals(id[14], "7", `version nibble != 7: ${id}`);
        // Variant: first hex of 4th group is one of 8/9/a/b (10xx).
        assertEquals(
          ["8", "9", "a", "b"].includes(id[19]),
          true,
          `bad variant nibble: ${id}`
        );
      }

      // Time-ordered: v7's guarantee is across milliseconds, not within one
      // (intra-ms the tail is random). The 48-bit timestamp prefix is the
      // first 12 hex chars; it must be non-decreasing in creation order —
      // that's what keeps primary-key index inserts sequential.
      const msPrefix = rows.map(r => r.id.replaceAll("-", "").slice(0, 12));
      const sorted = [...msPrefix].sort();
      assertEquals(
        msPrefix,
        sorted,
        "v7 millisecond prefix is not monotonic in creation order"
      );
    } finally {
      await pool.close();
    }
  }
});
