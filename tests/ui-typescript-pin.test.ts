/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the admin UI's `typescript` pin: `ui/update-dependencies.ts`
 * (keeps `bun run test:dependencies` from bumping it to 7) and
 * `ui/check-typescript-pin.ts` (fails `bun run check` with an explanation if
 * it gets bumped anyway).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

import { typescriptPinProblem } from "../ui/check-typescript-pin.ts";
import { packagesToUpdate } from "../ui/update-dependencies.ts";

const UI_PACKAGE_JSON = new URL("../ui/package.json", import.meta.url);
const SVELTE_CHECK_PACKAGE_JSON = new URL("../ui/node_modules/svelte-check/package.json", import.meta.url);
const SVELTE_CHECK_INSTALLED = await (async () => {
  try {
    await Deno.stat(SVELTE_CHECK_PACKAGE_JSON);
    return true;
  } catch {
    return false;
  }
})();

Deno.test("packagesToUpdate holds typescript back", () => {
  const names = packagesToUpdate({ devDependencies: { "svelte-check": "^4.7.6", typescript: "~6.0.3" } });

  assertEquals(names, ["svelte-check"]);
});

Deno.test("packagesToUpdate skips npm: aliases bun can't look up by name", () => {
  const names = packagesToUpdate({ devDependencies: { "@typescript/native": "npm:typescript@^7.0.2", vite: "^8.3.0" } });

  assertEquals(names, ["vite"]);
});

Deno.test("packagesToUpdate covers dependencies and devDependencies", () => {
  const names = packagesToUpdate({ dependencies: { codemirror: "^6.0.2" }, devDependencies: { sass: "^1.104.1" } });

  assertEquals(names, ["codemirror", "sass"]);
});

Deno.test("ui/package.json routes test:dependencies and check through the pin scripts", async () => {
  const pkg = JSON.parse(await Deno.readTextFile(UI_PACKAGE_JSON));

  assertEquals(pkg.scripts["test:dependencies"], "bun update-dependencies.ts");
  assertStringIncludes(pkg.scripts.check, "bun check-typescript-pin.ts && ");
});

// Skips when `ui/node_modules` is absent (fresh checkout); CI installs the UI
// dependencies before `deno test`.
Deno.test({
  fn: async () => {
    const svelteCheck = JSON.parse(await Deno.readTextFile(SVELTE_CHECK_PACKAGE_JSON));
    const pkg = JSON.parse(await Deno.readTextFile(UI_PACKAGE_JSON));
    const pinned = pkg.devDependencies.typescript.replace(/^[~^]/, "");

    assertEquals(typescriptPinProblem(pinned, svelteCheck.version, svelteCheck.peerDependencies.typescript), null);
  },
  ignore: !SVELTE_CHECK_INSTALLED,
  name: "ui/package.json's typescript pin satisfies the installed svelte-check"
});

Deno.test("typescriptPinProblem accepts a major inside svelte-check's peer range", () => {
  assertEquals(typescriptPinProblem("6.0.3", "4.7.6", "^5.0.0 || ^6.0.0"), null);
});

Deno.test("typescriptPinProblem explains a major outside svelte-check's peer range", () => {
  const problem = typescriptPinProblem("7.0.2", "4.7.6", "^5.0.0 || ^6.0.0");

  assertStringIncludes(problem ?? "", "svelte-check 4.7.6 only accepts typescript \"^5.0.0 || ^6.0.0\"");
  assertStringIncludes(problem ?? "", "drop the pin");
});

Deno.test("typescriptPinProblem passes TS 7 once svelte-check accepts it", () => {
  assertEquals(typescriptPinProblem("7.0.2", "5.0.0", "^6.0.0 || ^7.0.0"), null);
});
