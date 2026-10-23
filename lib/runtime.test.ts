/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ENDE_VERSION, runtimeExecutables } from "./runtime.ts";

Deno.test("runtimeExecutables is just the running runtime when Disc runs from source", () => {
  assertEquals(runtimeExecutables(false), [Deno.execPath()]);
});

Deno.test("runtimeExecutables tries ende, then deno, on PATH inside a compiled binary", () => {
  assertEquals(runtimeExecutables(true), ["ende", "deno"]);
});

for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml", "Dockerfile", "Dockerfile.bundled"]) {
  Deno.test(`${file} installs ENDE_VERSION`, async () => {
    const source = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    assertStringIncludes(source, ENDE_VERSION);
  });
}
