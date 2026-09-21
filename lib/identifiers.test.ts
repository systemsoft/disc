/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import { fitIdentifier, linkColumnName, PG_MAX_IDENTIFIER_BYTES } from "./identifiers.ts";

Deno.test("linkColumnName is the snake_case link name plus _id", () => {
  assertEquals(linkColumnName("program"), "program_id");
  assertEquals(linkColumnName("payoutAddress"), "payout_address_id");
});

Deno.test("fitIdentifier keeps a name that fits, including one of exactly 63 bytes", () => {
  assertEquals(fitIdentifier("uk_git_object_program_id_object_id"), "uk_git_object_program_id_object_id");

  const exact = "x".repeat(PG_MAX_IDENTIFIER_BYTES);
  assertEquals(fitIdentifier(exact), exact);
});

Deno.test("fitIdentifier truncates a long name to 63 bytes and appends a stable hash", () => {
  const long = `uk_${"a".repeat(80)}`;
  const fitted = fitIdentifier(long);

  assertEquals(fitted.length, PG_MAX_IDENTIFIER_BYTES);
  assertEquals(/^uk_a+_[0-9a-f]{8}$/.test(fitted), true);
  assertEquals(fitIdentifier(long), fitted);
  assertEquals(fitIdentifier(`${long}b`) === fitted, false);
});

Deno.test("fitIdentifier measures bytes, not characters", () => {
  const fitted = fitIdentifier(`idx_${"é".repeat(40)}`);

  assertEquals(new TextEncoder().encode(fitted).length <= PG_MAX_IDENTIFIER_BYTES, true);
  assertEquals(/_[0-9a-f]{8}$/.test(fitted), true);
});
