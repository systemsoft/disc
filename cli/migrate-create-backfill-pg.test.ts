/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc migrate --create` previews the index backfill.
 *
 * On a deployment whose recorded schema already declares a type-level
 * `constraint exclusive on (…)` but whose database lacks the index, the schema
 * diff is empty. The preview must still show the `CREATE UNIQUE INDEX IF NOT
 * EXISTS` that `disc migrate` is about to run, and must not run it.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { CLICommands } from "./commands.ts";

const FIXTURE = fromFileUrl(new URL("../tests/fixtures/git-forge.disc", import.meta.url));

Deno.test({
  name: "PG: disc migrate --create previews the unique indexes a recorded baseline is missing",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    /*** Run from an empty directory: no disc.toml above it, so the CLI can only reach `--backend-dsn`. ***/
    const tempDir = await createTempDir();

    try {
      await resetTestDatabase(pool);

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(await Deno.readTextFile(FIXTURE));
      await manager.close();
      assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);
      await pool.query(`DROP INDEX uk_git_ref_program_id_name`);

      Deno.chdir(tempDir);
      capture.start();
      await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, create: true, schema: FIXTURE });
      capture.stop();

      const output = [...capture.getLogs(), ...capture.getErrors()].join("\n");
      assertStringIncludes(output, "CREATE UNIQUE INDEX IF NOT EXISTS uk_git_ref_program_id_name ON git_ref (program_id, name);");

      const index = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uk_git_ref_program_id_name'`);
      assertEquals(index.rows.length, 0, "a preview creates nothing");
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});
