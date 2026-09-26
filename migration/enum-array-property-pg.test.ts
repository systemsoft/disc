/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Non-`multi` `array<Enum>` properties, against PostgreSQL.
 *
 * `tags: array<Priority>;` got a TEXT column: writes stored the array's text
 * form (`{Low,High}`), reads returned that string, and comparing the column
 * with an enum array failed. New columns are the enum's array type. A column
 * created as TEXT before is converted by the next migrate — array literals
 * and JSON arrays keep their values, anything else fails the migration — and
 * the migrate after that is a no-op.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

const SDL = `module default {
  scalar type EaStatus extending enum<Open, Closed>;
  scalar type EaPriority extending enum<Low, High, \`In Progress\`>;
  type EaTask {
    required title: str;
    tags: array<EaPriority>;
  };
};

module agents {
  scalar type EaStatus extending enum<Idle, Working>;
  type EaAgent {
    required name: str;
    history: array<EaStatus>;
  };
};`;

const TYPES = ["disc_enum_eastatus", "disc_enum_eapriority", "disc_enum_agents__eastatus"];

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);

  for (const type of TYPES)
    await pool.query(`DROP TYPE IF EXISTS ${type} CASCADE`);
}

async function migrate(pool: ConnectionPool): Promise<Types.MigrationResult[]> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(SDL);

    if (!result.ok)
      throw result.error;

    return result.value;
  } finally {
    await manager.close();
  }
}

async function columnType(pool: ConnectionPool, table: string, column: string): Promise<string> {
  const result = await pool.query(
    `SELECT udt_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return result.rows[0].udt_name as string;
}

/** Recreate the column as TEXT, as Disc created it before it mapped `array<Enum>`. */
async function makeLegacyTextColumn(pool: ConnectionPool, table: string, column: string): Promise<void> {
  await pool.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `enum_array_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

Deno.test({
  name: "PG array<Enum> property: enum array column; insert, update, select and filter through the compiler",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool);
      assertEquals(await columnType(pool, "ea_task", "tags"), "_disc_enum_eapriority");
      assertEquals(await columnType(pool, "ea_agent", "history"), "_disc_enum_agents__eastatus");

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      await manager.applySchema(SDL);
      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
      await manager.close();

      const run = async (query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
        const response = await handler.handleRequest({ query, variables }, makeContext());
        assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
        return response.data as Record<string, unknown>[];
      };

      await run(`insert EaTask { title := "a", tags := <array<EaPriority>>$tags }`, { tags: ["Low", "In Progress"] });
      await run(`insert EaTask { title := "b", tags := [EaPriority.High] }`);
      await run(`insert EaTask { title := "c" }`);
      await run(`insert agents::EaAgent { name := "ana", history := <array<agents::EaStatus>>$h }`, { h: ["Idle", "Working"] });

      assertEquals(await run(`select EaTask { title, tags } order by .title`), [
        { tags: ["Low", "In Progress"], title: "a" },
        { tags: ["High"], title: "b" },
        { tags: null, title: "c" }
      ]);
      assertEquals(await run(`select agents::EaAgent { name, history }`), [{ history: ["Idle", "Working"], name: "ana" }]);

      await run(`update EaTask filter .title = "b" set { tags := <array<EaPriority>>$tags }`, { tags: ["High", "Low"] });

      const byTags = await run(`select EaTask { title } filter .tags = <array<EaPriority>>$tags`, { tags: ["High", "Low"] });
      assertEquals(byTags, [{ title: "b" }]);

      const withLow = await run(`select EaTask { title } filter EaPriority.Low in array_unpack(.tags) order by .title`);
      assertEquals(withLow.map(row => row.title), ["a", "b"]);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG array<Enum> property: migrate converts a legacy TEXT column, keeping its values; the next migrate is a no-op",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool);
      await makeLegacyTextColumn(pool, "ea_task", "tags");
      await makeLegacyTextColumn(pool, "ea_agent", "history");

      // What an assignment cast to text stored: array literals (quoted when an
      // element needs it), the empty array, a JSON array from a `<json>` value.
      await pool.query(`INSERT INTO ea_task (title, tags) VALUES
        ('literal', '{Low,"In Progress"}'),
        ('empty', '{}'),
        ('json', '["High", "Low"]'),
        ('unset', NULL)`);
      await pool.query(`INSERT INTO ea_agent (name, history) VALUES ('ana', '{Idle,Working}')`);

      const applied = await migrate(pool);
      assertEquals(applied.length, 1);
      assertEquals(await columnType(pool, "ea_task", "tags"), "_disc_enum_eapriority");
      assertEquals(await columnType(pool, "ea_agent", "history"), "_disc_enum_agents__eastatus");

      const tasks = await pool.query(`SELECT title, tags::text[] AS tags FROM ea_task ORDER BY title`);
      assertEquals(tasks.rows, [
        { tags: [], title: "empty" },
        { tags: ["High", "Low"], title: "json" },
        { tags: ["Low", "In Progress"], title: "literal" },
        { tags: null, title: "unset" }
      ]);
      const agents = await pool.query(`SELECT history::text[] AS history FROM ea_agent`);
      assertEquals(agents.rows, [{ history: ["Idle", "Working"] }]);

      assertEquals(await migrate(pool), []);
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG array<Enum> property: a legacy TEXT value that is not an array of the enum's values fails the migration",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await reset(pool);
      await migrate(pool);
      await makeLegacyTextColumn(pool, "ea_task", "tags");
      await pool.query(`INSERT INTO ea_task (title, tags) VALUES ('ok', '{Low}'), ('bad', '{Low,Urgent}')`);

      let error: Error | undefined;
      try {
        await migrate(pool);
      } catch (caught) {
        error = caught as Error;
      }

      assert(error, "expected the migration to fail");
      assertStringIncludes(error.message, "Cannot convert ea_task.tags from text to array<EaPriority>");
      assertStringIncludes(error.message, "'{Low,Urgent}'");

      // Nothing changed: the column is still TEXT and both rows are intact.
      assertEquals(await columnType(pool, "ea_task", "tags"), "text");
      const rows = await pool.query(`SELECT title, tags FROM ea_task ORDER BY title`);
      assertEquals(rows.rows, [{ tags: "{Low,Urgent}", title: "bad" }, { tags: "{Low}", title: "ok" }]);

      // Not an array at all fails the same way.
      await pool.query(`UPDATE ea_task SET tags = 'Low' WHERE title = 'bad'`);
      let notArray: Error | undefined;
      try {
        await migrate(pool);
      } catch (caught) {
        notArray = caught as Error;
      }
      assert(notArray, "expected the migration to fail");
      assertStringIncludes(notArray.message, "stored value 'Low' is not an array");
    } finally {
      await reset(pool);
      await pool.close();
    }
  }
});
