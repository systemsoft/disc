/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Pure logic behind the admin UI's `typescript` pin, shared by the Bun entry
 * points `check-typescript-pin.ts` and `update-dependencies.ts`.
 *
 * Kept free of imports so the Disc test suite can load it: the entry points
 * use `node:` built-ins, which Ende does not support.
 */

/*** UTILITY ------------------------------------------ ***/

/** Drop `typescript` from here once svelte-check accepts TS 7 (see check-typescript-pin.ts). */
const HELD = ["typescript"];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Leading major of each `||` alternative: `"^5.0.0 || ^6.0.0"` → `[5, 6]`. */
function rangeMajors(range: string): number[] {
  return range.split("||").map(part => Number(part.match(/\d+/)?.[0]));
}

/*** EXPORT ------------------------------------------- ***/

export function packagesToUpdate(pkg: PackageJson): string[] {
  const specs = { ...pkg.dependencies, ...pkg.devDependencies };

  return Object.keys(specs).filter(name => !HELD.includes(name) && !specs[name].startsWith("npm:"));
}

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
    `Once svelte-check's peer range accepts TS 7, drop the pin, the alias and HELD in ui/dependency-pins.ts.`
  ]
    .join("\n");
}
