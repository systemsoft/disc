/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { extractEmbeddedSdkWithEntries, type EmbeddedSdkEntry } from "./sdk-extractor.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("extractEmbeddedSdk - first run writes every entry + marker", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-sdk-extractor-first-" });

  try {
    const { entries } = await makeFakeSdkSources(tmp);
    const targetDir = join(tmp, "out", "sdk");
    const result = await extractEmbeddedSdkWithEntries(targetDir, "2026.05.07", entries);

    assertEquals(result.alreadyExtracted, false);
    assertEquals(result.extracted, 3);
    assertEquals(result.targetDir, targetDir);

    /*** Files written ***/
    const client = await Deno.readTextFile(join(targetDir, "client.ts"));
    assertStringIncludes(client, "CLIENT");

    const mod = await Deno.readTextFile(join(targetDir, "mod.ts"));
    assertStringIncludes(mod, "./client.ts");

    /*** Marker pinned to the supplied version ***/
    const marker = await Deno.readTextFile(join(targetDir, ".disc-sdk-marker"));
    assertEquals(marker.trim(), "2026.05.07");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extractEmbeddedSdk - second run with same version is a no-op", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-sdk-extractor-noop-" });

  try {
    const { entries } = await makeFakeSdkSources(tmp);
    const targetDir = join(tmp, "out", "sdk");
    const first = await extractEmbeddedSdkWithEntries(targetDir, "2026.05.07", entries);
    assertEquals(first.alreadyExtracted, false);
    assertEquals(first.extracted, 3);

    /*** Mutate one of the extracted files to prove the no-op path doesn’t re-write — the user’s
         manual changes survive a second codegen run when the binary version hasn’t changed. ***/
    await Deno.writeTextFile(join(targetDir, "client.ts"), "// user edited\n");

    const second = await extractEmbeddedSdkWithEntries(targetDir, "2026.05.07", entries);
    assertEquals(second.alreadyExtracted, true);
    assertEquals(second.extracted, 0);

    /*** Manual edit preserved ***/
    const client = await Deno.readTextFile(join(targetDir, "client.ts"));
    assertEquals(client, "// user edited\n");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extractEmbeddedSdk - marker with different version triggers re-extract", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-sdk-extractor-version-bump-" });

  try {
    const { entries } = await makeFakeSdkSources(tmp);
    const targetDir = join(tmp, "out", "sdk");

    /*** Seed an "older" extraction. ***/
    const first = await extractEmbeddedSdkWithEntries(targetDir, "2026.05.06", entries);
    assertEquals(first.alreadyExtracted, false);

    /*** User modifies a file; should be overwritten when the binary version bumps because the SDK
         might have changed shape. ***/
    await Deno.writeTextFile(join(targetDir, "client.ts"), "// stale user edit\n");

    const second = await extractEmbeddedSdkWithEntries(targetDir, "2026.05.07", entries);
    assertEquals(second.alreadyExtracted, false);
    assertEquals(second.extracted, 3);

    /*** Marker advanced to the new version ***/
    const marker = await Deno.readTextFile(join(targetDir, ".disc-sdk-marker"));
    assertEquals(marker.trim(), "2026.05.07");

    /*** The "stale user edit" was overwritten with the embedded source ***/
    const client = await Deno.readTextFile(join(targetDir, "client.ts"));
    assertStringIncludes(client, "CLIENT");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extractEmbeddedSdk - empty manifest still writes marker", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-sdk-extractor-empty-" });

  try {
    const targetDir = join(tmp, "out", "sdk");
    const result = await extractEmbeddedSdkWithEntries(targetDir, "2026.05.07", []);

    assertEquals(result.alreadyExtracted, false);
    assertEquals(result.extracted, 0);

    const marker = await Deno.readTextFile(join(targetDir, ".disc-sdk-marker"));
    assertEquals(marker.trim(), "2026.05.07");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/*** HELPER ------------------------------------------- ***/

/**
 * Build a small synthetic SDK source tree under `tmp/src/` and return
 * the manifest entries that point at it. Mirrors what the real
 * `EMBEDDED_SDK_MANIFEST` looks like at runtime — `sourceUrl` is a
 * `file://` URL and `relPath` is the path inside `<targetDir>/`.
 */
async function makeFakeSdkSources(tmp: string): Promise<{ entries: EmbeddedSdkEntry[]; sourceDir: string; }> {
  const sourceDir = join(tmp, "src");
  await Deno.mkdir(sourceDir, { recursive: true });

  const files = {
    "client.ts": "export const CLIENT = true;\n",
    "errors.ts": "export class DiscError extends Error {}\n",
    "mod.ts": "export * from \"./client.ts\";\n"
  };

  const entries: EmbeddedSdkEntry[] = [];

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(sourceDir, rel);
    await Deno.writeTextFile(abs, content);

    entries.push({
      mode: 0o644,
      relPath: rel,
      sourceUrl: new URL(`file://${abs}`)
    });
  }

  return { entries, sourceDir };
}
