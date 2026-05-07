import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PostgresManager } from "./manager.ts";
import { canRunPgTests, findPgBinDir } from "../tests/pg-test-harness.ts";

// Use /tmp directly to keep Unix socket paths under the 108-char limit.
const TEST_BASE_DIR = Deno.makeTempDirSync({
  dir: "/tmp",
  prefix: "disc-mgr-",
});

// Skip guard: tests that require real PostgreSQL binaries
const RUN_PG = canRunPgTests();
const PG_BIN_DIR = findPgBinDir();

Deno.test({
  name: "PostgresManager - create instance",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-create";

    const instance = await manager.createInstance(instanceName, {
      pgBinDir: PG_BIN_DIR!,
      port: 0, // Unix socket only
      postgresVersion: "16.4",
    });

    assertExists(instance);
    assertEquals(instance.getPort(), 0);

    // Verify instance is tracked
    const tracked = manager.getInstance(instanceName);
    assertEquals(tracked, instance);

    // Cleanup
    await manager.destroyInstance(instanceName, true);
  },
});

Deno.test({
  name: "PostgresManager - prevent duplicate instances",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-duplicate";

    await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });

    // Attempt to create duplicate should throw
    await assertRejects(
      async () => await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! }),
      Error,
      "already exists",
    );

    // Cleanup
    await manager.destroyInstance(instanceName, true);
  },
});

Deno.test({
  name: "PostgresManager - start and stop instance",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-lifecycle";

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

    // Cleanup
    await manager.destroyInstance(instanceName, true);
  },
});

Deno.test({
  name: "PostgresManager - list instances",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);

    // Create multiple instances
    await manager.createInstance("instance1", { pgBinDir: PG_BIN_DIR! });
    await manager.createInstance("instance2", { pgBinDir: PG_BIN_DIR! });
    await manager.createInstance("instance3", { pgBinDir: PG_BIN_DIR! });

    const instances = manager.listInstances();
    assertEquals(instances.length, 3);
    assertEquals(instances.includes("instance1"), true);
    assertEquals(instances.includes("instance2"), true);
    assertEquals(instances.includes("instance3"), true);

    // Cleanup
    await manager.destroyInstance("instance1", true);
    await manager.destroyInstance("instance2", true);
    await manager.destroyInstance("instance3", true);
  },
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
  },
});

Deno.test({
  name: "PostgresManager - recover existing instance",
  ignore: !RUN_PG,
  fn: async () => {
    const manager1 = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-recover";

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

    // Cleanup
    await manager1.stopInstance(instanceName);
    await manager1.destroyInstance(instanceName, true);
  },
});

Deno.test({
  name: "PostgresManager - instance with monitor",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-monitor";

    await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });
    await manager.startInstance(instanceName, true); // With monitor

    const status = await manager.getInstanceStatus(instanceName);
    assertExists(status);
    assertEquals(status.running, true);

    // Health status should be available when monitor is running
    // Note: Initial health check might not be complete immediately
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusWithHealth = await manager.getInstanceStatus(instanceName);
    assertExists(statusWithHealth);
    // Health might be undefined if check hasn't completed yet

    await manager.stopInstance(instanceName);
    await manager.destroyInstance(instanceName, true);
  },
});

Deno.test({
  name: "PostgresManager - backup and restore",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const originalName = "test-backup-original";
    const restoredName = "test-backup-restored";
    const backupPath = join(TEST_BASE_DIR, "backup.tar.gz");

    // Create and start original instance
    await manager.createInstance(originalName, { pgBinDir: PG_BIN_DIR! });
    await manager.startInstance(originalName, false);

    // Create a backup
    await manager.backupInstance(originalName, backupPath);

    // Verify backup file exists
    const backupStat = await Deno.stat(backupPath);
    assertEquals(backupStat.isFile, true);

    // Restore to new instance
    await manager.restoreInstance(restoredName, backupPath);

    // Verify restored instance exists
    const restored = manager.getInstance(restoredName);
    assertExists(restored);

    // Cleanup
    await manager.stopInstance(originalName);
    await manager.destroyInstance(originalName, true);
    await manager.destroyInstance(restoredName, true);
    await Deno.remove(backupPath);
  },
});

Deno.test({
  name: "PostgresManager - upgrade instance throws not implemented",
  ignore: !RUN_PG,
  fn: async () => {
    const manager = new PostgresManager(TEST_BASE_DIR);
    const instanceName = "test-upgrade";

    await manager.createInstance(instanceName, { pgBinDir: PG_BIN_DIR! });

    await assertRejects(
      async () => await manager.upgradeInstance(instanceName, "17.0"),
      Error,
      "not yet implemented",
    );

    // Cleanup
    await manager.destroyInstance(instanceName, true);
  },
});

Deno.test("PostgresManager - handles non-existent instance gracefully", async () => {
  const manager = new PostgresManager(TEST_BASE_DIR);

  // Operations on non-existent instance should throw or return null/undefined
  await assertRejects(
    async () => await manager.startInstance("non-existent"),
    Error,
    "not found",
  );

  await assertRejects(
    async () => await manager.stopInstance("non-existent"),
    Error,
    "not found",
  );

  const status = await manager.getInstanceStatus("non-existent");
  assertEquals(status, null);

  const instance = manager.getInstance("non-existent");
  assertEquals(instance, undefined);
});
