/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { PostgresManager } from "../postgres/manager.ts";
import { ConsoleCapture } from "../tests/test-utils.ts";
import { PgUpgradeCommand } from "./pg-upgrade.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("PgUpgradeCommand - rejects unknown target version", async () => {
  const command = new PgUpgradeCommand();

  await assertRejects(
    () =>
      command.execute({
        project: "test-project",
        targetVersion: "99.99"
      }),
    Error,
    "Unknown PostgreSQL version: 99.99"
  );
});

Deno.test("PgUpgradeCommand - error includes available versions", async () => {
  const command = new PgUpgradeCommand();

  await assertRejects(
    () =>
      command.execute({
        project: "test-project",
        targetVersion: "15.0"
      }),
    Error,
    "16.4, 17.0, 18.4"
  );
});

Deno.test("PgUpgradeCommand - rejects same version upgrade", () => {
  /*** This test will throw "not found" first since we don’t have a real instance But we can test
       the version comparison logic directly ***/
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
  const getAvailableVersions = (command as any).getAvailableVersions.bind(command);
  const versions = getAvailableVersions();

  assertEquals(versions.includes("16.4"), true);
  assertEquals(versions.includes("17.0"), true);
  assertEquals(versions.includes("18.4"), true);
  assertEquals(versions.length, 3);
});

Deno.test("PgUpgradeCommand - instance not found error", async () => {
  const command = new PgUpgradeCommand();

  await assertRejects(
    () =>
      command.execute({
        project: "nonexistent-project-xyz",
        targetVersion: "17.0"
      }),
    Error,
    "No PostgreSQL instance found"
  );
});

/**
 * An on-disk instance with a PostgreSQL `major` data dir and no version.json
 * (as created before it was recorded), plus fake cached server binaries.
 * Returns a command wired to it. Nothing here runs PostgreSQL.
 */
async function withFakeInstance(
  major: string,
  fn: (command: PgUpgradeCommand, capture: ConsoleCapture) => Promise<void>
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "disc-pgup-" });
  const instancesDir = join(root, "instances");
  const saved = { binaryDir: Deno.env.get("DISC_PG_BINARY_DIR"), offline: Deno.env.get("DISC_OFFLINE") };
  const capture = new ConsoleCapture();

  try {
    for (const version of ["16.4", "18.4"]) {
      await Deno.mkdir(join(root, "pg", version, "bin"), { recursive: true });
      await Deno.writeTextFile(join(root, "pg", version, "bin", "postgres"), "fake");
    }
    await Deno.mkdir(join(instancesDir, "legacy", "data"), { recursive: true });
    await Deno.writeTextFile(join(instancesDir, "legacy", "data", "PG_VERSION"), `${major}\n`);
    Deno.env.set("DISC_PG_BINARY_DIR", join(root, "pg"));
    Deno.env.set("DISC_OFFLINE", "1");

    capture.start();
    await fn(new PgUpgradeCommand({ postgresManager: new PostgresManager(instancesDir) }), capture);
  } finally {
    capture.stop();
    for (const [key, value] of [["DISC_PG_BINARY_DIR", saved.binaryDir], ["DISC_OFFLINE", saved.offline]] as const) {
      if (value === undefined)
        Deno.env.delete(key);
      else
        Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("PgUpgradeCommand - dry run reports the version the instance's data dir actually runs", async () => {
  await withFakeInstance("16", async (command, capture) => {
    await command.execute({ dryRun: true, project: "legacy", targetVersion: "18.4" });

    const output = capture.getLogs().join("\n");
    assertStringIncludes(output, "Current version: 16.4");
    assertStringIncludes(output, "Target version: 18.4");
    assertStringIncludes(output, "No changes were made");
  });
});

Deno.test("PgUpgradeCommand - an 18 data dir is not 'upgraded' to 18.4", async () => {
  await withFakeInstance("18", async command => {
    await assertRejects(
      () => command.execute({ dryRun: true, project: "legacy", targetVersion: "18.4" }),
      Error,
      "not newer than current version 18.4"
    );
  });
});
