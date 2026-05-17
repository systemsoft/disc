/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG-backed roundtrip for the schema-derived REST surface (Bundle J).
 *
 * Verifies that the EdgeQL strings the router synthesizes actually
 * compile and execute against a real PostgreSQL instance — the most
 * meaningful integration test for this feature, since the router
 * doesn't escape the standard pipeline at any point.
 *
 * Skipped when PG harness env vars are absent.
 */

import { assert, assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import type { Schema, TypeDef } from "../../compiler/context.ts";
import { ConnectionPool } from "../../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn } from "../../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "../edgeql-protocol.ts";
import { HttpServer } from "../http.ts";

const RUN_PG = canRunPgTests();
const TEST_HOST = "127.0.0.1";
const SUFFIX = `bundlej_${Date.now()}`;
const USERS_TABLE = `${SUFFIX}_users`;
const POSTS_TABLE = `${SUFFIX}_posts`;

function parseDsn(dsn: string) {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test"
  };
}

async function setupTables(dsn: string): Promise<void> {
  const client = new Client(parseDsn(dsn));
  await client.connect();
  try {
    await client.queryArray(`
      CREATE TABLE ${USERS_TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE
      )
    `);
    await client.queryArray(`
      CREATE TABLE ${POSTS_TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        author_id UUID NOT NULL REFERENCES ${USERS_TABLE}(id) ON DELETE CASCADE
      )
    `);
  } finally {
    await client.end();
  }
}

async function teardownTables(dsn: string): Promise<void> {
  const client = new Client(parseDsn(dsn));
  await client.connect();
  try {
    await client.queryArray(`DROP TABLE IF EXISTS ${POSTS_TABLE} CASCADE`);
    await client.queryArray(`DROP TABLE IF EXISTS ${USERS_TABLE} CASCADE`);
  } finally {
    await client.end();
  }
}

function buildSchema(): Schema {
  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: USERS_TABLE,
    module: "default",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  const postType: TypeDef = {
    name: "Post",
    kind: "object",
    tableName: POSTS_TABLE,
    module: "default",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str"
      }]
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        columnName: "author_id"
      }]
    ])
  };

  return {
    types: new Map([
      ["default::User", userType],
      ["default::Post", postType]
    ]),
    functions: new Map()
  };
}

Deno.test({
  name: "REST PG: GET → POST → GET → DELETE roundtrip exercises real EdgeQL pipeline",
  ignore: !RUN_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTables(dsn);
    const schema = buildSchema();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 4
    });
    const handler = new EdgeQLProtocolHandler({
      schema,
      connectionPool: pool
    });
    const port = 35000 + Math.floor(Math.random() * 5000);
    const server = new HttpServer({
      config: {
        host: TEST_HOST,
        port,
        databaseUrl: dsn,
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: false,
        enableWebsockets: false
      },
      protocolHandler: handler,
      schemaProvider: () => schema
    });
    const _running = server.start();
    await new Promise(r => setTimeout(r, 200));

    try {
      const baseUrl = `http://${TEST_HOST}:${port}`;

      // 1. Initial GET — empty table
      let res = await fetch(`${baseUrl}/api/User`);
      assertEquals(res.status, 200);
      const initial = await res.json();
      assertEquals(initial.length, 0);

      // 2. POST insert
      res = await fetch(`${baseUrl}/api/User`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ada Lovelace",
          email: "ada@example.com"
        })
      });
      assertEquals(res.status, 201);
      const inserted = await res.json();
      assertEquals(inserted.name, "Ada Lovelace");
      // `id` is server-assigned; the default GET shape includes it.
      assert(typeof inserted.id === "string" && inserted.id.length > 0);

      // 3. GET single
      res = await fetch(`${baseUrl}/api/User/${inserted.id}`);
      assertEquals(res.status, 200);
      const fetched = await res.json();
      assertEquals(fetched.name, "Ada Lovelace");
      assertEquals(fetched.email, "ada@example.com");

      // 4. GET list — has one row now
      res = await fetch(`${baseUrl}/api/User`);
      assertEquals(res.status, 200);
      const list = await res.json();
      assertEquals(list.length, 1);

      // 5. DELETE — idempotent
      res = await fetch(`${baseUrl}/api/User/${inserted.id}`, {
        method: "DELETE"
      });
      assertEquals(res.status, 204);

      // 6. GET single — 404 after delete
      res = await fetch(`${baseUrl}/api/User/${inserted.id}`);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    } finally {
      await server.stop();
      await _running.catch(() => undefined);
      await pool.close();
      await teardownTables(dsn);
    }
  }
});
