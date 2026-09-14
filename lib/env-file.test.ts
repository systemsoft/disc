/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadEnvFile,
  loadProjectEnv,
  parseEnvFile,
  resetLoadedEnvRoots
} from "./env-file.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "disc-env-file-test-" });
}

/**
 * Run `fn` with `keys` guaranteed absent from the environment, restoring
 * whatever was there afterwards. Env is process-global, so every test that
 * mutates it has to clean up after itself.
 */
async function withCleanEnv(keys: string[], fn: () => Promise<void>): Promise<void> {
  const saved = new Map(keys.map(k => [k, Deno.env.get(k)]));

  for (const key of keys) {
    Deno.env.delete(key);
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }

    resetLoadedEnvRoots();
  }
}

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

Deno.test("parseEnvFile - parses plain pairs and skips comments and blanks", () => {
  const parsed = parseEnvFile([
    "# Disc Database Configuration",
    "",
    "DISC_PORT=5656",
    "DISC_HOST=localhost",
    "   ",
    "# trailing comment line"
  ]
    .join("\n"));

  assertEquals(parsed, { DISC_HOST: "localhost", DISC_PORT: "5656" });
});

Deno.test("parseEnvFile - tolerates an export prefix and spaces around =", () => {
  assertEquals(
    parseEnvFile("export DISC_JWT_SECRET = abc123"),
    { DISC_JWT_SECRET: "abc123" }
  );
});

Deno.test("parseEnvFile - single quotes keep the value literal", () => {
  // The exact secret shape that breaks unquoted zsh: `!`, `@`, `_`.
  assertEquals(
    parseEnvFile("DISC_JWT_SECRET='FxHbAh9k6_AJk!Y7@GpQGjzph4mmyWxb'"),
    { DISC_JWT_SECRET: "FxHbAh9k6_AJk!Y7@GpQGjzph4mmyWxb" }
  );
});

Deno.test("parseEnvFile - double quotes unescape the standard escape set", () => {
  assertEquals(
    parseEnvFile(String.raw`KEY="line1\nline2 \"quoted\" back\\slash"`),
    { KEY: "line1\nline2 \"quoted\" back\\slash" }
  );
});

Deno.test("parseEnvFile - strips a whitespace-preceded trailing comment", () => {
  assertEquals(
    parseEnvFile("DISC_PORT=5656 # the default"),
    { DISC_PORT: "5656" }
  );
});

Deno.test("parseEnvFile - keeps a '#' that is part of an unquoted value", () => {
  assertEquals(
    parseEnvFile("DISC_JWT_SECRET=abc#def"),
    { DISC_JWT_SECRET: "abc#def" }
  );
});

Deno.test("parseEnvFile - ignores malformed lines", () => {
  assertEquals(parseEnvFile("not a pair\n1INVALID=x\nOK=1"), { OK: "1" });
});

// ---------------------------------------------------------------------------
// loadEnvFile
// ---------------------------------------------------------------------------

Deno.test("loadEnvFile - missing file is a no-op", () => {
  assertEquals(loadEnvFile("/nonexistent/disc/.env"), []);
});

Deno.test("loadEnvFile - applies unset keys and leaves existing ones alone", async () => {
  const dir = await makeTempDir();

  await withCleanEnv(["DISC_TEST_UNSET", "DISC_TEST_PRESET"], async () => {
    const path = join(dir, ".env");
    await Deno.writeTextFile(
      path,
      "DISC_TEST_UNSET=from-file\nDISC_TEST_PRESET=from-file\n"
    );

    Deno.env.set("DISC_TEST_PRESET", "from-process");

    assertEquals(loadEnvFile(path), ["DISC_TEST_UNSET"]);
    assertEquals(Deno.env.get("DISC_TEST_UNSET"), "from-file");
    assertEquals(Deno.env.get("DISC_TEST_PRESET"), "from-process");
  });

  await Deno.remove(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// loadProjectEnv
// ---------------------------------------------------------------------------

Deno.test("loadProjectEnv - .env.local wins over .env", async () => {
  const dir = await makeTempDir();

  await withCleanEnv(["DISC_TEST_SHARED", "DISC_TEST_ONLY_BASE"], async () => {
    await Deno.writeTextFile(
      join(dir, ".env"),
      "DISC_TEST_SHARED=base\nDISC_TEST_ONLY_BASE=base\n"
    );
    await Deno.writeTextFile(join(dir, ".env.local"), "DISC_TEST_SHARED=local\n");

    loadProjectEnv(dir);

    assertEquals(Deno.env.get("DISC_TEST_SHARED"), "local");
    assertEquals(Deno.env.get("DISC_TEST_ONLY_BASE"), "base");
  });

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadProjectEnv - is idempotent per project root", async () => {
  const dir = await makeTempDir();

  await withCleanEnv(["DISC_TEST_ONCE"], async () => {
    await Deno.writeTextFile(join(dir, ".env"), "DISC_TEST_ONCE=first\n");

    assertEquals(loadProjectEnv(dir), ["DISC_TEST_ONCE"]);

    // A second call must not re-read or re-apply — the CLI resolves project
    // context many times per process.
    Deno.env.delete("DISC_TEST_ONCE");
    assertEquals(loadProjectEnv(dir), []);
    assertEquals(Deno.env.get("DISC_TEST_ONCE"), undefined);
  });

  await Deno.remove(dir, { recursive: true });
});
