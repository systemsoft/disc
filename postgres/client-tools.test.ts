/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * On-demand PostgreSQL client tools (pg_dump, pg_restore, psql, pg_dumpall).
 *
 * Zonky's embedded server builds ship only `initdb`, `pg_ctl` and `postgres`,
 * so `disc db dump|restore` and `disc pg upgrade` download a full build from
 * theseus-rs/postgresql-binaries on first use. These tests pin the manifest,
 * platform mapping and checksum verification with a mocked `fetch`.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { sha256Hex } from "../lib/crypto.ts";
import { clientToolsManifest, pgToolPath, PostgresClientTools, readDataDirVersion, type ClientToolsManifest } from "./client-tools.ts";

/*** HELPER ------------------------------------------- ***/

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"];

/** Build a tar.gz shaped like a theseus release: `<top>/bin/pg_dump`, `psql`, … */
async function buildFakeArchive(topDir: string): Promise<Uint8Array> {
  const root = await Deno.makeTempDir({ prefix: "disc-client-fake-" });

  try {
    const binDir = join(root, topDir, "bin");
    await Deno.mkdir(binDir, { recursive: true });

    for (const tool of ["pg_dump", "pg_dumpall", "pg_restore", "psql"]) {
      await Deno.writeTextFile(join(binDir, tool), `#!/bin/sh\necho ${tool}\n`);
      await Deno.chmod(join(binDir, tool), 0o755);
    }

    const archive = join(root, "archive.tar.gz");
    const tar = await new Deno.Command("tar", { args: ["-czf", archive, "-C", root, topDir] }).output();
    assert(tar.success, "tar -czf failed while building the fake archive");

    return await Deno.readFile(archive);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A `fetch` stand-in that serves `body` and records the requested URLs. */
function mockFetch(body: Uint8Array, calls: string[], status = 200): typeof fetch {
  return ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response(body as BodyInit, { status }));
  }) as typeof fetch;
}

async function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get(key);

  if (value === undefined)
    Deno.env.delete(key);
  else
    Deno.env.set(key, value);

  try {
    await fn();
  } finally {
    if (previous === undefined)
      Deno.env.delete(key);
    else
      Deno.env.set(key, previous);
  }
}

/*** RUNTIME ------------------------------------------ ***/

Deno.test("clientToolsManifest - every bundled server version resolves for every platform", () => {
  for (const serverVersion of ["16.4", "17.0", "18.4"]) {
    for (const platform of PLATFORMS) {
      const manifest = clientToolsManifest(serverVersion, platform);
      assertExists(manifest, `no client tools for ${serverVersion} on ${platform}`);
      assertEquals(manifest.platform, platform);
      assertEquals(manifest.serverMajor, serverVersion.split(".")[0]);
      assertEquals(manifest.release.startsWith(`${serverVersion}.`), true, `${manifest.release} is not a build of ${serverVersion}`);
      assertEquals(/^[0-9a-f]{64}$/.test(manifest.sha256), true, `bad sha256 for ${serverVersion} ${platform}`);
    }
  }
});

Deno.test("clientToolsManifest - builds the theseus-rs release URL from the target triple", () => {
  const manifest = clientToolsManifest("18.4", "darwin-arm64");

  assertEquals(
    manifest?.url,
    "https://github.com/theseus-rs/postgresql-binaries/releases/download/18.4.0/postgresql-18.4.0-aarch64-apple-darwin.tar.gz"
  );
  assertEquals(manifest?.sha256, "1b68828f524b638a24918e258b173d0f16773547a0d3b83d9ba74473b61649f2");
});

Deno.test("clientToolsManifest - maps each platform to its glibc/msvc target triple", () => {
  const triples: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "windows-x64": "x86_64-pc-windows-msvc"
  };

  for (const [platform, triple] of Object.entries(triples)) {
    const manifest = clientToolsManifest("17.0", platform);
    assertStringIncludes(manifest!.url, `/17.0.1/postgresql-17.0.1-${triple}.tar.gz`);
  }
});

Deno.test("clientToolsManifest - accepts a bare major version (as found in PG_VERSION)", () => {
  assertEquals(clientToolsManifest("16", "linux-x64")?.release, "16.4.1");
  assertEquals(clientToolsManifest("18", "linux-x64")?.release, "18.4.0");
});

Deno.test("clientToolsManifest - an older server uses the oldest newer client (pg_dump reads older servers)", () => {
  assertEquals(clientToolsManifest("15", "linux-x64")?.release, "16.4.1");
  assertEquals(clientToolsManifest("14.9", "darwin-arm64")?.serverMajor, "16");
});

Deno.test("clientToolsManifest - a server newer than every published client is unsupported", () => {
  assertEquals(clientToolsManifest("19.0", "linux-x64"), null);
});

Deno.test("clientToolsManifest - unknown platform or unparseable version returns null", () => {
  assertEquals(clientToolsManifest("18.4", "freebsd-x64"), null);
  assertEquals(clientToolsManifest("latest", "linux-x64"), null);
});

Deno.test("pgToolPath - appends .exe on Windows only", () => {
  assertEquals(pgToolPath(join("a", "bin"), "pg_dump", "darwin"), join("a", "bin", "pg_dump"));
  assertEquals(pgToolPath(join("a", "bin"), "psql", "windows"), join("a", "bin", "psql.exe"));
});

Deno.test("readDataDirVersion - reads PG_VERSION, null when absent", async () => {
  const dir = await Deno.makeTempDir();

  try {
    assertEquals(await readDataDirVersion(dir), null);
    await Deno.writeTextFile(join(dir, "PG_VERSION"), "16\n");
    assertEquals(await readDataDirVersion(dir), "16");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - ensure() reuses a cached install without fetching", async () => {
  const baseDir = await Deno.makeTempDir();
  const calls: string[] = [];

  try {
    const binDir = join(baseDir, "18.4.0", "bin");
    await Deno.mkdir(binDir, { recursive: true });
    await Deno.writeTextFile(join(binDir, "pg_dump"), "");

    const tools = new PostgresClientTools({ baseDir, fetch: mockFetch(new Uint8Array(), calls), platform: "darwin-arm64" });
    assertEquals(await tools.ensure("18.4"), binDir);
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - install() verifies the checksum, extracts and flattens the release dir", async () => {
  const baseDir = await Deno.makeTempDir();
  const calls: string[] = [];

  try {
    const body = await buildFakeArchive("postgresql-18.4.0-aarch64-apple-darwin");
    const manifest: ClientToolsManifest = {
      platform: "darwin-arm64",
      release: "18.4.0",
      serverMajor: "18",
      sha256: await sha256Hex(body),
      url: "https://example.invalid/postgresql-18.4.0-aarch64-apple-darwin.tar.gz"
    };
    const tools = new PostgresClientTools({ baseDir, fetch: mockFetch(body, calls), platform: "darwin-arm64" });
    const binDir = await (tools as any).install(manifest);

    assertEquals(binDir, join(baseDir, "18.4.0", "bin"));
    assertEquals(calls, [manifest.url]);

    for (const tool of ["pg_dump", "pg_dumpall", "pg_restore", "psql"])
      assertEquals((await Deno.stat(join(binDir, tool))).isFile, true, `${tool} missing`);

    /*** Only the release dir remains — no staging dirs or archives left behind. ***/
    const entries = [];

    for await (const entry of Deno.readDir(baseDir))
      entries.push(entry.name);

    assertEquals(entries, ["18.4.0"]);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - install() rejects a checksum mismatch and caches nothing", async () => {
  const baseDir = await Deno.makeTempDir();

  try {
    const body = await buildFakeArchive("postgresql-18.4.0-aarch64-apple-darwin");
    const manifest: ClientToolsManifest = {
      platform: "darwin-arm64",
      release: "18.4.0",
      serverMajor: "18",
      sha256: "0".repeat(64),
      url: "https://example.invalid/postgresql-18.4.0-aarch64-apple-darwin.tar.gz"
    };
    const tools = new PostgresClientTools({ baseDir, fetch: mockFetch(body, []), platform: "darwin-arm64" });

    await assertRejects(() => (tools as any).install(manifest), Error, "Checksum mismatch");

    const entries = [];

    for await (const entry of Deno.readDir(baseDir))
      entries.push(entry.name);

    assertEquals(entries, []);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - ensure() rejects a tampered download of the pinned release", async () => {
  const baseDir = await Deno.makeTempDir();
  const calls: string[] = [];

  try {
    const tools = new PostgresClientTools({ baseDir, fetch: mockFetch(new TextEncoder().encode("not postgres"), calls), platform: "linux-x64" });

    await assertRejects(() => tools.ensure("17.0"), Error, "Checksum mismatch");
    assertEquals(calls, [clientToolsManifest("17.0", "linux-x64")!.url]);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - HTTP failure surfaces the URL and the --pg-bin-dir escape hatch", async () => {
  const baseDir = await Deno.makeTempDir();

  try {
    const tools = new PostgresClientTools({ baseDir, fetch: mockFetch(new Uint8Array(), [], 404), platform: "linux-x64" });
    const err = await assertRejects(() => tools.ensure("18.4"), Error);

    assertStringIncludes(err.message, "HTTP 404");
    assertStringIncludes(err.message, "--pg-bin-dir");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - network failure (offline) gives a clear error", async () => {
  const baseDir = await Deno.makeTempDir();

  try {
    const failing = (() => Promise.reject(new TypeError("error sending request: dns error"))) as typeof fetch;
    const tools = new PostgresClientTools({ baseDir, fetch: failing, platform: "linux-x64" });
    const err = await assertRejects(() => tools.ensure("18.4"), Error);

    assertStringIncludes(err.message, "Could not download PostgreSQL client tools");
    assertStringIncludes(err.message, "dns error");
    assertStringIncludes(err.message, "--pg-bin-dir");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - DISC_OFFLINE=1 refuses to download and names the staging path", async () => {
  const baseDir = await Deno.makeTempDir();
  const calls: string[] = [];

  try {
    await withEnv("DISC_OFFLINE", "1", async () => {
      const tools = new PostgresClientTools({ baseDir, fetch: mockFetch(new Uint8Array(), calls), platform: "linux-x64" });
      const err = await assertRejects(() => tools.ensure("18.4"), Error);

      assertStringIncludes(err.message, "DISC_OFFLINE=1");
      assertStringIncludes(err.message, join(baseDir, "18.4.0"));
    });

    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("PostgresClientTools - unsupported server version names the escape hatch", async () => {
  const tools = new PostgresClientTools({ baseDir: "/nonexistent", fetch: mockFetch(new Uint8Array(), []), platform: "linux-x64" });
  const err = await assertRejects(() => tools.ensure("19.1"), Error);

  assertStringIncludes(err.message, "19.1");
  assertStringIncludes(err.message, "--pg-bin-dir");
});

Deno.test("PostgresClientTools - default cache lives under $DISC_HOME/postgres-client", async () => {
  await withEnv("DISC_HOME", "/opt/disc-home", () => {
    const tools = new PostgresClientTools();
    assertEquals((tools as unknown as { baseDir: string; }).baseDir, join("/opt/disc-home", "postgres-client"));
    return Promise.resolve();
  });
});
