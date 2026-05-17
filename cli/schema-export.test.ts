/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc schema export` (#702 + #7469 — Phase 2)
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertStringIncludes } from "@std/assert";

/*** IMPORT ------------------------------------------- ***/

import { default as dedent } from "@netopwibby/dedent";

/*** UTILITY ------------------------------------------ ***/

import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { commands } from "./commands.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

const SAMPLE_SDL = dedent`
  module default {
    type User {
      required email: str {
        constraint exclusive;
      };
      required name: str;
      multi link posts -> Post;
    };

    type Post {
      required link author -> User;
      required title: str;
    };
  };
`;

/*** RUNTIME ------------------------------------------ ***/

Deno.test("schema export - writes SDL file containing all types", async () => {
  const tempDir = await createTempDir();

  try {
    const schemaIn = await writeSchemaFile(tempDir);
    const schemaOut = `${tempDir}/exported.disc`;
    const cap = new ConsoleCapture();
    cap.capture();

    try {
      await commands.schemaExport({ output: schemaOut, schema: schemaIn });
    } finally {
      cap.restore();
    }

    const text = await Deno.readTextFile(schemaOut);
    assertStringIncludes(text, "module default {");
    assertStringIncludes(text, "type User");
    assertStringIncludes(text, "type Post");
    assertStringIncludes(text, "constraint exclusive");
    assertStringIncludes(text, "multi link posts -> Post;");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("schema export - emitted SDL re-parses cleanly", async () => {
  const tempDir = await createTempDir();

  try {
    const schemaIn = await writeSchemaFile(tempDir);
    const schemaOut = `${tempDir}/exported.disc`;
    const cap = new ConsoleCapture();
    cap.capture();

    try {
      await commands.schemaExport({ output: schemaOut, schema: schemaIn });
    } finally {
      cap.restore();
    }

    const text = await Deno.readTextFile(schemaOut);
    const mgr = new SchemaManager({ dryRun: true });
    const result = mgr.parseSDL(text);

    if (!result.ok)
      throw new Error(`re-parse failed: ${JSON.stringify(result.error)}`);

    const schema = mgr.modulesToSchema(result.value);
    assert(schema.types.has("User") || schema.types.has("default::User"));
    assert(schema.types.has("Post") || schema.types.has("default::Post"));
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("schema export - missing schema file fails gracefully", async () => {
  const tempDir = await createTempDir();

  try {
    const schemaIn = `${tempDir}/does-not-exist.disc`;
    const cap = new ConsoleCapture();
    cap.capture();
    let threw = false;

    try {
      await commands.schemaExport({ schema: schemaIn });
    } catch {
      threw = true;
    } finally {
      cap.restore();
    }

    /*** Either throws or prints an error — must not write a file or succeed silently. ***/
    const errorOutput = cap.getErrors().join("\n") + cap.getLogs().join("\n");
    assert(threw || /not found|failed|error/i.test(errorOutput), `expected failure indication; got logs:\n${errorOutput}`);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("schema export - stdout fallback when no --output", async () => {
  const tempDir = await createTempDir();

  try {
    const schemaIn = await writeSchemaFile(tempDir);
    const cap = new ConsoleCapture();
    cap.capture();

    try {
      await commands.schemaExport({ schema: schemaIn });
    } finally {
      cap.restore();
    }

    const out = cap.getLogs().join("\n");
    assertStringIncludes(out, "module default {");
    assertStringIncludes(out, "type User");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

/*** HELPER ------------------------------------------- ***/

async function writeSchemaFile(dir: string): Promise<string> {
  const path = `${dir}/schema.disc`;
  await Deno.writeTextFile(path, SAMPLE_SDL);

  return path;
}
