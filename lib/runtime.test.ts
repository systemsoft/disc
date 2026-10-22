/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import { runtimeExecutable } from "./runtime.ts";

Deno.test("runtimeExecutable is the running runtime (deno or ende) when Disc runs from source", () => {
  assertEquals(runtimeExecutable(false), Deno.execPath());
});

Deno.test("runtimeExecutable falls back to deno on PATH inside a compiled binary", () => {
  assertEquals(runtimeExecutable(true), "deno");
});
