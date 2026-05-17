/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc schema introspect` CLI integration test (#3452 — Phase 4)
 */

/*** NATIVE ------------------------------------------- ***/

import { assertStringIncludes } from "@std/assert";

/*** IMPORT ------------------------------------------- ***/

import { default as dedent } from "@netopwibby/dedent";

/*** UTILITY ------------------------------------------ ***/

import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { commands } from "./commands.ts";
import { DatabaseConnection } from "../lib/database.ts";

const FIXTURE_SQL = dedent`
  DROP TABLE IF EXISTS schema_intr_posts CASCADE;
  DROP TABLE IF EXISTS schema_intr_users CASCADE;

  CREATE TABLE schema_intr_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text NOT NULL
  );

  CREATE TABLE schema_intr_posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    author_id uuid NOT NULL REFERENCES schema_intr_users(id)
  );
`;

const TEARDOWN_SQL = dedent`
  DROP TABLE IF EXISTS schema_intr_posts CASCADE;
  DROP TABLE IF EXISTS schema_intr_users CASCADE;
`;

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await setupFixture(dsn);

    const tempDir = await createTempDir();
    const outPath = `${tempDir}/introspected.disc`;

    try {
      const cap = new ConsoleCapture();
      cap.capture();

      try {
        await commands.schemaIntrospect({ "database-url": dsn, output: outPath });
      } finally {
        cap.restore();
      }

      const text = await Deno.readTextFile(outPath);
      assertStringIncludes(text, "module default {");
      /*** schema_intr_users → SchemaIntrUser (snake_case → PascalCase + singular) ***/
      assertStringIncludes(text, "type SchemaIntrUser");
      assertStringIncludes(text, "type SchemaIntrPost");
      /*** email UNIQUE → exclusive constraint ***/
      assertStringIncludes(text, "constraint exclusive");
      /*** author_id FK → link author -> SchemaIntrUser ***/
      assertStringIncludes(text, "link author -> SchemaIntrUser");
    } finally {
      await teardownFixture(dsn);
      await cleanupTempDir(tempDir);
    }
  },
  ignore: !canRunPgTests(),
  name: "schema introspect - writes SDL describing the live PG schema"
});

Deno.test("schema introspect - missing DSN fails with clear message", async () => {
  const cap = new ConsoleCapture();
  cap.capture();
  /*** Make sure DATABASE_URL isn’t set in this scope. ***/
  const saved = Deno.env.get("DATABASE_URL");

  if (saved !== undefined)
    Deno.env.delete("DATABASE_URL");

  try {
    await commands.schemaIntrospect({});
  } finally {
    if (saved !== undefined)
      Deno.env.set("DATABASE_URL", saved);

    cap.restore();
  }

  const errors = cap.getErrors().join("\n");
  assertStringIncludes(errors, "--database-url");
});

/*** HELPER ------------------------------------------- ***/

async function setupFixture(dsn: string): Promise<void> {
  const db = new DatabaseConnection(dsn);
  await db.connect();

  try {
    await db.execute(FIXTURE_SQL);
  } finally {
    await db.close();
  }
}

async function teardownFixture(dsn: string): Promise<void> {
  const db = new DatabaseConnection(dsn);
  await db.connect();

  try {
    await db.execute(TEARDOWN_SQL);
  } finally {
    await db.close();
  }
}
