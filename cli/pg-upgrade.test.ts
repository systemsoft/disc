import { assertEquals, assertRejects } from "@std/assert";
import { PgUpgradeCommand } from "./pg-upgrade.ts";

Deno.test("PgUpgradeCommand - rejects unknown target version", async () => {
  const command = new PgUpgradeCommand();

  await assertRejects(
    () =>
      command.execute({
        targetVersion: "99.99",
        project: "test-project",
      }),
    Error,
    "Unknown PostgreSQL version: 99.99",
  );
});

Deno.test("PgUpgradeCommand - error includes available versions", async () => {
  const command = new PgUpgradeCommand();

  await assertRejects(
    () =>
      command.execute({
        targetVersion: "15.0",
        project: "test-project",
      }),
    Error,
    "16.4, 17.0",
  );
});

Deno.test("PgUpgradeCommand - rejects same version upgrade", () => {
  // This test will throw "not found" first since we don't have a real instance
  // But we can test the version comparison logic directly
  const command = new PgUpgradeCommand();
  const compareVersions = (command as any).compareVersions.bind(command);

  assertEquals(compareVersions("16.4", "16.4"), 0);
  assertEquals(compareVersions("16.4", "17.0"), -1);
  assertEquals(compareVersions("17.0", "16.4"), 1);
  assertEquals(compareVersions("16.0", "16.4"), -1);
});

Deno.test("PgUpgradeCommand - compareVersions handles different lengths", () => {
  const command = new PgUpgradeCommand();
  const compareVersions = (command as any).compareVersions.bind(command);

  assertEquals(compareVersions("16", "16.4"), -1);
  assertEquals(compareVersions("17", "16.4"), 1);
  assertEquals(compareVersions("16.4.1", "16.4"), 1);
});

Deno.test("PgUpgradeCommand - getAvailableVersions returns known versions", () => {
  const command = new PgUpgradeCommand();
  const getAvailableVersions = (command as any).getAvailableVersions.bind(
    command,
  );
  const versions = getAvailableVersions();

  assertEquals(versions.includes("16.4"), true);
  assertEquals(versions.includes("17.0"), true);
  assertEquals(versions.length, 2);
});

Deno.test("PgUpgradeCommand - instance not found error", async () => {
  const command = new PgUpgradeCommand();

  await assertRejects(
    () =>
      command.execute({
        targetVersion: "17.0",
        project: "nonexistent-project-xyz",
      }),
    Error,
    "No PostgreSQL instance found",
  );
});
