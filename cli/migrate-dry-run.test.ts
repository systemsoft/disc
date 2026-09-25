/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc migrate --dry-run` diffs against the applied schema.
 *
 * The preview must show the change from what the database's migration history
 * records — not a CREATE of every type, which is what diffing against an empty
 * schema yields — and must not apply it. With no database to read the history
 * from, it fails instead of quietly previewing against nothing.
 *
 * The PG test requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { CLICommands } from "./commands.ts";

const APPLIED = `
  module default {
    type Sprocket {
      required name: str;
    };
  };
`;

const PROPOSED = `
  module default {
    type Sprocket {
      required name: str;
      serial_number: str;
    };
  };
`;

Deno.test({
  name: "PG: disc migrate --dry-run previews only the change from the applied schema",
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
      const applied = await manager.applySchema(APPLIED);
      await manager.close();
      assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);

      const schema = `${tempDir}/schema.disc`;
      await Deno.writeTextFile(schema, PROPOSED);

      Deno.chdir(tempDir);
      capture.start();
      await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, "dry-run": true, schema });
      capture.stop();

      const output = [...capture.getLogs(), ...capture.getErrors()].join("\n");
      assertStringIncludes(output, "ALTER TABLE sprocket ADD COLUMN serial_number TEXT NULL;");
      assertEquals(output.includes("CREATE TABLE"), false, `dry-run re-created existing tables:\n${output}`);

      const column = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'sprocket' AND column_name = 'serial_number'`
      );
      assertEquals(column.rows.length, 0, "a dry run applies nothing");

      const history = await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`);
      assertEquals(history.rows[0].n, 1, "a dry run records no migration");
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "disc migrate --dry-run fails clearly when the database is unreachable",
  /*** The pool's connect retries leave timers behind on failure. ***/
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();

    try {
      const schema = `${tempDir}/schema.disc`;
      await Deno.writeTextFile(schema, PROPOSED);

      Deno.chdir(tempDir);
      capture.start();
      const error = await assertRejects(() =>
        new CLICommands().migrate({ _: ["migrate"], "backend-dsn": "postgresql://localhost:1/nowhere", "dry-run": true, schema })
      );
      capture.stop();

      assertStringIncludes((error as Error).message, "--dry-run needs the database");
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
    }
  }
});
