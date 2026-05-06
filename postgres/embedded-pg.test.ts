/**
 * Tests for the embedded-PG runtime accessor (Bundle I Phase 2).
 *
 * The accessor is the bridge between the build-time manifest and the
 * runtime: it knows whether the current binary has an embedded PG, and
 * if so, ensures it's extracted under DISC_HOME and returns the bin
 * directory ready for `PostgresInstance` to use.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveEmbeddedPgBinDir } from "./embedded-pg.ts";

Deno.test("resolveEmbeddedPgBinDir - returns null when manifest is empty (no embed)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embedded-pg-" });
  try {
    const result = await resolveEmbeddedPgBinDir({
      discHome: tmp,
      manifestEntries: [],
      version: "16.4",
    });
    assertEquals(result, null);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveEmbeddedPgBinDir - extracts then returns bin dir on first call", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embedded-pg-extract-" });
  try {
    // Stage a fake "embedded" file we can resolve via file:// URL.
    const stage = await Deno.makeTempDir({ prefix: "disc-stage-" });
    const fakePostgres = join(stage, "postgres");
    await Deno.writeFile(fakePostgres, new Uint8Array([0xfa, 0xce]));

    const result = await resolveEmbeddedPgBinDir({
      discHome: tmp,
      manifestEntries: [
        {
          sourceUrl: new URL(`file://${fakePostgres}`),
          relPath: "bin/postgres",
          mode: 0o755,
        },
      ],
      version: "16.4",
    });

    assertEquals(result, join(tmp, "embedded-postgres", "16.4", "bin"));
    const bytes = await Deno.readFile(join(result!, "postgres"));
    assertEquals(Array.from(bytes), [0xfa, 0xce]);
    await Deno.remove(stage, { recursive: true });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveEmbeddedPgBinDir - second call is fast (no re-extract)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embedded-pg-fast-" });
  try {
    const stage = await Deno.makeTempDir({ prefix: "disc-stage2-" });
    const fakePostgres = join(stage, "postgres");
    await Deno.writeFile(fakePostgres, new Uint8Array([0xfa]));

    const entries = [
      {
        sourceUrl: new URL(`file://${fakePostgres}`),
        relPath: "bin/postgres",
        mode: 0o755,
      },
    ];
    await resolveEmbeddedPgBinDir({
      discHome: tmp,
      manifestEntries: entries,
      version: "16.4",
    });

    // Tamper to prove we don't re-extract.
    await Deno.writeFile(fakePostgres, new Uint8Array([0xff, 0xff]));

    const result = await resolveEmbeddedPgBinDir({
      discHome: tmp,
      manifestEntries: entries,
      version: "16.4",
    });

    const stillOriginal = await Deno.readFile(join(result!, "postgres"));
    assertEquals(Array.from(stillOriginal), [0xfa]);
    await Deno.remove(stage, { recursive: true });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
