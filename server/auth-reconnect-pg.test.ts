/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Regression test: Disc Auth must survive its PostgreSQL connections dying.
 *
 * The bug: initializeAuth() opened one DatabaseConnection and held it for the
 * life of the server. When PostgreSQL restarted (or the backend was otherwise
 * terminated) that client never reconnected, so every `/auth/*` request
 * returned 500 "Broken pipe (os error 32)" until `disc serve` was restarted.
 *
 * The test terminates every backend the server opened (the same thing a
 * PostgreSQL restart does to them) and checks the next auth request is still
 * answered from the database.
 *
 * Requires a real PostgreSQL (see pg-test-harness); skipped otherwise.
 */

import { assertEquals } from "@std/assert";
import { canRunPgTests, getTestDsn, queryRows } from "../tests/pg-test-harness.ts";
import { DiscServer } from "./server.ts";

const BACKEND_PIDS = "select pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()";

function randomPort(): number {
  return 43000 + Math.floor(Math.random() * 2000);
}

async function login(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  await response.body?.cancel();
  return response.status;
}

async function waitForServer(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await login(port);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  throw new Error(`server on port ${port} did not start within ${timeoutMs}ms`);
}

Deno.test({
  name: "DiscServer auth answers from the database after its PostgreSQL backends are terminated",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const port = randomPort();

    /*** Backends that exist before the server starts belong to other code — leave them alone. ***/
    const before = new Set((await queryRows<{ pid: number; }>(dsn, BACKEND_PIDS)).map(row => row.pid));

    const server = new DiscServer({
      databaseUrl: dsn,
      enableCors: false,
      enableDataWatch: false,
      enableWebsockets: false,
      host: "127.0.0.1",
      jwtSecret: "auth-reconnect-test-secret-0123456789abcdef",
      port,
      protocol: "full"
    });

    void server.start();

    try {
      await waitForServer(port);
      assertEquals(await login(port), 401);

      const serverPids = (await queryRows<{ pid: number; }>(dsn, BACKEND_PIDS))
        .map(row => row.pid)
        .filter(pid => !before.has(pid));

      for (const pid of serverPids)
        await queryRows(dsn, "select pg_terminate_backend($1)", [pid]);

      assertEquals(await login(port), 401);
    } finally {
      await server.stop();
    }
  }
});
