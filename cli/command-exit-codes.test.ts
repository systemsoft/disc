/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A failed command exits non-zero.
 *
 * Commands report failure by throwing; `main()` turns that into exit code 1.
 * A command that logs an error and returns instead exits 0, so scripts and CI
 * read a failed `disc migrate` as a success. These run the real CLI entry
 * point in a subprocess and check the exit code.
 *
 * The PG test requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { CLICommands } from "./commands.ts";

const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));
const MAIN = fromFileUrl(new URL("./main.ts", import.meta.url));

/*** Run `disc <args>` from `cwd` (an empty temp dir, so no disc.toml is found above it). ***/
async function runDisc(cwd: string, args: string[]): Promise<{ code: number; stderr: string; }> {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--no-check", "--config", CONFIG, MAIN, ...args],
    cwd,
    stderr: "piped",
    stdout: "piped"
  })
    .output();

  return { code, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("disc migrate exits non-zero when the schema file is missing", async () => {
  const tempDir = await createTempDir();

  try {
    const { code, stderr } = await runDisc(tempDir, [
      "migrate",
      "--backend-dsn",
      "postgresql://localhost:1/nowhere",
      "--schema",
      `${tempDir}/missing.disc`
    ]);

    assertEquals(code, 1, stderr);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("disc schema export rejects when no schema files are found", async () => {
  const capture = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    capture.start();

    await assertRejects(
      () => new CLICommands().schemaExport({ "schema-dir": `${tempDir}/dbschema` }),
      Error,
      "No schema files found"
    );
  } finally {
    capture.stop();
    await cleanupTempDir(tempDir);
  }
});

Deno.test({
  name: "PG: disc migrate exits non-zero when the migration fails",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const tempDir = await createTempDir();

    try {
      await resetTestDatabase(pool);

      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const applied = await manager.applySchema(`
        module default {
          type Gadget {
            required name: str;
            serial_number: str;
          };
        };
      `);

      await manager.close();
      assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);

      /*** Dropping a property is refused without --unsafe, so this migrate fails. ***/
      const schema = `${tempDir}/schema.disc`;

      await Deno.writeTextFile(
        schema,
        `
        module default {
          type Gadget {
            required name: str;
          };
        };
      `
      );

      const { code, stderr } = await runDisc(tempDir, ["migrate", "--backend-dsn", dsn, "--schema", schema]);

      assertEquals(code, 1, stderr);
      assertStringIncludes(stderr, "unsafe");

      const history = await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`);
      assertEquals(history.rows[0].n, 1, "the failed migration is not recorded");
    } finally {
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});
