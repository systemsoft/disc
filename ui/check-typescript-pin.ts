/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console

/**
 * First step of `bun run check`: fail with an explanation when the installed
 * `typescript` is a major svelte-check doesn't accept, instead of letting
 * svelte-check fail with its own less obvious error.
 *
 * svelte-check 4.x peers on `typescript@^5 || ^6`, so `typescript` is pinned
 * to ~6.0 and TS 7 comes in as the `@typescript/native` alias that `--tsgo`
 * runs on. Once svelte-check's peer range accepts 7 this passes on its own,
 * and the pin, the alias and `HELD` in update-dependencies.ts can go.
 *
 * Skips silently when either package isn't installed.
 */

/*** NATIVE ------------------------------------------- ***/

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

/*** UTILITY ------------------------------------------ ***/

interface PackageJson {
  peerDependencies?: Record<string, string>;
  version: string;
}

function readInstalled(name: string): PackageJson | null {
  const url = new URL(`./node_modules/${name}/package.json`, import.meta.url);

  return existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : null;
}

/** Leading major of each `||` alternative: `"^5.0.0 || ^6.0.0"` → `[5, 6]`. */
function rangeMajors(range: string): number[] {
  return range.split("||").map(part => Number(part.match(/\d+/)?.[0]));
}

/*** EXPORT ------------------------------------------- ***/

/** Why `typescriptVersion` can't be used with that svelte-check, or `null` if it can. */
export function typescriptPinProblem(typescriptVersion: string, svelteCheckVersion: string, peerRange: string): string | null {
  const major = Number(typescriptVersion.split(".")[0]);

  if (rangeMajors(peerRange).includes(major)) {
    return null;
  }

  return [
    `typescript ${typescriptVersion} is installed, but svelte-check ${svelteCheckVersion} only accepts typescript "${peerRange}".`,
    `Pin "typescript" in ui/package.json back to a supported major (e.g. "~6.0.3") and run \`bun install\`;`,
    `type-checking still runs on TS 7 through the "@typescript/native" alias and --tsgo.`,
    `Once svelte-check's peer range accepts TS 7, drop the pin, the alias and HELD in ui/update-dependencies.ts.`
  ]
    .join("\n");
}

/*** PROGRAM ------------------------------------------ ***/

if (import.meta.main) {
  const typescript = readInstalled("typescript");
  const svelteCheck = readInstalled("svelte-check");
  const peerRange = svelteCheck?.peerDependencies?.typescript;

  if (typescript && svelteCheck && peerRange) {
    const problem = typescriptPinProblem(typescript.version, svelteCheck.version, peerRange);

    if (problem) {
      console.error(problem);
      process.exit(1);
    }
  }
}
