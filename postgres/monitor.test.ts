/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgresMonitor restart-trigger logic.
 *
 * The bug: the health check shelled out to `pg_isready`, which the bundled
 * (Zonky) PostgreSQL does not ship — `bin/` holds only `initdb`, `pg_ctl`
 * and `postgres`. Every check after the startup-grace one failed to spawn,
 * so `disc serve` restarted a perfectly healthy PostgreSQL three times,
 * 30 s apart, breaking every long-lived connection each time.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { canRunPgTests, findPgBinDir } from "../tests/pg-test-harness.ts";
import { PostgresInstance } from "./instance.ts";
import { PostgresMonitor } from "./monitor.ts";

class FakeInstance {
  accepting = true;
  restarts = 0;

  constructor(private readonly pgBinDir: string) {}

  getPgBinDir(): string {
    return this.pgBinDir;
  }

  getPort(): number {
    return 0;
  }

  getSocketDir(): string {
    return this.pgBinDir;
  }

  isAcceptingConnections(): Promise<boolean> {
    return Promise.resolve(this.accepting);
  }

  restart(): Promise<void> {
    this.restarts++;
    return Promise.resolve();
  }

  status(): Promise<{ running: boolean; }> {
    return Promise.resolve({ running: true });
  }
}

async function withEmptyBinDir(fn: (binDir: string) => Promise<void>): Promise<void> {
  /*** Mirrors the bundled layout's relevant property: no `pg_isready` in bin/. ***/
  const binDir = await Deno.makeTempDir({ prefix: "disc-monitor-bin-" });

  try {
    await fn(binDir);
  } finally {
    await Deno.remove(binDir, { recursive: true });
  }
}

function makeMonitor(instance: FakeInstance): PostgresMonitor {
  return new PostgresMonitor(instance as unknown as PostgresInstance, {
    restartDelayMs: 0,
    startupGraceMs: 0
  });
}

Deno.test("PostgresMonitor - healthy instance without pg_isready binary is never restarted", async () => {
  await withEmptyBinDir(async binDir => {
    const instance = new FakeInstance(binDir);
    const monitor = makeMonitor(instance);

    for (let check = 0; check < 4; check++)
      await monitor.checkHealth();

    assertEquals(instance.restarts, 0);
  });
});

Deno.test("PostgresMonitor - healthy instance reports healthy on the first check", async () => {
  await withEmptyBinDir(async binDir => {
    const instance = new FakeInstance(binDir);
    const status = await makeMonitor(instance).checkHealth();

    assertEquals(status.healthy, true);
  });
});

Deno.test("PostgresMonitor - running instance that stops accepting connections is restarted after the grace check", async () => {
  await withEmptyBinDir(async binDir => {
    const instance = new FakeInstance(binDir);
    instance.accepting = false;
    const monitor = makeMonitor(instance);

    await monitor.checkHealth(); // startup grace — not counted
    assertEquals(instance.restarts, 0);

    await monitor.checkHealth();
    assertEquals(instance.restarts, 1);
  });
});

Deno.test({
  name: "PG: PostgresMonitor metrics and maintenance run on an instance with only the bundled binaries",
  ignore: !canRunPgTests() || !findPgBinDir(),
  fn: async () => {
    /*** The bundled layout: initdb, pg_ctl and postgres only — no psql. ***/
    const baseDir = await Deno.makeTempDir({ dir: "/tmp", prefix: "disc-mon-" });
    const binDir = join(baseDir, "bin");
    await Deno.mkdir(binDir);
    for (const tool of ["initdb", "pg_ctl", "postgres"])
      await Deno.symlink(join(findPgBinDir()!, tool), join(binDir, tool));

    const instance = new PostgresInstance({
      dataDir: join(baseDir, "data"),
      instanceName: "monitor-probe",
      pgBinDir: binDir,
      socketDir: join(baseDir, "socket")
    });

    try {
      await instance.init();
      await instance.start();

      const monitor = new PostgresMonitor(instance);
      const metrics = await monitor.getMetrics() as { connections: { total: number; }; database: { name: string; size: string; }; };

      assertEquals(metrics.database.name, "monitor-probe");
      assert(metrics.database.size.length > 0);
      assert(metrics.connections.total >= 1);

      await monitor.performMaintenance();
    } finally {
      await instance.stop();
      await Deno.remove(baseDir, { recursive: true }).catch(() => {});
    }
  }
});
