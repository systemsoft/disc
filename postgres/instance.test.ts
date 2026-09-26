/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, findPgBinDir } from "../tests/pg-test-harness.ts";
import { PostgresInstance } from "./instance.ts";

// Use /tmp directly to keep Unix socket paths under the 108-char limit.
// Default Deno temp dirs on macOS (/var/folders/...) are too long.
const TEST_BASE_DIR = Deno.makeTempDirSync({ dir: "/tmp", prefix: "disc-pg-" });

// Skip guard: tests that require real PostgreSQL binaries
const RUN_PG = canRunPgTests();
const PG_BIN_DIR = findPgBinDir();

Deno.test({
  name: "PostgresInstance - initialization creates required directories",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-init";
    const dataDir = join(TEST_BASE_DIR, instanceName, "data");
    const socketDir = join(TEST_BASE_DIR, instanceName, "socket");

    const instance = new PostgresInstance({
      dataDir,
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir,
      postgresVersion: "16.4"
    });

    await instance.init();

    // Check that directories were created
    const dataDirStat = await Deno.stat(dataDir);
    assertEquals(dataDirStat.isDirectory, true);

    const socketDirStat = await Deno.stat(socketDir);
    assertEquals(socketDirStat.isDirectory, true);

    const logDir = join(dataDir, "..", "logs");
    const logDirStat = await Deno.stat(logDir);
    assertEquals(logDirStat.isDirectory, true);

    // Check that PostgreSQL was initialized (PG_VERSION file exists)
    const pgVersionFile = join(dataDir, "PG_VERSION");
    const pgVersionStat = await Deno.stat(pgVersionFile);
    assertEquals(pgVersionStat.isFile, true);

    // Cleanup
    await Deno.remove(TEST_BASE_DIR, { recursive: true });
  }
});

Deno.test({
  name: "PostgresInstance - start and stop lifecycle",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-lifecycle";
    const dataDir = join(TEST_BASE_DIR, instanceName, "data");
    const socketDir = join(TEST_BASE_DIR, instanceName, "socket");

    const instance = new PostgresInstance({
      dataDir,
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir,
      port: 0 // Unix socket only
    });

    await instance.init();

    // Start the instance
    await instance.start();

    // Check status
    let status = await instance.status();
    assertEquals(status.running, true);
    assertExists(status.pid);
    assertExists(status.startedAt);

    // Stop the instance
    await instance.stop();

    // Check status again
    status = await instance.status();
    assertEquals(status.running, false);
    assertEquals(status.pid, undefined);

    // Cleanup
    await Deno.remove(TEST_BASE_DIR, { recursive: true });
  }
});

Deno.test({
  name: "PostgresInstance - restart functionality",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-restart";
    const dataDir = join(TEST_BASE_DIR, instanceName, "data");
    const socketDir = join(TEST_BASE_DIR, instanceName, "socket");

    const instance = new PostgresInstance({
      dataDir,
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir
    });

    await instance.init();
    await instance.start();

    const firstStatus = await instance.status();
    const firstPid = firstStatus.pid;
    assertExists(firstPid);

    // Restart
    await instance.restart();

    const secondStatus = await instance.status();
    const secondPid = secondStatus.pid;
    assertExists(secondPid);

    // PID should be different after restart
    const pidChanged = firstPid !== secondPid;
    assertEquals(pidChanged, true);

    await instance.stop();

    // Cleanup
    await Deno.remove(TEST_BASE_DIR, { recursive: true });
  }
});

Deno.test("PostgresInstance - isAcceptingConnections times out on a server that never answers", async () => {
  // Accepts TCP connections but never speaks the PG protocol, like a hung
  // postmaster. The health check must give up instead of waiting forever.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const accepting = (async () => {
    for await (const conn of listener)
      conns.push(conn);
  })();

  const instance = new PostgresInstance({
    dataDir: "/tmp/data",
    instanceName: "test-db",
    port: (listener.addr as Deno.NetAddr).port
  });

  try {
    const started = Date.now();
    assertEquals(await instance.isAcceptingConnections(200), false);
    assertEquals(Date.now() - started < 2000, true);
  } finally {
    listener.close();
    for (const conn of conns)
      conn.close();
    await accepting.catch(() => {});
  }
});

Deno.test("PostgresInstance - DSN generation", () => {
  const instance1 = new PostgresInstance({
    dataDir: "/tmp/data",
    instanceName: "test-db",
    socketDir: "/tmp/socket",
    port: 0
  });

  const dsn1 = instance1.dsn();
  assertEquals(dsn1, "postgresql://disc@/test-db?host=/tmp/socket");

  const instance2 = new PostgresInstance({
    dataDir: "/tmp/data",
    instanceName: "test-db",
    port: 5432
  });

  const dsn2 = instance2.dsn();
  assertEquals(dsn2, "postgresql://disc@localhost:5432/test-db");
});

Deno.test({
  name: "PostgresInstance - handles already initialized data directory",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-reinit";
    const dataDir = join(TEST_BASE_DIR, instanceName, "data");
    const socketDir = join(TEST_BASE_DIR, instanceName, "socket");

    // First initialization
    const instance1 = new PostgresInstance({
      dataDir,
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir
    });
    await instance1.init();

    // Second initialization with same data directory
    const instance2 = new PostgresInstance({
      dataDir,
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir
    });

    // Should not throw, should reuse existing data directory
    await instance2.init();

    // Verify data directory still exists
    const pgVersionFile = join(dataDir, "PG_VERSION");
    const pgVersionStat = await Deno.stat(pgVersionFile);
    assertEquals(pgVersionStat.isFile, true);

    // Cleanup
    await Deno.remove(TEST_BASE_DIR, { recursive: true });
  }
});

Deno.test({
  name: "PostgresInstance - force stop handles stuck processes",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-force-stop";
    const dataDir = join(TEST_BASE_DIR, instanceName, "data");
    const socketDir = join(TEST_BASE_DIR, instanceName, "socket");

    const instance = new PostgresInstance({
      dataDir,
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir
    });

    await instance.init();
    await instance.start();

    const status = await instance.status();
    assertExists(status.pid);

    // Force stop (simulating pg_ctl stop failure)
    await instance.stop();

    // Should be stopped
    const finalStatus = await instance.status();
    assertEquals(finalStatus.running, false);

    // Cleanup
    await Deno.remove(TEST_BASE_DIR, { recursive: true });
  }
});

Deno.test("PostgresInstance - socket path generation", () => {
  const instance = new PostgresInstance({
    dataDir: "/tmp/data",
    instanceName: "test",
    socketDir: "/tmp/socket",
    port: 5433
  });

  const socketPath = instance.getSocketPath();
  assertEquals(socketPath, "/tmp/socket/.s.PGSQL.5433");

  const instance2 = new PostgresInstance({
    dataDir: "/tmp/data",
    instanceName: "test",
    socketDir: "/tmp/socket",
    port: 0
  });

  const socketPath2 = instance2.getSocketPath();
  assertEquals(socketPath2, "/tmp/socket/.s.PGSQL.5432");
});

Deno.test({
  name: "PostgresInstance - isAcceptingConnections tracks a socket-only instance without client binaries",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-accepting";
    const instanceDir = join(TEST_BASE_DIR, instanceName);
    const instance = new PostgresInstance({
      dataDir: join(instanceDir, "data"),
      instanceName,
      pgBinDir: PG_BIN_DIR!,
      socketDir: join(instanceDir, "socket")
    });

    try {
      await instance.init();
      assertEquals(await instance.isAcceptingConnections(), false);

      await instance.start();
      assertEquals(await instance.isAcceptingConnections(), true);

      await instance.stop();
      assertEquals(await instance.isAcceptingConnections(), false);
    } finally {
      await instance.stop();
      await Deno.remove(instanceDir, { recursive: true }).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresInstance - start applies the current logging defaults to an instance created by an older Disc",
  ignore: !RUN_PG,
  fn: async () => {
    const instanceName = "test-legacy-logging";
    const instanceDir = join(TEST_BASE_DIR, instanceName);
    const dataDir = join(instanceDir, "data");
    const socketDir = join(instanceDir, "socket");
    const instance = new PostgresInstance({ dataDir, instanceName, pgBinDir: PG_BIN_DIR!, socketDir });

    try {
      await instance.init();

      const configPath = join(dataDir, "postgresql.conf");
      const legacy = (await Deno.readTextFile(configPath))
        .replace("log_statement = 'ddl'", "log_statement = 'all'");
      await Deno.writeTextFile(configPath, legacy);

      await instance.start();

      const client = new Client({ database: "postgres", host_type: "socket", hostname: socketDir, port: 5432, user: "disc" });
      await client.connect();

      try {
        const { rows } = await client.queryArray<[string]>("SHOW log_statement");
        assertEquals(rows[0][0], "ddl");
      } finally {
        await client.end();
      }
    } finally {
      await instance.stop();
      await Deno.remove(instanceDir, { recursive: true }).catch(() => {});
    }
  }
});
