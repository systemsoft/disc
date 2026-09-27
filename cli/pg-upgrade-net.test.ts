/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc pg upgrade` end to end: a real bundled PostgreSQL 16.4 instance is
 * upgraded to 18.4 with the real (checksum-verified) Zonky server builds and
 * theseus client tools, all downloaded into a fresh `$DISC_HOME`. A forced
 * failure after the data-dir switch must leave the 16.4 instance working.
 *
 * Network: set DISC_NET_TESTS=1 (downloads two server builds, ~30 MB each,
 * and the 18.4 client tools, ~13 MB).
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { PostgresClientTools } from "../postgres/client-tools.ts";
import { PostgresBinaryDownloader } from "../postgres/downloader.ts";
import { readInstanceVersionFile } from "../postgres/instance-version.ts";
import type { PostgresInstance } from "../postgres/instance.ts";
import { PostgresManager } from "../postgres/manager.ts";
import { ConsoleCapture } from "../tests/test-utils.ts";
import { PgUpgradeCommand } from "./pg-upgrade.ts";

/*** HELPER ------------------------------------------- ***/

const PROJECT = "netupgrade";

/** A fresh manager's view of the instance, as a new `disc` process would see it. */
async function rediscover(instancesDir: string): Promise<PostgresInstance> {
  const manager = new PostgresManager(instancesDir);
  await manager.discoverInstances();
  return manager.getInstance(PROJECT)!;
}

async function contents(instance: PostgresInstance): Promise<{ notes: string[]; things: string; }> {
  const notes = await instance.query<{ title: string; }>("SELECT title FROM notes ORDER BY title");
  const things = await instance.query<{ n: string; }>("SELECT count(*)::text AS n FROM things", "extra");
  return { notes: notes.map(row => row.title), things: things[0].n };
}

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  name: "NET: disc pg upgrade moves a bundled 16.4 instance to 18.4, and a failed attempt rolls back",
  ignore: Deno.env.get("DISC_NET_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    /*** Under /tmp to keep the Unix socket path short. ***/
    const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "disc-up-" });
    const discHome = join(root, "home");
    const instancesDir = join(discHome, "instances");
    const projectDir = join(root, "project");
    const saved = Object.fromEntries(
      ["DISC_HOME", "DISC_OFFLINE", "DISC_PG_BINARY_DIR"].map(key => [key, Deno.env.get(key)])
    );
    const cwd = Deno.cwd();
    const capture = new ConsoleCapture();
    const expected = { notes: ["alpha", "beta"], things: "25" };

    try {
      Deno.env.set("DISC_HOME", discHome);
      Deno.env.set("DISC_PG_BINARY_DIR", join(discHome, "postgres"));
      Deno.env.delete("DISC_OFFLINE");
      await Deno.mkdir(projectDir, { recursive: true });
      await Deno.writeTextFile(join(projectDir, "disc.toml"), `name = "${PROJECT}"\n`);

      /*** A real bundled 16.4 instance with data in two databases. ***/
      const manager = new PostgresManager(instancesDir);
      const original = await manager.createInstance(PROJECT, { postgresVersion: "16.4" });
      await manager.startInstance(PROJECT, false);
      await original.query("CREATE TABLE notes (title text NOT NULL)");
      await original.query("INSERT INTO notes (title) VALUES ('alpha'), ('beta')");
      await original.query("CREATE DATABASE extra", "postgres");
      await original.query("CREATE TABLE things (n int)", "extra");
      await original.query("INSERT INTO things SELECT generate_series(1, 25)", "extra");
      assertEquals((await rediscover(instancesDir)).getVersion(), "16.4");

      /*** 1. Fail after the data dir was switched to 18 (the riskiest point): back to 16.4, intact. ***/
      const serverBinDir = join(await new PostgresBinaryDownloader().ensurePostgres("18.4"), "bin");
      const clientBinDir = await new PostgresClientTools().ensure("18.4");

      await assertRejects(
        () =>
          manager.upgradeInstance(PROJECT, "18.4", {
            clientBinDir,
            onProgress: step => {
              if (step === "start")
                throw new Error("injected failure");
            },
            serverBinDir
          }),
        Error,
        "is still on PostgreSQL 16.4: injected failure"
      );

      const rolledBack = await rediscover(instancesDir);
      assertEquals(rolledBack.getVersion(), "16.4");
      assertEquals((await Deno.readTextFile(join(rolledBack.getDataDir(), "PG_VERSION"))).trim(), "16");
      assertEquals((await rolledBack.status()).running, true);
      assertEquals(await contents(rolledBack), expected);

      /*** 2. The real command, as `disc pg upgrade --target-version 18.4` runs it from the project. ***/
      Deno.chdir(projectDir);
      capture.start();
      await new PgUpgradeCommand().execute({ targetVersion: "18.4" });
      capture.stop();
      assertStringIncludes(capture.getLogs().join("\n"), "upgraded successfully from 16.4 to 18.4");

      const upgraded = await rediscover(instancesDir);
      assertEquals(upgraded.getVersion(), "18.4");
      assertEquals((await Deno.readTextFile(join(upgraded.getDataDir(), "PG_VERSION"))).trim(), "18");
      assertEquals((await upgraded.status()).running, true);
      assertStringIncludes((await upgraded.query<{ v: string; }>("SELECT version() AS v"))[0].v, "PostgreSQL 18.4");
      assertEquals(await contents(upgraded), expected);

      const info = await readInstanceVersionFile(join(instancesDir, PROJECT));
      assertEquals(info?.previousVersion, "16.4");
      assertEquals(info?.version, "18.4");

      /*** Only the backup tarball is left beside the new data dir. ***/
      const leftovers = [...Deno.readDirSync(join(instancesDir, PROJECT))]
        .map(entry => entry.name)
        .filter(name => name.startsWith("data-") || name.startsWith("upgrade-") || name.startsWith("backup-"));
      assertEquals(leftovers.length, 1);
      assertStringIncludes(leftovers[0], "backup-16.4-");
    } finally {
      capture.stop();
      Deno.chdir(cwd);

      await (await rediscover(instancesDir).catch(() => undefined))?.stop().catch(() => {});

      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined)
          Deno.env.delete(key);
        else
          Deno.env.set(key, value);
      }

      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }
});
