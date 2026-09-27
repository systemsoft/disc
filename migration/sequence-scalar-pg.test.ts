/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `std::` type names and sequence scalars, against PostgreSQL.
 *
 * A schema spelled with `std::` names migrates like the bare spelling. A
 * sequence scalar's properties are assigned increasing values when an insert
 * leaves them out, from one counter per scalar shared by every property of
 * that type; an explicit value is kept. Casts to `std::` names, to the array
 * and range types that were missing from the cast map and to user scalars
 * round-trip values.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { unwrapExactNumbers } from "../lib/exact-json.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

const SDL = `module default {
  scalar type SqCount extending std::int64;
  scalar type SqTicketNo extending sequence;
  type SqTicket {
    required title: std::str;
    number: SqTicketNo {
      constraint exclusive;
    };
    tags: array<std::str>;
    count: SqCount;
  };
  type SqRefund {
    required number: SqTicketNo;
    required reason: str;
  };
};`;

const WITHOUT_SEQUENCE = `module default {
  scalar type SqCount extending std::int64;
  type SqTicket {
    required title: std::str;
    tags: array<std::str>;
    count: SqCount;
  };
};`;

async function migrate(pool: ConnectionPool, sdl: string): Promise<Types.MigrationResult[]> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl, { allowUnsafe: true });

    if (!result.ok)
      throw result.error;

    return result.value;
  } finally {
    await manager.close();
  }
}

async function sequenceExists(pool: ConnectionPool): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'disc_seq_sqticketno'`);
  return result.rows.length > 0;
}

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `sequence_scalar_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

type Run = (query: string, variables?: Record<string, unknown>) => Promise<unknown[]>;

async function handlerFor(pool: ConnectionPool, dsn: string): Promise<Run> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  await manager.applySchema(SDL);
  const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
  await manager.close();

  return async (query, variables) => {
    const response = await handler.handleRequest({ query, variables }, makeContext());
    assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
    return response.data as unknown[];
  };
}

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);
  await pool.query(`DROP SEQUENCE IF EXISTS disc_seq_sqticketno`);
}

Deno.test({
  name: "PG sequence scalar: inserts without the property get increasing values from one counter per scalar",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, SDL);
      assertEquals(await sequenceExists(pool), true);

      const run = await handlerFor(pool, dsn);
      await run(`insert SqTicket { title := "a" }`);
      await run(`insert SqTicket { title := "b", tags := ["x"], count := <SqCount>$count }`, { count: 7 });
      await run(`insert SqRefund { reason := "c" }`);
      await run(`insert SqTicket { title := "d" }`);
      await run(`insert SqTicket { title := "e", number := 100 }`);

      const tickets = await run(`select SqTicket { title, number, count } order by .title`);
      assertEquals(tickets.map(row => row as Record<string, unknown>).map(row => [row.title, Number(row.number)]), [
        ["a", 1],
        ["b", 2],
        ["d", 4],
        ["e", 100]
      ]);
      const refunds = await run(`select SqRefund { number }`);
      assertEquals(refunds.map(row => Number((row as Record<string, unknown>).number)), [3]);

      assertEquals(await migrate(pool, SDL), []);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG sequence scalar: removing the scalar and its properties drops the sequence",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, SDL);
      await pool.query(`INSERT INTO sq_ticket (title) VALUES ('a')`);
      await migrate(pool, WITHOUT_SEQUENCE);
      assertEquals(await sequenceExists(pool), false);

      const rows = await pool.query(`SELECT title FROM sq_ticket`);
      assertEquals(rows.rows, [{ title: "a" }]);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG casts: std:: names, arrays of durations, float32 ranges and user scalars round-trip",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool, SDL);
      const run = await handlerFor(pool, dsn);
      // A scalar select returns one row with one column; numeric values arrive as exact JSON numbers.
      const one = async (query: string, variables: Record<string, unknown>): Promise<unknown> =>
        unwrapExactNumbers(Object.values((await run(query, variables))[0] as Record<string, unknown>)[0]);

      assertEquals(Number(await one(`select <std::int64>$x + 1`, { x: 41 })), 42);
      assertEquals(await one(`select <std::str>$x ++ "!"`, { x: "hi" }), "hi!");
      assertEquals(await one(`select <array<std::str>>$x`, { x: ["a", "b"] }), ["a", "b"]);
      assertEquals(Number(await one(`select <SqCount>$x * 2`, { x: 21 })), 42);
      assertEquals(Number(await one(`select <SqTicketNo>$x`, { x: 5 })), 5);
      assertEquals(await one(`select <array<duration>>$x = <array<duration>>$y`, { x: ["1 hour", "2 hours"], y: ["60 minutes", "02:00:00"] }), true);
      assertEquals(await one(`select <array<cal::relative_duration>>$x = <array<cal::relative_duration>>$y`, { x: ["1 month"], y: ["1 mon"] }), true);
      assertEquals(
        await one(`select <array<cal::date_duration>>$x = <array<cal::date_duration>>$y`, { x: ["1 day", "2 days"], y: ["24 hours", "48 hours"] }),
        true
      );
      assertEquals(Number(await one(`select range_get_upper(<range<float32>>$x)`, { x: "[1,2.5)" })), 2.5);
      assertEquals(await one(`select <range<float32>>$x = <range<float32>>$y`, { x: "[1,2)", y: "[1.0,2.0)" }), true);
      assertEquals(await one(`select <multirange<float32>>$x = <multirange<float32>>$y`, { x: "{[1,2), [2.5,3)}", y: "{[2.5,3.0), [1.0,2.0)}" }), true);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});
