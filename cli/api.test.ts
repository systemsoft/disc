/**
 * Programmatic CLI surface tests. (gh/geldata#5911 — Bundle NN)
 *
 * Verifies that `cli/api.ts` exposes a stable function-shaped surface
 * for every command worth driving from a Deno script, and that it's
 * reachable through the top-level `mod.ts` re-export as `CLI.*`.
 */

import { assert, assertEquals } from "@std/assert";

Deno.test("CLI api: every documented command is an exported function", async () => {
  const api = await import("./api.ts");
  const expected = [
    "init",
    "migrate",
    "serve",
    "shell",
    "watch",
    "build",
    "deploy",
    "pgLog",
    "pgUpgrade",
  ];
  for (const name of expected) {
    assertEquals(
      typeof (api as Record<string, unknown>)[name],
      "function",
      `cli/api.ts must export ${name}() (Gel #5911)`,
    );
  }
});

Deno.test("CLI api: surface is reachable via top-level CLI namespace", async () => {
  const mod = await import("../mod.ts");
  assert(
    typeof mod.CLI === "object" && mod.CLI !== null,
    "mod.ts must re-export CLI namespace (Gel #5911)",
  );
  // Spot-check a few entries — full coverage is in the per-export
  // function test above.
  for (const name of ["init", "migrate", "serve"]) {
    assertEquals(
      typeof (mod.CLI as Record<string, unknown>)[name],
      "function",
      `CLI.${name} must be a function (Gel #5911)`,
    );
  }
});

Deno.test("CLI api: typed Options interfaces are re-exported", async () => {
  // Type-only re-exports don't show up at runtime; this test
  // asserts the file textually re-exports each Options interface so
  // a refactor that drops them is caught.
  const src = await Deno.readTextFile(
    new URL("./api.ts", import.meta.url),
  );
  for (
    const t of [
      "InitOptions",
      "BuildOptions",
      "DeployOptions",
      "PgLogOptions",
      "PgUpgradeOptions",
      "ShellOptions",
      "WatchOptions",
      "ServeOptions",
    ]
  ) {
    assert(
      src.includes(`export type { ${t}`) ||
        new RegExp(`export type \\{ [^}]*\\b${t}\\b`).test(src),
      `cli/api.ts must re-export type ${t} (Gel #5911)`,
    );
  }
});
