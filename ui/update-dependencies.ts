/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `bun run test:dependencies` — `bun update --latest` for every dependency
 * except the ones in `HELD`.
 *
 * `bun update` has no exclude flag, and a bare `--latest` rewrites the
 * `typescript` pin to 7, which svelte-check 4.x refuses. `overrides` doesn't
 * work either: it also forces the `@typescript/native` alias (npm:typescript@7,
 * what `--tsgo` runs on) down to 6. So name the packages explicitly instead.
 *
 * `npm:` aliases can't be named (bun looks them up by the alias name and
 * 404s), so they are skipped here and refreshed within their range by the
 * plain `bun update` that follows.
 */

/*** NATIVE ------------------------------------------- ***/

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/*** UTILITY ------------------------------------------ ***/

/** Drop `typescript` from here once svelte-check accepts TS 7 (see check-typescript-pin.ts). */
const HELD = ["typescript"];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/*** EXPORT ------------------------------------------- ***/

export function packagesToUpdate(pkg: PackageJson): string[] {
  const specs = { ...pkg.dependencies, ...pkg.devDependencies };

  return Object.keys(specs).filter(name => !HELD.includes(name) && !specs[name].startsWith("npm:"));
}

/*** PROGRAM ------------------------------------------ ***/

function run(args: string[]): void {
  const result = spawnSync("bun", args, { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit" });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (import.meta.main) {
  const pkg: PackageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

  run(["update", "--latest", ...packagesToUpdate(pkg)]);
  run(["update"]);
}
