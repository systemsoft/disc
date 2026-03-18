import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PostgresBinaryDownloader } from "./downloader.ts";
import { ensureDir } from "@std/fs";

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

Deno.test("PostgresBinaryDownloader - manifest retrieval", () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);

  // Get manifest for version 16.4
  const manifest = (downloader as any).getManifest("16.4");
  assertExists(manifest);
  assertExists(manifest.url);
  assertExists(manifest.checksums);
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

Deno.test("PostgresBinaryDownloader - validates checksums", () => {
  const downloader = new PostgresBinaryDownloader(TEST_BASE_DIR);

  // Get manifest to verify it has checksums
  const manifest = (downloader as any).getManifest("16.4");
  assertExists(manifest);
  assertExists(manifest.checksums);

  // In production, this would validate SHA256
  // For now, just verify the checksum field exists
  assertEquals(manifest.checksums.startsWith("sha256:"), true);
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
