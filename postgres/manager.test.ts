/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { canRunPgTests, cleanUpOnExit, findPgBinDir } from "../tests/pg-test-harness.ts";
import { parsePostgresVersion, readInstanceVersionFile } from "./instance-version.ts";
import { defaultInstancesDir, PostgresManager } from "./manager.ts";

// Use /tmp directly to keep Unix socket paths under the 108-char limit.
const TEST_BASE_DIR = Deno.makeTempDirSync({
  dir: "/tmp",
  prefix: "disc-mgr-"
});
// Each test stops the servers it starts; this stops any a killed or crashed
// run leaves behind, and removes the directory.
await cleanUpOnExit(TEST_BASE_DIR);

// Skip guard: tests that require real PostgreSQL binaries
const RUN_PG = canRunPgTests();
const PG_BIN_DIR = findPgBinDir();

// Default-baseDir resolution needs no PostgreSQL binaries — it is pure path math.
Deno.test("defaultInstancesDir - honors DISC_HOME when set", () => {
  const prevDiscHome = Deno.env.get("DISC_HOME");
  try {
    Deno.env.set("DISC_HOME", "/srv/disc-data");
    assertEquals(defaultInstancesDir(), join("/srv/disc-data", "instances"));
  } finally {
    if (prevDiscHome === undefined) {
      Deno.env.delete("DISC_HOME");
    } else {
      Deno.env.set("DISC_HOME", prevDiscHome);
    }
  }
});

Deno.test("defaultInstancesDir - falls back to HOME/.disc when DISC_HOME unset", () => {
  const prevDiscHome = Deno.env.get("DISC_HOME");
  const prevHome = Deno.env.get("HOME");
  try {
    Deno.env.delete("DISC_HOME");
    Deno.env.set("HOME", "/home/tester");
    assertEquals(
      defaultInstancesDir(),
      join("/home/tester", ".disc", "instances")
    );
  } finally {
    if (prevDiscHome !== undefined) {
      Deno.env.set("DISC_HOME", prevDiscHome);
    }
    if (prevHome !== undefined) {
      Deno.env.set("HOME", prevHome);
    } else {
      Deno.env.delete("HOME");
    }
  }
});

Deno.test({
  name: "PostgresManager - create instance",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-create";

    try {
      const instance = await manager.createInstance(instanceName, {
        pgBinDir: PG_BIN_DIR!,
        port: 0, // Unix socket only
        postgresVersion: "16.4"
      });

      assertExists(instance);
      assertEquals(instance.getPort(), 0);

      // Verify instance is tracked
      const tracked = manager.getInstance(instanceName);
      assertEquals(tracked, instance);
    } finally {
      await manager.destroyInstance(instanceName, true).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresManager - prevent duplicate instances",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-duplicate";

    try {
      await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });

      // Attempt to create duplicate should throw
      await assertRejects(
        async () => await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! }),
        Error,
        "already exists"
      );
    } finally {
      await manager.destroyInstance(instanceName, true).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresManager - start and stop instance",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-lifecycle";

    try {
      await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });

      // Start instance
      await manager.startInstance(instanceName, false); // No monitor for testing

      const status = await manager.getInstanceStatus(instanceName);
      assertExists(status);
      assertEquals(status.running, true);

      // Stop instance
      await manager.stopInstance(instanceName);

      const stoppedStatus = await manager.getInstanceStatus(instanceName);
      assertExists(stoppedStatus);
      assertEquals(stoppedStatus.running, false);
    } finally {
      await manager.destroyInstance(instanceName, true).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresManager - list instances",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);

    try {
      // Create multiple instances
      await manager.createInstance("instance1", { pgBinDir: PG_BIN_DIR! });
      await manager.createInstance("instance2", { pgBinDir: PG_BIN_DIR! });
      await manager.createInstance("instance3", { pgBinDir: PG_BIN_DIR! });

      const instances = manager.listInstances();
      assertEquals(instances.length, 3);
      assertEquals(instances.includes("instance1"), true);
      assertEquals(instances.includes("instance2"), true);
      assertEquals(instances.includes("instance3"), true);
    } finally {
      for (const name of ["instance1", "instance2", "instance3"])
        await manager.destroyInstance(name, true).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresManager - destroy instance with data removal",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-destroy";

    await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });

    const instanceDir = join(TEST_BASE_DIR, instanceName);
    const dataDirExists = async () => {
      try {
        await Deno.stat(instanceDir);
        return true;
      } catch {
        return false;
      }
    };

    // Verify directory exists
    assertEquals(await dataDirExists(), true);

    // Destroy with data removal
    await manager.destroyInstance(instanceName, true);

    // Verify directory is gone
    assertEquals(await dataDirExists(), false);

    // Instance should not be tracked
    assertEquals(manager.getInstance(instanceName), undefined);
  }
});

Deno.test({
  name: "PostgresManager - recover existing instance",
  ignore: !RUN_PG,
  fn: async () => {
    const manager1 = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-recover";

    try {
      // Create instance with first manager
      await manager1.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });
      await manager1.startInstance(instanceName, false);

      // Create new manager and recover
      const manager2 = new PostgresManager(TEST_BASE_DIR);
      await manager2.discoverInstances();

      const recovered = manager2.getInstance(instanceName);
      assertExists(recovered);

      // Should be able to manage recovered instance
      const status = await manager2.getInstanceStatus(instanceName);
      assertExists(status);
    } finally {
      await manager1.destroyInstance(instanceName, true).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresManager - instance with monitor",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-monitor";

    try {
      await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });
      await manager.startInstance(instanceName, true); // With monitor

      const status = await manager.getInstanceStatus(instanceName);
      assertExists(status);
      assertEquals(status.running, true);

      // Health status should be available when monitor is running
      // Note: Initial health check might not be complete immediately
      await new Promise(resolve => setTimeout(resolve, 1000));

      const statusWithHealth = await manager.getInstanceStatus(instanceName);
      assertExists(statusWithHealth);
      // Health might be undefined if check hasn't completed yet
    } finally {
      await manager.destroyInstance(instanceName, true).catch(() => {});
    }
  }
});

Deno.test({
  name: "PostgresManager - backup and restore",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const originalName = "test-backup-original";
    const restoredName = "test-backup-restored";
    const backupPath = join(TEST_BASE_DIR, "backup.tar.gz");

    const binaryDir = join(TEST_BASE_DIR, "backup-pg-cache");
    const previousBinaryDir = Deno.env.get("DISC_PG_BINARY_DIR");

    // Any step can fail while the original runs (the backup restarts it), so
    // all cleanup is in `finally`: it used to follow the assertions, and a
    // failure left the original's server running.
    try {
      // Create and start original instance
      await manager.createInstance(originalName, { pgBinDir: PG_BIN_DIR! });
      await manager.startInstance(originalName, false);

      // Create a backup
      await manager.backupInstance(originalName, backupPath);

      // Verify backup file exists
      const backupStat = await Deno.stat(backupPath);
      assertEquals(backupStat.isFile, true);

      // A restored data dir carries no version.json; recovery runs it on
      // cached binaries of its major, so stage the local PostgreSQL as one.
      await Deno.mkdir(join(binaryDir, manager.getInstance(originalName)!.getVersion()), { recursive: true });
      await Deno.symlink(PG_BIN_DIR!, join(binaryDir, manager.getInstance(originalName)!.getVersion(), "bin"));
      Deno.env.set("DISC_PG_BINARY_DIR", binaryDir);

      // Restore to new instance
      await manager.restoreInstance(restoredName, backupPath);

      // Verify restored instance exists, on the original's version
      const restored = manager.getInstance(restoredName);
      assertExists(restored);
      assertEquals(restored.getVersion(), manager.getInstance(originalName)!.getVersion());
    } finally {
      if (previousBinaryDir === undefined)
        Deno.env.delete("DISC_PG_BINARY_DIR");
      else
        Deno.env.set("DISC_PG_BINARY_DIR", previousBinaryDir);

      await manager.destroyInstance(originalName, true).catch(() => {});
      await manager.destroyInstance(restoredName, true).catch(() => {});
      await Deno.remove(backupPath).catch(() => {});
      await Deno.remove(binaryDir, { recursive: true }).catch(() => {});
    }
  }
});

/*** Version detection ---------------------------------------------------- ***/

interface FakeHome {
  binaryDir: string;
  discHome: string;
  instancesDir: string;
}

/**
 * A temp `$DISC_HOME` + binary cache for recovery tests. Recovery only
 * resolves binaries (it never runs them for an initialized data dir), so
 * fake `bin/postgres` files are enough; DISC_OFFLINE guards against a
 * resolution bug turning into a real download.
 */
async function withFakeHome(fn: (home: FakeHome) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "disc-mgr-version-" });
  const home = { binaryDir: join(root, "pg"), discHome: join(root, "home"), instancesDir: join(root, "home", "instances") };
  const saved = Object.fromEntries(
    ["DISC_HOME", "DISC_OFFLINE", "DISC_PG_BINARY_DIR"].map(key => [key, Deno.env.get(key)])
  );

  try {
    Deno.env.set("DISC_HOME", home.discHome);
    Deno.env.set("DISC_OFFLINE", "1");
    Deno.env.set("DISC_PG_BINARY_DIR", home.binaryDir);
    await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined)
        Deno.env.delete(key);
      else
        Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

async function fakeBinaries(dir: string): Promise<string> {
  await Deno.mkdir(join(dir, "bin"), { recursive: true });
  await Deno.writeTextFile(join(dir, "bin", "postgres"), "fake");
  return join(dir, "bin");
}

async function fakeDataDir(instancesDir: string, name: string, major: string, versionJson?: object): Promise<void> {
  await Deno.mkdir(join(instancesDir, name, "data"), { recursive: true });
  await Deno.writeTextFile(join(instancesDir, name, "data", "PG_VERSION"), `${major}\n`);

  if (versionJson)
    await Deno.writeTextFile(join(instancesDir, name, "version.json"), JSON.stringify(versionJson));
}

Deno.test("PostgresManager - a discovered 16 data dir without version.json runs on the newest cached 16.x", async () => {
  await withFakeHome(async ({ binaryDir, instancesDir }) => {
    await fakeBinaries(join(binaryDir, "16.2"));
    const bin164 = await fakeBinaries(join(binaryDir, "16.4"));
    await fakeBinaries(join(binaryDir, "18.4"));
    await fakeDataDir(instancesDir, "legacy", "16");

    const manager = new PostgresManager(instancesDir);
    await manager.discoverInstances();
    const instance = manager.getInstance("legacy");

    assertExists(instance);
    assertEquals(instance.getVersion(), "16.4");
    assertEquals(instance.getPgBinDir(), bin164);
    assertEquals((await manager.getInstanceStatus("legacy"))?.version, "16.4");
  });
});

Deno.test("PostgresManager - version.json's exact version and binaries are reused", async () => {
  await withFakeHome(async ({ binaryDir, discHome, instancesDir }) => {
    await fakeBinaries(join(binaryDir, "18.4"));
    const custom = await fakeBinaries(join(discHome, "custom-pg"));
    await fakeDataDir(instancesDir, "custom", "16", { binDir: custom, version: "16.1" });

    const manager = new PostgresManager(instancesDir);
    await manager.discoverInstances();
    const instance = manager.getInstance("custom");

    assertExists(instance);
    assertEquals(instance.getVersion(), "16.1");
    assertEquals(instance.getPgBinDir(), custom);
  });
});

Deno.test("PostgresManager - a version.json that disagrees with the data dir's major is overridden by PG_VERSION", async () => {
  await withFakeHome(async ({ binaryDir, instancesDir }) => {
    await fakeBinaries(join(binaryDir, "16.4"));
    await fakeBinaries(join(binaryDir, "18.4"));
    /*** e.g. a pre-upgrade 16 data dir restored by hand after an upgrade to 18.4 ***/
    await fakeDataDir(instancesDir, "restored", "16", { previousVersion: "16.4", version: "18.4" });

    const manager = new PostgresManager(instancesDir);
    await manager.discoverInstances();

    assertEquals(manager.getInstance("restored")?.getVersion(), "16.4");
  });
});

Deno.test("PostgresManager - an extracted embedded distribution is used when the download cache lacks the version", async () => {
  await withFakeHome(async ({ discHome, instancesDir }) => {
    const embeddedDir = join(discHome, "embedded-postgres", "18.4");
    const embeddedBin = await fakeBinaries(embeddedDir);
    await Deno.writeTextFile(join(embeddedDir, ".disc-embedded-pg-marker"), "test\n");
    await fakeDataDir(instancesDir, "embedded", "18");

    const manager = new PostgresManager(instancesDir);
    await manager.discoverInstances();
    const instance = manager.getInstance("embedded");

    assertExists(instance);
    assertEquals(instance.getVersion(), "18.4");
    assertEquals(instance.getPgBinDir(), embeddedBin);
  });
});

Deno.test("PostgresManager - a data dir of an unsupported major is not recovered with the wrong binaries", async () => {
  await withFakeHome(async ({ binaryDir, instancesDir }) => {
    await fakeBinaries(join(binaryDir, "18.4"));
    await fakeDataDir(instancesDir, "ancient", "15");

    const manager = new PostgresManager(instancesDir);
    await manager.discoverInstances();

    assertEquals(manager.getInstance("ancient"), undefined);
  });
});

Deno.test({
  name: "PostgresManager - createInstance records the binaries' actual version in version.json",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-recorded";

    try {
      const instance = await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });
      const version = parsePostgresVersion(
        new TextDecoder().decode(new Deno.Command(join(PG_BIN_DIR!, "postgres"), { args: ["--version"] }).outputSync().stdout)
      )!;

      assertEquals(instance.getVersion(), version);
      assertEquals(await readInstanceVersionFile(join(TEST_BASE_DIR, instanceName)), { binDir: PG_BIN_DIR!, version });
    } finally {
      await manager.destroyInstance(instanceName, true);
    }
  }
});

/*** Upgrade --------------------------------------------------------------- ***/

/*** Same-version "upgrades" with the local PostgreSQL (which has client tools) exercise the dump,
     restore, verify, switch and rollback machinery without a download. The cross-version path is
     covered by cli/pg-upgrade-net.test.ts. ***/

async function seedUpgradeFixture(manager: PostgresManager, name: string): Promise<void> {
  await manager.createInstance(name, { pgBinDir: PG_BIN_DIR! });
  await manager.startInstance(name, false);
  const instance = manager.getInstance(name)!;
  await instance.query("CREATE TABLE notes (title text NOT NULL)");
  await instance.query("INSERT INTO notes (title) VALUES ('alpha'), ('beta')");
  await instance.query("CREATE DATABASE extra", "postgres");
  await instance.query("CREATE TABLE things (n int)", "extra");
  await instance.query("INSERT INTO things SELECT generate_series(1, 25)", "extra");
  /*** Marks the original data dir, so a test can tell it apart from a restored copy. ***/
  await Deno.writeTextFile(join(instance.getDataDir(), "disc-original-marker"), "original");
}

async function upgradeLeftovers(instanceDir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(instanceDir)) {
    if (entry.name.startsWith("data-") || entry.name.startsWith("upgrade-"))
      names.push(entry.name);
  }
  return names;
}

Deno.test({
  name: "PostgresManager - upgradeInstance dumps, restores, verifies and switches the data dir",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const name = "up-ok";
    const instanceDir = join(TEST_BASE_DIR, name);
    const backupPath = join(TEST_BASE_DIR, "up-ok-backup.tar.gz");

    try {
      await seedUpgradeFixture(manager, name);
      const version = manager.getInstance(name)!.getVersion();
      const steps: string[] = [];

      const result = await manager.upgradeInstance(name, version, {
        backupPath,
        clientBinDir: PG_BIN_DIR!,
        onProgress: step => {
          steps.push(step);
        },
        serverBinDir: PG_BIN_DIR!
      });

      assertEquals(result, { fromVersion: version, toVersion: version });
      assertEquals(steps, ["dump", "backup", "init", "restore", "verify", "switch", "start"]);

      const upgraded = manager.getInstance(name)!;
      assertEquals((await upgraded.status()).running, true);
      assertEquals(
        (await upgraded.query<{ title: string; }>("SELECT title FROM notes ORDER BY title")).map(r => r.title),
        ["alpha", "beta"]
      );
      assertEquals((await upgraded.query<{ n: string; }>("SELECT count(*)::text AS n FROM things", "extra"))[0].n, "25");

      /*** The data dir is the restored copy; the original and all scratch files are gone. ***/
      await assertRejects(() => Deno.stat(join(upgraded.getDataDir(), "disc-original-marker")), Deno.errors.NotFound);
      assertEquals(await upgradeLeftovers(instanceDir), []);
      assertEquals((await Deno.stat(backupPath)).isFile, true);

      const info = await readInstanceVersionFile(instanceDir);
      assertEquals(info?.version, version);
      assertEquals(info?.previousVersion, version);
      assertEquals(info?.binDir, PG_BIN_DIR);
    } finally {
      await manager.destroyInstance(name, true).catch(() => {});
      await Deno.remove(backupPath).catch(() => {});
    }
  }
});

for (const failAt of ["verify", "start"] as const) {
  Deno.test({
    name: `PostgresManager - upgradeInstance failing at "${failAt}" rolls back to the untouched original`,
    ignore: !RUN_PG,
    fn: async () => {
      const manager = new PostgresManager(TEST_BASE_DIR);
      const name = `up-fail-${failAt}`;
      const instanceDir = join(TEST_BASE_DIR, name);

      try {
        await seedUpgradeFixture(manager, name);
        const original = manager.getInstance(name)!;
        const infoBefore = await readInstanceVersionFile(instanceDir);

        await assertRejects(
          () =>
            manager.upgradeInstance(name, original.getVersion(), {
              clientBinDir: PG_BIN_DIR!,
              onProgress: step => {
                if (step === failAt)
                  throw new Error(`injected failure at ${step}`);
              },
              serverBinDir: PG_BIN_DIR!
            }),
          Error,
          `is still on PostgreSQL ${original.getVersion()}: injected failure at ${failAt}`
        );

        /*** Same instance, same (original) data dir, running again, nothing left behind. ***/
        assertEquals(manager.getInstance(name), original);
        assertEquals((await original.status()).running, true);
        assertEquals(await Deno.readTextFile(join(original.getDataDir(), "disc-original-marker")), "original");
        assertEquals((await original.query<{ n: string; }>("SELECT count(*)::text AS n FROM notes"))[0].n, "2");
        assertEquals(await upgradeLeftovers(instanceDir), []);
        assertEquals(await readInstanceVersionFile(instanceDir), infoBefore);
      } finally {
        await manager.destroyInstance(name, true).catch(() => {});
      }
    }
  });
}

Deno.test("PostgresManager - handles non-existent instance gracefully", async () => {
  const manager = new PostgresManager(TEST_BASE_DIR);

  // Operations on non-existent instance should throw or return null/undefined
  await assertRejects(
    async () => await manager.startInstance("non-existent"),
    Error,
    "not found"
  );

  await assertRejects(
    async () => await manager.stopInstance("non-existent"),
    Error,
    "not found"
  );

  const status = await manager.getInstanceStatus("non-existent");
  assertEquals(status, null);

  const instance = manager.getInstance("non-existent");
  assertEquals(instance, undefined);
});
