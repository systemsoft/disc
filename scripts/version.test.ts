/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the ChronVer bump logic behind `deno task version:bump`.
 *
 * ChronVer is `YYYY.MM.DD[.CHANGESET][-FEATURE|-break]` (chronver.org). The
 * script used to write the bare date unconditionally, so a second release on
 * one day silently reused the first one's version until someone hand-edited
 * a changeset in. These pin the increment rules.
 */

import { assertEquals } from "@std/assert";
import { dateStamp, nextVersion } from "./version.ts";

// --- dateStamp ---

Deno.test("dateStamp zero-pads month and day", () => {
  assertEquals(dateStamp(new Date(2026, 0, 5)), "2026.01.05");
  assertEquals(dateStamp(new Date(2026, 11, 31)), "2026.12.31");
});

// --- A new day ---

Deno.test("nextVersion starts a new day at the bare date", () => {
  assertEquals(nextVersion("2026.09.14", "2026.09.16"), "2026.09.16");
});

Deno.test("nextVersion drops a previous day's changeset", () => {
  assertEquals(nextVersion("2026.09.14.3", "2026.09.16"), "2026.09.16");
});

Deno.test("nextVersion handles a missing version.txt", () => {
  assertEquals(nextVersion(null, "2026.09.16"), "2026.09.16");
});

// --- Same day ---

Deno.test("nextVersion adds a changeset to the first same-day rebump", () => {
  assertEquals(nextVersion("2026.09.16", "2026.09.16"), "2026.09.16.1");
});

Deno.test("nextVersion increments an existing changeset", () => {
  assertEquals(nextVersion("2026.09.16.1", "2026.09.16"), "2026.09.16.2");
  assertEquals(nextVersion("2026.09.16.7", "2026.09.16"), "2026.09.16.8");
});

Deno.test("nextVersion carries past a single digit", () => {
  assertEquals(nextVersion("2026.09.16.9", "2026.09.16"), "2026.09.16.10");
  assertEquals(nextVersion("2026.09.16.42", "2026.09.16"), "2026.09.16.43");
});

// --- Feature labels ---

Deno.test("nextVersion replaces a same-day feature label with a changeset", () => {
  // The label described the release that already shipped; the script has no
  // way to name the new one, so it falls back to a plain changeset.
  assertEquals(nextVersion("2026.09.16-break", "2026.09.16"), "2026.09.16.1");
  assertEquals(nextVersion("2026.09.16.2-break", "2026.09.16"), "2026.09.16.3");
});

// --- Robustness ---

Deno.test("nextVersion trims surrounding whitespace", () => {
  assertEquals(nextVersion("  2026.09.16.1\n", "2026.09.16"), "2026.09.16.2");
});

Deno.test("nextVersion falls back to the bare date on an unparseable version", () => {
  // Releasing must not be blocked by a malformed file; today's date is both
  // the correct value and what the script wrote before it read anything.
  assertEquals(nextVersion("garbage", "2026.09.16"), "2026.09.16");
  assertEquals(nextVersion("", "2026.09.16"), "2026.09.16");
  assertEquals(nextVersion("3.0.1", "2026.09.16"), "2026.09.16");
});
