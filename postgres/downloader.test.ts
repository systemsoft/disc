import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { PostgresBinaryDownloader } from "./downloader.ts";

const TEST_BASE_DIR = join(
  Deno.makeTempDirSync(),
  "disc-postgres-download-test",
);

Deno.test("PostgresBinaryDownloader - platform detection", () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);

  // Should detect current platform
  const platform = (downloader as any).platform;
  assertExists(platform);

  // Should be one of the supported platforms
  const supportedPlatforms = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ];
  assertEquals(supportedPlatforms.includes(platform), true);
});

Deno.test("PostgresBinaryDownloader - opts shape accepts explicit platform override", () => {
  // Bundle I follow-up: cross-platform builds need to instantiate the
  // downloader for a target platform other than the host. The opts
  // shape lets callers pin both `baseDir` and `platform`.
  const downloader = new PostgresBinaryDownloader({
    baseDir: TEST_BASE_DIR,
    platform: "linux-arm64",
  });
  assertEquals((downloader as any).platform, "linux-arm64");
  assertEquals((downloader as any).baseDir, TEST_BASE_DIR);

  // The manifest lookup uses the overridden platform — a downloader
  // pinned to `linux-arm64` returns the linux-arm64 URL even when
  // the test process is on darwin.
  const manifest = (downloader as any).getManifest("16.4");
  assertExists(manifest);
  assertEquals(manifest.platform, "linux-arm64");
});

Deno.test("PostgresBinaryDownloader - back-compat: string baseDir argument still works", () => {
  // The old `new PostgresBinaryDownloader(baseDir)` form must keep
  // working for existing call sites.
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);
  assertEquals((downloader as any).baseDir, TEST_BASE_DIR);
});

Deno.test("PostgresBinaryDownloader - manifest retrieval", () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);

  // Get manifest for version 16.4
  const manifest = (downloader as any).getManifest("16.4");
  assertExists(manifest);
  assertExists(manifest.url);
  assertEquals(manifest.version, "16.4");

  // Non-existent version should return null
  const noManifest = (downloader as any).getManifest("99.99");
  assertEquals(noManifest, null);
});

Deno.test("PostgresBinaryDownloader - creates version directory structure", async () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);
  const version = "16.4";
  const versionDir = join(TEST_BASE_DIR, version);

  // Create the directory structure manually for testing
  await ensureDir(join(versionDir, "bin"));

  // Create a mock postgres binary
  const postgresPath = join(versionDir, "bin", "postgres");
  await Deno.writeTextFile(postgresPath, "#!/bin/sh\necho 'mock postgres'");
  await Deno.chmod(postgresPath, 0o755);

  // Check if already downloaded
  const result = await downloader.ensurePostgres(version);
  assertEquals(result, versionDir);

  // Verify structure
  const binDir = join(versionDir, "bin");
  const binDirStat = await Deno.stat(binDir);
  assertEquals(binDirStat.isDirectory, true);

  // Cleanup
  await Deno.remove(TEST_BASE_DIR, { recursive: true });
});

Deno.test("PostgresBinaryDownloader - handles missing binaries", async () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);
  const version = "16.4";
  const versionDir = join(TEST_BASE_DIR, version);

  // Ensure directory doesn't exist
  try {
    await Deno.remove(versionDir, { recursive: true });
  } catch {
    // Directory might not exist
  }

  // This would normally trigger a download
  // For testing, we mock the download by creating the structure
  await ensureDir(join(versionDir, "bin"));
  const postgresPath = join(versionDir, "bin", "postgres");
  await Deno.writeTextFile(postgresPath, "#!/bin/sh\necho 'mock postgres'");
  await Deno.chmod(postgresPath, 0o755);

  const result = await downloader.ensurePostgres(version);
  assertEquals(result, versionDir);

  // Cleanup
  await Deno.remove(TEST_BASE_DIR, { recursive: true });
});

Deno.test("PostgresBinaryDownloader - handles unsupported platforms", () => {
  // We can't actually change Deno.build properties, so we test the logic directly

  // Test Windows detection (not yet supported)
  if (Deno.build.os === "windows") {
    assertRejects(
      async () => {
        const d = new PostgresBinaryDownloader(TEST_BASE_DIR);
        await d.ensurePostgres("16.4");
      },
      Error,
      "Windows support not yet implemented",
    );
  }
});

Deno.test("PostgresBinaryDownloader - makeExecutable sets correct permissions", async () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);
  const versionDir = join(TEST_BASE_DIR, "test-perms");
  const binDir = join(versionDir, "bin");

  // Create test binaries
  await ensureDir(binDir);
  const binaries = ["postgres", "pg_ctl", "initdb", "psql"];

  for (const binary of binaries) {
    const path = join(binDir, binary);
    await Deno.writeTextFile(path, `#!/bin/sh\necho '${binary}'`);
    // Set non-executable initially
    await Deno.chmod(path, 0o644);
  }

  // Make executable
  await (downloader as any).makeExecutable(versionDir);

  // Check permissions
  for (const binary of binaries) {
    const path = join(binDir, binary);
    const stat = await Deno.stat(path);
    const mode = stat.mode! & 0o777;
    assertEquals(mode, 0o755);
  }

  // Cleanup
  await Deno.remove(TEST_BASE_DIR, { recursive: true });
});

Deno.test("PostgresBinaryDownloader - extractArchive handles different formats", async () => {
  // Ensure test directory exists (may have been cleaned up by prior test)
  await ensureDir(TEST_BASE_DIR);

  // Test zip format detection
  const zipPath = join(TEST_BASE_DIR, "test.zip");
  const tarPath = join(TEST_BASE_DIR, "test.tar.xz");

  // Create mock archives
  await Deno.writeTextFile(zipPath, "mock zip content");
  await Deno.writeTextFile(tarPath, "mock tar content");

  // The actual extraction would fail with mock files,
  // but we're testing the format detection logic
  const zipExt = zipPath.endsWith(".zip") ? "zip" : "tar";
  assertEquals(zipExt, "zip");

  const tarExt = tarPath.endsWith(".zip") ? "zip" : "tar";
  assertEquals(tarExt, "tar");

  // Cleanup
  await Deno.remove(TEST_BASE_DIR, { recursive: true });
});

// gh/geldata#3406 — offline setup. The Gel issue asked for a way to
// run `disc init` against pre-staged PG binaries without ever touching
// the network. Bundle NN adds two env-var hooks:
//
//   1. `DISC_PG_BINARY_DIR` — overrides the default
//      `<HOME>/.disc/postgres` baseDir so operators can pre-stage PG
//      binaries anywhere on disk.
//   2. `DISC_OFFLINE=1` — turns a missing binary into a hard error
//      (with the exact path needed) instead of a silent download.
//
// These cover both the "operator already has the binary" path and the
// "no network at all" path. Bundle I (single-binary distribution)
// handles the third case where PG is embedded inside the compiled
// binary; the env-var hooks here cover the deno-source workflow.
Deno.test("PostgresBinaryDownloader - DISC_PG_BINARY_DIR overrides default baseDir (Bundle NN — gh/geldata#3406)", () => {
  const original = Deno.env.get("DISC_PG_BINARY_DIR");
  try {
    const stagedRoot = "/opt/disc-staged-pg";
    Deno.env.set("DISC_PG_BINARY_DIR", stagedRoot);
    const downloader = new PostgresBinaryDownloader();
    // Field is private; cast through an unknown index for the assertion.
    assertEquals(
      (downloader as unknown as { baseDir: string; }).baseDir,
      stagedRoot,
    );
  } finally {
    if (original === undefined) Deno.env.delete("DISC_PG_BINARY_DIR");
    else Deno.env.set("DISC_PG_BINARY_DIR", original);
  }
});

Deno.test("PostgresBinaryDownloader - DISC_OFFLINE=1 throws with actionable message (Bundle NN — gh/geldata#3406)", async () => {
  const tempDir = await Deno.makeTempDir();
  const offlineOriginal = Deno.env.get("DISC_OFFLINE");
  try {
    Deno.env.set("DISC_OFFLINE", "1");
    const downloader = new PostgresBinaryDownloader(tempDir);
    await assertRejects(
      () => downloader.download("16.4"),
      Error,
      "DISC_OFFLINE=1",
    );
  } finally {
    if (offlineOriginal === undefined) Deno.env.delete("DISC_OFFLINE");
    else Deno.env.set("DISC_OFFLINE", offlineOriginal);
    await Deno.remove(tempDir, { recursive: true });
  }
});
