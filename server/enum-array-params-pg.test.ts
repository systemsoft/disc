/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, through the generated TypeScript client over HTTP: enum
 * arrays and same-named enums.
 *
 * - Inserting or updating a `multi` enum property sends
 *   `array_unpack(<array<Priority>>$tags)`, which reached PostgreSQL as
 *   `CAST($1 AS array<Priority>)` (a syntax error). Filtering with `in` sends
 *   the same cast.
 * - `default::Status` and `agents::Status` shared one PostgreSQL type, so the
 *   schema did not migrate; the generated client must also cast an `agents`
 *   property to `agents::Status`, not the default module's `Status`.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { emitTypeScript, schemaToIR } from "../codegen/mod.ts";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;

const SDL = `module default {
  scalar type EapPriority extending enum<Low, High>;
  scalar type EapStatus extending enum<Open, Closed>;
  type EapTask {
    required title: str;
    status: EapStatus;
    multi tags: EapPriority;
  };
};

module agents {
  scalar type EapStatus extending enum<Idle, Working>;
  type EapAgent {
    required name: str;
    status: EapStatus;
    multi states: EapStatus;
  };
};`;

const TYPES = ["disc_enum_eappriority", "disc_enum_eapstatus", "disc_enum_agents__eapstatus"];

interface Row {
  id: string;
  [key: string]: unknown;
}

interface Builder {
  filter(filter: Record<string, unknown>): Promise<Row[]>;
  insert(data: Record<string, unknown>): Promise<Row>;
  update(id: string, data: Record<string, unknown>): Promise<Row>;
}

interface GeneratedClient {
  eapagent: Builder;
  eaptask: Builder;
}

async function reset(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);

  for (const type of TYPES)
    await pool.query(`DROP TYPE IF EXISTS ${type} CASCADE`);
}

/** Generate the typed client into a temp directory and import it, with its SDK import pointed at this repo's `sdk/`. */
async function withGeneratedClient(schema: Schema, baseUrl: string, fn: (client: GeneratedClient) => Promise<void>): Promise<void> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-enum-array-client-" });

  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "enum-array-params-pg.test.ts",
      sdkImportBase: SDK_URL,
      target: "client"
    });

    for (const file of files)
      await Deno.writeTextFile(file.path, file.content);

    const generated = await import(new URL(`file://${outputDir}/client.ts`).href) as {
      DiscClient: new(config: { baseUrl: string; }) => GeneratedClient;
    };

    await fn(new generated.DiscClient({ baseUrl }));
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

Deno.test({
  name: "PG enum arrays via the generated client: multi enum insert/update, filter by enum array, same-named enums",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await reset(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );

    async function stored(sql: string, id: string): Promise<Record<string, unknown>> {
      return (await pool.query(sql, [id])).rows[0];
    }

    try {
      await withGeneratedClient(schema, `http://127.0.0.1:${listener.addr.port}`, async client => {
        let taskId = "";

        await t.step("insert a multi enum property", async () => {
          taskId = (await client.eaptask.insert({ status: "Open", tags: ["Low", "High"], title: "a" })).id;
          assertEquals(await stored("SELECT tags::text[] AS tags FROM eap_task WHERE id = $1", taskId), { tags: ["Low", "High"] });
        });

        await t.step("update a multi enum property", async () => {
          await client.eaptask.update(taskId, { tags: ["High"] });
          assertEquals(await stored("SELECT tags::text[] AS tags FROM eap_task WHERE id = $1", taskId), { tags: ["High"] });
        });

        await t.step("filter by an enum array parameter", async () => {
          await client.eaptask.insert({ status: "Closed", tags: [], title: "b" });

          assertEquals((await client.eaptask.filter({ status: { in: ["Open"] } })).map(r => r.title), ["a"]);
          assertEquals((await client.eaptask.filter({ tags: { in: ["High", "Low"] } })).map(r => r.title), ["a"]);
          assertEquals((await client.eaptask.filter({ status: { in: ["Open", "Closed"] } })).length, 2);
        });

        await t.step("same-named enum in another module: insert, update, filter", async () => {
          const agentId = (await client.eapagent.insert({ name: "ana", states: ["Idle", "Working"], status: "Working" })).id;
          assertEquals(
            await stored("SELECT status::text AS status, states::text[] AS states FROM eap_agent WHERE id = $1", agentId),
            { states: ["Idle", "Working"], status: "Working" }
          );

          await client.eapagent.update(agentId, { states: ["Idle"], status: "Idle" });
          assertEquals(
            await stored("SELECT status::text AS status, states::text[] AS states FROM eap_agent WHERE id = $1", agentId),
            { states: ["Idle"], status: "Idle" }
          );

          assertEquals((await client.eapagent.filter({ status: { in: ["Idle"] } })).map(r => r.name), ["ana"]);
        });
      });
    } finally {
      await listener.shutdown();
      await reset(pool);
      await pool.close();
    }
  }
});
