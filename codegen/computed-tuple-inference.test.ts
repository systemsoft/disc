/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import { inferComputedTupleFields } from "./computed-tuple-inference.ts";

Deno.test("inferComputedTupleFields — named tuple of aggregates infers int64 fields", () => {
  const fields = inferComputedTupleFields(
    "(videos := count(.<channel[is Video]), posts := count(.<channel[is Post]))"
  );
  assertEquals(fields, { videos: "int64", posts: "int64" });
});

Deno.test("inferComputedTupleFields — sum over a backlink scalar infers int64", () => {
  const fields = inferComputedTupleFields(
    "(bytes := sum(.<creator[is Video].size))"
  );
  assertEquals(fields, { bytes: "int64" });
});

Deno.test("inferComputedTupleFields — drops fields whose type can't be inferred", () => {
  // `.name` (a path) isn't inferable in v1; the count field still is.
  const fields = inferComputedTupleFields(
    "(n := count(.<channel[is Video]), label := .name)"
  );
  assertEquals(fields, { n: "int64" });
});

Deno.test("inferComputedTupleFields — non-tuple computed returns null", () => {
  assertEquals(inferComputedTupleFields("count(.<channel[is Video])"), null);
  assertEquals(inferComputedTupleFields(".<channels[is Customer]"), null);
});
