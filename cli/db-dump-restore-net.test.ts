/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc db dump` / `disc db restore` against a real bundled instance.
 *
 * The bundled (Zonky) server ships only `initdb`, `pg_ctl` and `postgres`, so
 * dump/restore download PostgreSQL client tools on first use. The PG-gated
 * tests elsewhere use system PostgreSQL (full toolset) and never saw that the
 * bundled install had no pg_dump. This test uses the real bundled server and
 * a fresh `$DISC_HOME`, so the client tools are downloaded, checksum-verified
 * and used exactly as on a user's machine.
 *
 * Network: set DISC_NET_TESTS=1 (downloads ~13 MB of client tools, plus the
 * Zonky server if it isn't already cached in `$DISC_PG_BINARY_DIR`).
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { DatabaseConnection } from "../lib/database.ts";
import { resolveDsn, resolveProjectContext } from "../lib/project-context.ts";
import { clientToolsManifest, pgToolPath } from "../postgres/client-tools.ts";
import { detectPgPlatform } from "../postgres/downloader.ts";
import { PostgresManager } from "../postgres/manager.ts";
import { ConsoleCapture } from "../tests/test-utils.ts";
import { CLICommands } from "./commands.ts";

/*** HELPER ------------------------------------------- ***/

const PROJECT = "netdump";

async function titles(dsn: string): Promise<string[]> {
  const conn = new DatabaseConnection(dsn);

  try {
    await conn.connect();
    const result = await conn.query(`SELECT title FROM notes ORDER BY title`);
    return result.rows.map(row => row.title as string);
  } finally {
    await conn.close();
  }
}

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  name: "NET: disc db dump + restore work on a bundled instance by downloading client tools",
  ignore: Deno.env.get("DISC_NET_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    /*** Under /tmp to keep the Unix socket path short. ***/
    const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "disc-net-" });
    const discHome = join(root, "home");
    const projectDir = join(root, "project");
    const previousHome = Deno.env.get("DISC_HOME");
    const cwd = Deno.cwd();
    const capture = new ConsoleCapture();
    let manager: PostgresManager | undefined;

    try {
      Deno.env.set("DISC_HOME", discHome);
      await Deno.mkdir(projectDir, { recursive: true });
      await Deno.writeTextFile(join(projectDir, "disc.toml"), `name = "${PROJECT}"\n`);

      /*** A real bundled instance, as `disc init` creates it. ***/
      manager = new PostgresManager(join(discHome, "instances"));
      await manager.createInstance(PROJECT);
      await manager.startInstance(PROJECT, false);

      Deno.chdir(projectDir);
      const ctx = resolveProjectContext()!;
      const dsn = resolveDsn(ctx);
      const seed = new DatabaseConnection(dsn);

      try {
        await seed.connect();
        await seed.execute(`CREATE TABLE notes (title text NOT NULL)`);
        await seed.execute(`INSERT INTO notes (title) VALUES ('alpha'), ('beta')`);
      } finally {
        await seed.close();
      }

      const plainFile = join(root, "backup.sql");
      const customFile = join(root, "backup.dump");
      const cli = new CLICommands();

      capture.start();
      await cli.dbDump(PROJECT, { _: [], output: plainFile });
      await cli.dbDump(PROJECT, { _: [], format: "custom", output: customFile });
      await cli.dbCreate("plaincopy", { _: [] });
      await cli.dbCreate("customcopy", { _: [] });
      await cli.dbRestore("plaincopy", { _: [], input: plainFile });
      await cli.dbRestore("customcopy", { _: [], input: customFile });
      capture.stop();

      /*** Client tools landed in the per-DISC_HOME cache (server major from PG_VERSION). ***/
      const serverMajor = (await Deno.readTextFile(join(ctx.dataDir, "PG_VERSION"))).trim();
      const release = clientToolsManifest(serverMajor, detectPgPlatform())!.release;
      const pgDump = pgToolPath(join(discHome, "postgres-client", release, "bin"), "pg_dump");
      assertEquals((await Deno.stat(pgDump)).isFile, true);

      const socketDsn = (db: string): string => `postgresql://disc@/${db}?host=${ctx.socketDir}`;
      assertEquals(await titles(socketDsn("disc_plaincopy")), ["alpha", "beta"]);
      assertEquals(await titles(socketDsn("disc_customcopy")), ["alpha", "beta"]);
    } finally {
      capture.stop();
      Deno.chdir(cwd);

      if (manager)
        await manager.stopInstance(PROJECT).catch(() => {});

      if (previousHome === undefined)
        Deno.env.delete("DISC_HOME");
      else
        Deno.env.set("DISC_HOME", previousHome);

      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }
});
