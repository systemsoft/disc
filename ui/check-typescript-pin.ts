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
 * and the pin, the alias and `HELD` in dependency-pins.ts can go.
 *
 * Skips silently when either package isn't installed.
 */

/*** NATIVE ------------------------------------------- ***/

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { typescriptPinProblem } from "./dependency-pins.ts";

/*** UTILITY ------------------------------------------ ***/

interface PackageJson {
  peerDependencies?: Record<string, string>;
  version: string;
}

function readInstalled(name: string): PackageJson | null {
  const url = new URL(`./node_modules/${name}/package.json`, import.meta.url);

  return existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : null;
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
