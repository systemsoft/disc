/**
 * `disc schema export` (#702 + #7469 — Phase 2)
 */

import { assert, assertStringIncludes } from "@std/assert";
import { commands } from "./commands.ts";
import {
  cleanupTempDir,
  ConsoleCapture,
  createTempDir,
} from "../tests/test-utils.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

const SAMPLE_SDL = `module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    multi link posts -> Post;
  };

  type Post {
    required title: str;
    required link author -> User;
  };
};
`;

async function writeSchemaFile(dir: string): Promise<string> {
  const path = `${dir}/schema.disc`;
  await Deno.writeTextFile(path, SAMPLE_SDL);
  return path;
}

Deno.test("schema export - writes SDL file containing all types", async () => {
  const tempDir = await createTempDir();
  try {
    const schemaIn = await writeSchemaFile(tempDir);
    const schemaOut = `${tempDir}/exported.disc`;

    const cap = new ConsoleCapture();
    cap.capture();
    try {
      await commands.schemaExport({ schema: schemaIn, output: schemaOut });
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
      await commands.schemaExport({ schema: schemaIn, output: schemaOut });
    } finally {
      cap.restore();
    }

    const text = await Deno.readTextFile(schemaOut);
    const mgr = new SchemaManager({ dryRun: true });
    const result = mgr.parseSDL(text);
    if (!result.ok) throw new Error(`re-parse failed: ${JSON.stringify(result.error)}`);
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
    // Either throws or prints an error — must not write a file or
    // succeed silently.
    const errorOutput = cap.getErrors().join("\n") + cap.getLogs().join("\n");
    assert(
      threw || /not found|failed|error/i.test(errorOutput),
      `expected failure indication; got logs:\n${errorOutput}`,
    );
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
