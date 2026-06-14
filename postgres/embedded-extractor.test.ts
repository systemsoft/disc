/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the embedded-PG extractor (Bundle I Phase 2).
 *
 * The extractor turns a list of `(sourceUrl, relPath, mode)` entries
 * into an on-disk PostgreSQL distribution at `<targetDir>/`. It's
 * idempotent: calling it twice with the same inputs is a no-op the
 * second time.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  extractEmbeddedPg,
  isEmbeddedPgExtracted,
  type EmbeddedPgEntry
} from "./embedded-extractor.ts";

async function makeSourceFile(
  dir: string,
  relPath: string,
  bytes: Uint8Array
): Promise<URL> {
  const full = join(dir, relPath);
  const lastSep = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
  if (lastSep > 0) {
    await Deno.mkdir(full.slice(0, lastSep), { recursive: true });
  }
  await Deno.writeFile(full, bytes);
  return new URL(`file://${full}`);
}

Deno.test("extractEmbeddedPg - writes files with correct contents and modes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-" });
  try {
    const src1 = await makeSourceFile(
      tmp,
      "src/bin/postgres",
      new Uint8Array([1, 2, 3])
    );
    const src2 = await makeSourceFile(
      tmp,
      "src/share/timezones",
      new Uint8Array([4, 5])
    );
    const target = join(tmp, "target");

    const entries: EmbeddedPgEntry[] = [
      { sourceUrl: src1, relPath: "bin/postgres", mode: 0o755 },
      { sourceUrl: src2, relPath: "share/timezones", mode: 0o644 }
    ];

    const result = await extractEmbeddedPg(target, entries);
    assertEquals(result.extracted, 2);

    const written1 = await Deno.readFile(join(target, "bin/postgres"));
    assertEquals(Array.from(written1), [1, 2, 3]);
    const written2 = await Deno.readFile(join(target, "share/timezones"));
    assertEquals(Array.from(written2), [4, 5]);

    const stat1 = await Deno.stat(join(target, "bin/postgres"));
    assertEquals((stat1.mode ?? 0) & 0o111, 0o111);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extractEmbeddedPg - idempotent: second call writes nothing when marker present", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-idem-" });
  try {
    const src = await makeSourceFile(
      tmp,
      "src/bin/postgres",
      new Uint8Array([1])
    );
    const target = join(tmp, "target");
    const entries: EmbeddedPgEntry[] = [
      { sourceUrl: src, relPath: "bin/postgres", mode: 0o755 }
    ];

    const first = await extractEmbeddedPg(target, entries);
    assertEquals(first.extracted, 1);

    const second = await extractEmbeddedPg(target, entries);
    assertEquals(second.extracted, 0);
    assertEquals(second.alreadyExtracted, true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("isEmbeddedPgExtracted - false before extract, true after", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-marker-" });
  try {
    const target = join(tmp, "target");
    assertEquals(await isEmbeddedPgExtracted(target), false);

    const src = await makeSourceFile(
      tmp,
      "src/bin/postgres",
      new Uint8Array([1])
    );
    await extractEmbeddedPg(target, [
      { sourceUrl: src, relPath: "bin/postgres", mode: 0o755 }
    ]);

    assertEquals(await isEmbeddedPgExtracted(target), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extractEmbeddedPg - re-extracts when marker is missing even if files exist", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-remarker-" });
  try {
    const src = await makeSourceFile(
      tmp,
      "src/bin/postgres",
      new Uint8Array([1])
    );
    const target = join(tmp, "target");
    const entries: EmbeddedPgEntry[] = [
      { sourceUrl: src, relPath: "bin/postgres", mode: 0o755 }
    ];

    await extractEmbeddedPg(target, entries);
    // Tamper: remove marker.
    await Deno.remove(join(target, ".disc-embedded-pg-marker"));

    const second = await extractEmbeddedPg(target, entries);
    assertEquals(second.extracted, 1);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extractEmbeddedPg - recreates symlink entries (macOS ICU libs)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-link-" });
  try {
    // The real-world shape: a versioned file plus an unversioned symlink
    // pointing at it, which PG's binaries load by the unversioned name.
    const src = await makeSourceFile(
      tmp,
      "src/lib/libicudata.77.1.dylib",
      new Uint8Array([9, 9, 9])
    );
    const target = join(tmp, "target");

    const entries: EmbeddedPgEntry[] = [
      { sourceUrl: src, relPath: "lib/libicudata.77.1.dylib", mode: 0o644 },
      { linkTarget: "libicudata.77.1.dylib", relPath: "lib/libicudata.77.dylib" }
    ];

    const result = await extractEmbeddedPg(target, entries);
    assertEquals(result.extracted, 2);

    // The symlink exists, is an actual symlink, and points at the versioned file.
    const linkPath = join(target, "lib/libicudata.77.dylib");
    const linfo = await Deno.lstat(linkPath);
    assertEquals(linfo.isSymlink, true);
    assertEquals(await Deno.readLink(linkPath), "libicudata.77.1.dylib");

    // Reading through the link resolves to the target file's bytes.
    const viaLink = await Deno.readFile(linkPath);
    assertEquals(Array.from(viaLink), [9, 9, 9]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
