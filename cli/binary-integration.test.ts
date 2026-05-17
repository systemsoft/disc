/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Black-box integration test for the compiled Disc binary.
 *
 * This test only runs when `./disc` (or `./disc-<platform>`) exists in
 * the repo root — i.e. after a successful `deno task build`. On clean
 * machines with no build artifact, every assertion is `ignored` so CI
 * doesn’t fail spuriously.
 *
 * What we verify when the binary is present:
 *   1. `./disc --version` exits 0 and prints "Disc Database v…".
 *   2. `./disc --help` exits 0 and lists the subcommands.
 *
 * Booting PG + serving HTTP would also be valuable but takes 10+
 * seconds per run and the existing config-matrix e2e suite already
 * covers serve/health from a `deno run` entrypoint. The cheap two
 * checks above guard the most important regression: that the embedded
 * UI + PG manifest don’t crash the binary at startup. (Bundle I)
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_BINARY = join(REPO_ROOT, "disc");

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  fn: async () => {
    const binary = (await findBinary())!;

    const out = await new Deno.Command(binary, {
      args: ["--version"],
      stderr: "piped",
      stdout: "piped"
    })
      .output();

    assertEquals(out.success, true);

    const stdout = new TextDecoder().decode(out.stdout);
    /*** Match either "Disc Database v…" (current) or "Disc Database CLI v…" (older binaries that
         may still be on disk). ***/
    assertStringIncludes(stdout, "Disc Database");
    assertStringIncludes(stdout, "v");
  },
  name: "compiled binary - --version exits 0 and prints version",
  ignore: (await findBinary()) === null
});

Deno.test({
  fn: async () => {
    const binary = (await findBinary())!;

    const out = await new Deno.Command(binary, {
      args: ["--help"],
      stderr: "piped",
      stdout: "piped"
    })
      .output();

    assertEquals(out.success, true);

    const stdout = new TextDecoder().decode(out.stdout);

    /*** Sanity-check that the help output mentions a few core commands. ***/
    for (const cmd of ["init", "serve", "migrate", "build"]) {
      assertStringIncludes(stdout, cmd);
    }
  },
  name: "compiled binary - --help exits 0 and lists subcommands",
  ignore: (await findBinary()) === null
});

/*** HELPER ------------------------------------------- ***/

async function findBinary(): Promise<string | null> {
  for (
    const candidate of [
      DEFAULT_BINARY,
      join(REPO_ROOT, "disc-darwin-arm64"),
      join(REPO_ROOT, "disc-darwin-x64"),
      join(REPO_ROOT, "disc-linux-arm64"),
      join(REPO_ROOT, "disc-linux-x64")
    ]
  ) {
    try {
      const stat = await Deno.stat(candidate);

      if (stat.isFile && (stat.mode ?? 0) & 0o100)
        return candidate;
    } catch {
      /*** try the next one ***/
    }
  }

  return null;
}
