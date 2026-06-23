/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import {
  AVAILABLE_PLATFORMS,
  BuildCommand,
  generateEmbeddedPgManifest,
  generateEmbeddedSdkManifest,
  generateUiManifest,
  platformPgStagingDir,
  refreshEmbeddedPgManifest,
  refreshEmbeddedSdkManifest,
  runUiBuild,
  shouldRefreshUiManifest
} from "./build.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("shouldRefreshUiManifest - false for a routine build (no flag, no env)", () => {
  assertEquals(shouldRefreshUiManifest({}, () => undefined), false);
  assertEquals(shouldRefreshUiManifest({ release: false }, () => undefined), false);
});

Deno.test("shouldRefreshUiManifest - true when --release is set", () => {
  assertEquals(shouldRefreshUiManifest({ release: true }, () => undefined), true);
});

Deno.test("shouldRefreshUiManifest - true when DISC_BUILD_REFRESH_MANIFEST=1 (CI opt-in)", () => {
  const env = (key: string) => (key === "DISC_BUILD_REFRESH_MANIFEST" ? "1" : undefined);
  assertEquals(shouldRefreshUiManifest({}, env), true);
});

Deno.test("shouldRefreshUiManifest - env values other than \"1\" do not trigger a refresh", () => {
  const env = (key: string) => (key === "DISC_BUILD_REFRESH_MANIFEST" ? "true" : undefined);
  assertEquals(shouldRefreshUiManifest({}, env), false);
});

Deno.test("BuildCommand - maps linux-x64 to x86_64-unknown-linux-gnu", () => {
  const command = new BuildCommand();
  assertEquals(command.mapPlatform("linux-x64"), "x86_64-unknown-linux-gnu");
});

Deno.test("BuildCommand - maps darwin-arm64 to aarch64-apple-darwin", () => {
  const command = new BuildCommand();
  assertEquals(command.mapPlatform("darwin-arm64"), "aarch64-apple-darwin");
});

Deno.test("BuildCommand - maps windows-x64 to x86_64-pc-windows-msvc", () => {
  const command = new BuildCommand();
  assertEquals(command.mapPlatform("windows-x64"), "x86_64-pc-windows-msvc");
});

Deno.test("BuildCommand - rejects invalid platform with helpful message", () => {
  const command = new BuildCommand();
  /*** windows-arm64 is intentionally unsupported: `deno compile` has no
       aarch64-pc-windows target and Zonky ships no windows-arm64 PG. ***/
  assertThrows(() => command.validatePlatform("windows-arm64"), Error, "Invalid platform");
});

Deno.test("BuildCommand - default output path is ./disc", () => {
  const command = new BuildCommand();
  const path = command.resolveOutputPath(undefined, undefined);
  assertEquals(path, "./disc");
});

Deno.test("BuildCommand - output path includes platform suffix when cross-compiling", () => {
  const command = new BuildCommand();
  const path = command.resolveOutputPath(undefined, "linux-x64");
  assertEquals(path, "./disc-linux-x64");
});

Deno.test("BuildCommand - windows output path gets a .exe suffix", () => {
  const command = new BuildCommand();
  /*** `deno compile --target x86_64-pc-windows-msvc` writes a `.exe`; the resolved path must match
       so the size report and CI artifact name line up with the real file. ***/
  const path = command.resolveOutputPath(undefined, "windows-x64");
  assertEquals(path, "./disc-windows-x64.exe");
});

Deno.test("BuildCommand - available platforms list contains all 5 platforms", () => {
  assertEquals(AVAILABLE_PLATFORMS.length, 5);
  assertEquals(AVAILABLE_PLATFORMS.includes("darwin-arm64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("darwin-x64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("linux-arm64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("linux-x64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("windows-x64"), true);
});

Deno.test("generateUiManifest - emits manifest from build dir contents", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-manifest-" });

  try {
    const buildDir = join(tmp, "ui", "build");
    await Deno.mkdir(join(buildDir, "_app", "immutable"), { recursive: true });
    await Deno.writeTextFile(join(buildDir, "index.html"), "<html/>");
    await Deno.writeTextFile(join(buildDir, "_app", "version.json"), "{}");
    await Deno.writeTextFile(join(buildDir, "_app", "immutable", "app.abc.js"), "/*js*/");

    const generated = await generateUiManifest(buildDir);

    assertStringIncludes(generated, "_app/immutable/app.abc.js");
    assertStringIncludes(generated, "_app/version.json");
    assertStringIncludes(generated, "index.html");
    assertStringIncludes(generated, "UI_ASSET_MANIFEST");
    assertStringIncludes(generated, "UI_ASSET_SET");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runUiBuild - skips cleanly when ui/ directory is missing", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-build-no-ui-" });

  try {
    const result = await runUiBuild(tmp);
    assertEquals(result.ran, false);
    assertStringIncludes(result.reason ?? "", "ui directory not found");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runUiBuild - skips cleanly when bun is not on PATH", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-build-no-bun-" });

  try {
    /*** Create a `ui/` dir so we get past the first guard, then nuke PATH so the bun lookup fails
         deterministically — covers the "bun missing on a clean CI image" case without depending on
         the host’s PATH content. ***/
    await Deno.mkdir(join(tmp, "ui"));
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", "");

    try {
      const result = await runUiBuild(tmp);
      assertEquals(result.ran, false);
      assertStringIncludes(result.reason ?? "", "bun");
    } finally {
      Deno.env.set("PATH", originalPath);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("generateUiManifest - throws when build dir is empty", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-manifest-empty-" });

  try {
    const buildDir = join(tmp, "ui", "build");
    let threw = false;
    await Deno.mkdir(buildDir, { recursive: true });

    try {
      await generateUiManifest(buildDir);
    } catch (err) {
      threw = true;
      assertStringIncludes((err as Error).message, "no UI build artifacts");
    }

    assertEquals(threw, true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("generateEmbeddedPgManifest - empty manifest when source dir absent", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-pg-empty-" });

  try {
    const generated = await generateEmbeddedPgManifest({
      manifestDir: join(tmp, "postgres"),
      pgVersion: "16.4",
      sourceDir: join(tmp, "does-not-exist")
    });

    assertStringIncludes(generated, "EMBEDDED_PG_MANIFEST");
    assertStringIncludes(generated, "[]");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("generateEmbeddedPgManifest - emits import.meta.resolve URLs + correct mode", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-pg-list-" });

  try {
    const sourceDir = join(tmp, "pg");
    const manifestDir = join(tmp, "postgres");
    await Deno.mkdir(join(sourceDir, "bin"), { recursive: true });
    await Deno.mkdir(join(sourceDir, "share"), { recursive: true });
    await Deno.mkdir(manifestDir, { recursive: true });
    await Deno.writeTextFile(join(sourceDir, "bin", "postgres"), "fake");
    await Deno.writeTextFile(join(sourceDir, "share", "tz.txt"), "fake");

    const generated = await generateEmbeddedPgManifest({
      manifestDir,
      pgVersion: "16.4",
      sourceDir
    });

    assertStringIncludes(generated, "\"bin/postgres\"");
    assertStringIncludes(generated, "\"share/tz.txt\"");
    /*** bin/* gets executable mode ***/
    assertStringIncludes(generated, "0o755");
    /*** non-bin gets 0o644 ***/
    assertStringIncludes(generated, "0o644");
    /*** sourceUrl uses import.meta.resolve so deno compile’s VFS catches the read at runtime — bare
         absolute file:// URLs miss the VFS because Deno only remaps URLs derived from
         module resolution. ***/
    assertStringIncludes(generated, `import.meta.resolve("../pg/bin/postgres")`);
    assertStringIncludes(generated, `import.meta.resolve("../pg/share/tz.txt")`);
    /*** The old absolute-file:// form must be gone. ***/
    assertEquals(generated.includes(`file://${sourceDir}`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("generateEmbeddedPgManifest - emits symlink entries with linkTarget, not bytes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-pg-link-" });

  try {
    const sourceDir = join(tmp, "pg");
    const manifestDir = join(tmp, "postgres");
    await Deno.mkdir(join(sourceDir, "lib"), { recursive: true });
    await Deno.mkdir(manifestDir, { recursive: true });
    /*** A versioned ICU lib plus the unversioned symlink PG loads by name. ***/
    await Deno.writeTextFile(join(sourceDir, "lib", "libicudata.77.1.dylib"), "icu");
    await Deno.symlink(
      "libicudata.77.1.dylib",
      join(sourceDir, "lib", "libicudata.77.dylib")
    );

    const generated = await generateEmbeddedPgManifest({
      manifestDir,
      pgVersion: "18.4",
      sourceDir
    });

    /*** The real file is embedded with a sourceUrl. ***/
    assertStringIncludes(generated, `import.meta.resolve("../pg/lib/libicudata.77.1.dylib")`);
    /*** The symlink becomes a linkTarget entry — no embedded bytes. ***/
    assertStringIncludes(generated, `linkTarget: "libicudata.77.1.dylib"`);
    assertStringIncludes(generated, "\"lib/libicudata.77.dylib\"");
    /*** The symlink path itself must NOT be embedded as a file. ***/
    assertEquals(generated.includes(`import.meta.resolve("../pg/lib/libicudata.77.dylib")`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("BuildCommand.buildCompileArgs - includes PG paths when supplied", () => {
  const command = new BuildCommand();

  const args = command.buildCompileArgs({}, [
    "/abs/pg/bin/postgres",
    "/abs/pg/lib/libpq.dylib"
  ]);

  assertEquals(args.includes("/abs/pg/bin/postgres"), true);
  assertEquals(args.includes("/abs/pg/lib/libpq.dylib"), true);

  /*** Each --include path is preceded by a literal "--include" arg. ***/
  for (const path of ["/abs/pg/bin/postgres", "/abs/pg/lib/libpq.dylib"]) {
    const i = args.indexOf(path);
    assertEquals(args[i - 1], "--include");
  }
});

Deno.test("BuildCommand.buildCompileArgs - --no-check flag is set", () => {
  const command = new BuildCommand();
  const args = command.buildCompileArgs({});
  assertEquals(args.includes("--no-check"), true);
});

Deno.test("BuildCommand.buildCompileArgs - --lite skips ui/build but PG paths still included", () => {
  const command = new BuildCommand();
  const args = command.buildCompileArgs({ lite: true }, ["/pg/bin/postgres"]);
  assertEquals(args.includes("ui/build"), false);
  assertEquals(args.includes("/pg/bin/postgres"), true);
});

Deno.test("generateUiManifest - emits sorted, posix-style paths even on backslashed inputs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-manifest-sort-" });

  try {
    const buildDir = join(tmp, "ui", "build");
    await Deno.mkdir(join(buildDir, "z"), { recursive: true });
    await Deno.mkdir(join(buildDir, "a"), { recursive: true });
    await Deno.writeTextFile(join(buildDir, "z", "z.js"), "");
    await Deno.writeTextFile(join(buildDir, "a", "a.js"), "");

    const generated = await generateUiManifest(buildDir);
    const aIdx = generated.indexOf("\"a/a.js\"");
    const zIdx = generated.indexOf("\"z/z.js\"");
    assertEquals(aIdx > 0, true);
    assertEquals(zIdx > aIdx, true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/*** --- Bundle I follow-up — cross-platform reproducible builds --- ***/

Deno.test("platformPgStagingDir - returns dist/embedded-pg/<platform>/<version>/", () => {
  const path = platformPgStagingDir("/repo", "linux-x64", "16.4");
  assertEquals(path, "/repo/dist/embedded-pg/linux-x64/16.4");
});

Deno.test("platformPgStagingDir - composes for every supported platform", () => {
  for (const platform of AVAILABLE_PLATFORMS) {
    const path = platformPgStagingDir("/r", platform, "17.0");
    assertEquals(path.endsWith(`/${platform}/17.0`), true);
  }
});

/*** A "complete" PG distribution for test purposes: enough files to clear the minimum-file-count
     threshold + includes bin/postgres + a few share/timezone entries (PG init needs these). Builds
     the path list with a fake staging root so the gate only inspects the strings, not
     the filesystem. ***/
function fakePgPaths(stagingDir: string, fileCount: number): string[] {
  const paths: string[] = [
    `${stagingDir}/bin/postgres`,
    `${stagingDir}/bin/initdb`,
    `${stagingDir}/bin/pg_ctl`,
    `${stagingDir}/share/timezone/UTC`,
    `${stagingDir}/share/extension/plpgsql.control`
  ];

  /*** Pad with fake share/ files until we hit the target count. ***/
  for (let i = 0; paths.length < fileCount; i++) {
    paths.push(`${stagingDir}/share/timezone/zone-${i}`);
  }

  return paths;
}

Deno.test("assertEmbeddedPgPresent - throws when --platform set and 0 files staged", () => {
  const command = new BuildCommand();
  let threw = false;

  try {
    command.assertEmbeddedPgPresent({ platform: "linux-x64" }, [], "/dist/embedded-pg/linux-x64/16.4");
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "0 embedded PG files");
    assertStringIncludes((err as Error).message, "linux-x64");
    assertStringIncludes((err as Error).message, "DISC_BUILD_NO_BUNDLE_PG");
  }

  assertEquals(threw, true, "assertEmbeddedPgPresent must throw when --platform is set and 0 files were staged.");
});

Deno.test("assertEmbeddedPgPresent - throws when --platform set and bin/postgres missing", () => {
  const command = new BuildCommand();
  /*** Plenty of files but bin/postgres absent — partial extraction. The embedded PG is useless
       without the postgres binary itself. ***/
  const paths: string[] = [];
  let threw = false;

  for (let i = 0; i < 100; i++) {
    paths.push(`/staging/share/timezone/zone-${i}`);
  }

  try {
    command.assertEmbeddedPgPresent({ platform: "linux-x64" }, paths, "/staging");
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "bin/postgres");
    assertStringIncludes((err as Error).message, "linux-x64");
  }

  assertEquals(threw, true, "assertEmbeddedPgPresent must throw when bin/postgres is missing from the embedded paths.");
});

Deno.test("assertEmbeddedPgPresent - throws when --platform set and file count below threshold", () => {
  const command = new BuildCommand();
  /*** bin/postgres present but only 3 files total — partial extract. A real PG distribution has
       hundreds of files (timezone data, extensions, locale data); 3 means most of share/
       never landed. ***/
  const paths = [
    "/staging/bin/postgres",
    "/staging/bin/initdb",
    "/staging/bin/pg_ctl"
  ];

  let threw = false;

  try {
    command.assertEmbeddedPgPresent({ platform: "linux-x64" }, paths, "/staging");
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "only 3 embedded PG files");
    assertStringIncludes((err as Error).message, "linux-x64");
    assertStringIncludes((err as Error).message, "partial extraction");
  }

  assertEquals(threw, true, "assertEmbeddedPgPresent must throw when file count is far below a real PG distribution’s count.");
});

Deno.test("assertEmbeddedPgPresent - no-op when --platform set and full PG distribution", () => {
  const command = new BuildCommand();
  /*** No throw expected — bin/postgres present + ample files. ***/
  command.assertEmbeddedPgPresent({ platform: "linux-x64" }, fakePgPaths("/staging", 137), "/staging");
});

Deno.test("assertEmbeddedPgPresent - accepts bin/postgres.exe for a windows target", () => {
  const command = new BuildCommand();
  /*** Windows PG ships `bin/postgres.exe`, not `bin/postgres`; the gate must recognize it or every
       windows-x64 release build would fail the "missing bin/postgres" check. ***/
  const paths = [
    "/staging/bin/postgres.exe",
    "/staging/bin/initdb.exe",
    "/staging/bin/pg_ctl.exe"
  ];

  for (let i = 0; paths.length < 137; i++) {
    paths.push(`/staging/share/timezone/zone-${i}`);
  }

  command.assertEmbeddedPgPresent({ platform: "windows-x64" }, paths, "/staging");
});

Deno.test("assertEmbeddedPgPresent - no-op when no --platform (host build)", () => {
  const command = new BuildCommand();
  /*** Host builds should never throw — local dev without PG cache is expected (the binary downloads
       PG on first run). ***/
  command.assertEmbeddedPgPresent({}, [], "/missing");
  command.assertEmbeddedPgPresent({}, fakePgPaths("/staging", 137), "/has-files");
  /*** Even a partial / incomplete cache shouldn’t fail a host build. ***/
  command.assertEmbeddedPgPresent({}, ["/just/one/file"], "/partial");
});

Deno.test("assertEmbeddedPgPresent - no-op when --lite even with --platform", () => {
  const command = new BuildCommand();
  /*** --lite explicitly opts out of PG embedding, so any path list is fine. ***/
  command.assertEmbeddedPgPresent({ lite: true, platform: "linux-x64" }, [], "/dist/embedded-pg/linux-x64/16.4");
});

Deno.test("assertEmbeddedPgPresent - no-op when DISC_BUILD_NO_BUNDLE_PG=1 even with --platform", () => {
  const command = new BuildCommand();
  const prev = Deno.env.get("DISC_BUILD_NO_BUNDLE_PG");
  Deno.env.set("DISC_BUILD_NO_BUNDLE_PG", "1");

  try {
    /*** Explicit opt-out via env: 0 files is correct. ***/
    command.assertEmbeddedPgPresent({ platform: "linux-x64" }, [], "/dist/embedded-pg/linux-x64/16.4");
  } finally {
    if (prev === undefined)
      Deno.env.delete("DISC_BUILD_NO_BUNDLE_PG");
    else
      Deno.env.set("DISC_BUILD_NO_BUNDLE_PG", prev);
  }
});

Deno.test("assertEmbeddedSdkPresent - throws when --platform set and 0 files staged", () => {
  const command = new BuildCommand();
  let threw = false;

  try {
    command.assertEmbeddedSdkPresent({ platform: "linux-x64" }, []);
  } catch {
    threw = true;
  }

  assertEquals(threw, true, "assertEmbeddedSdkPresent must throw when --platform is set and 0 SDK files were staged.");
});

Deno.test("assertEmbeddedSdkPresent - throws when sdk/mod.ts is missing", () => {
  const command = new BuildCommand();
  /*** 11 files but mod.ts absent — generated client imports ./sdk/mod.ts, so the embed is unusable
       without it. ***/
  const paths = [
    "/repo/sdk/auth.ts",
    "/repo/sdk/client.ts",
    "/repo/sdk/codecs.ts",
    "/repo/sdk/errors.ts",
    "/repo/sdk/query-builder.ts",
    "/repo/sdk/schema-types.ts",
    "/repo/sdk/subscription.ts",
    "/repo/sdk/transaction.ts",
    "/repo/sdk/types.ts",
    "/repo/sdk/validation.ts"
  ];

  let threw = false;

  try {
    command.assertEmbeddedSdkPresent({ platform: "linux-x64" }, paths);
  } catch {
    threw = true;
  }

  assertEquals(threw, true, "assertEmbeddedSdkPresent must throw when sdk/mod.ts is missing from the embedded paths.");
});

Deno.test("assertEmbeddedSdkPresent - throws when file count below threshold", () => {
  const command = new BuildCommand();
  /*** mod.ts present but only 3 files total — partial tree. ***/
  const paths = [
    "/repo/sdk/mod.ts",
    "/repo/sdk/client.ts",
    "/repo/sdk/types.ts"
  ];

  let threw = false;

  try {
    command.assertEmbeddedSdkPresent({ platform: "linux-x64" }, paths);
  } catch {
    threw = true;
  }

  assertEquals(threw, true, "assertEmbeddedSdkPresent must throw when file count is below the SDK source threshold.");
});

Deno.test("assertEmbeddedSdkPresent - no-op when --platform set and full SDK tree", () => {
  const command = new BuildCommand();
  const paths = [
    "/repo/sdk/auth.ts",
    "/repo/sdk/client.ts",
    "/repo/sdk/codecs.ts",
    "/repo/sdk/errors.ts",
    "/repo/sdk/mod.ts",
    "/repo/sdk/query-builder.ts",
    "/repo/sdk/schema-types.ts",
    "/repo/sdk/subscription.ts",
    "/repo/sdk/transaction.ts",
    "/repo/sdk/types.ts",
    "/repo/sdk/validation.ts"
  ];

  command.assertEmbeddedSdkPresent({ platform: "linux-x64" }, paths);
});

Deno.test("assertEmbeddedSdkPresent - no-op when no --platform (host build)", () => {
  const command = new BuildCommand();
  command.assertEmbeddedSdkPresent({}, []);
  command.assertEmbeddedSdkPresent({}, ["/just/one/file"]);
});

Deno.test("assertEmbeddedSdkPresent - no-op when DISC_BUILD_NO_BUNDLE_SDK=1 even with --platform", () => {
  const command = new BuildCommand();
  const prev = Deno.env.get("DISC_BUILD_NO_BUNDLE_SDK");
  Deno.env.set("DISC_BUILD_NO_BUNDLE_SDK", "1");

  try {
    command.assertEmbeddedSdkPresent({ platform: "linux-x64" }, []);
  } finally {
    if (prev === undefined)
      Deno.env.delete("DISC_BUILD_NO_BUNDLE_SDK");
    else
      Deno.env.set("DISC_BUILD_NO_BUNDLE_SDK", prev);
  }
});

Deno.test("refreshEmbeddedPgManifest - honors pgSourceDirOverride for cross-compile staging", async () => {
  /*** Stage a fake PG distribution under a per-platform dir and confirm the manifest emitter
       sources from THAT path, not from <DISC_HOME>. ***/
  const tmp = await Deno.makeTempDir({ prefix: "disc-pg-staging-" });

  try {
    const stagingDir = join(tmp, "dist", "embedded-pg", "linux-x64", "16.4");
    await Deno.mkdir(join(stagingDir, "bin"), { recursive: true });
    await Deno.writeTextFile(join(stagingDir, "bin", "postgres"), "fake");
    await Deno.chmod(join(stagingDir, "bin", "postgres"), 0o755);

    /*** refreshEmbeddedPgManifest writes its output under
         `<rootDir>/postgres/embedded-pg-manifest.ts`. Use a tmp rootDir so we don’t clobber the
         real manifest. ***/
    const fakeRoot = await Deno.makeTempDir({ prefix: "disc-pg-root-" });

    try {
      await Deno.mkdir(join(fakeRoot, "postgres"), { recursive: true });
      const result = await refreshEmbeddedPgManifest(fakeRoot, "16.4", stagingDir);
      assertEquals(result.pgSourceDir, stagingDir);
      assertEquals(result.fileCount, 1);
      assertEquals(result.includePaths[0], join(stagingDir, "bin", "postgres"));
    } finally {
      await Deno.remove(fakeRoot, { recursive: true });
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/*** --- Embedded SDK manifest — Caddy-style self-contained codegen --- ***/

Deno.test("generateEmbeddedSdkManifest - empty manifest when source dir absent", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-sdk-empty-" });

  try {
    const generated = await generateEmbeddedSdkManifest({
      manifestDir: join(tmp, "codegen"),
      sourceDir: join(tmp, "does-not-exist")
    });

    assertStringIncludes(generated, "EMBEDDED_SDK_MANIFEST");
    assertStringIncludes(generated, "[]");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("generateEmbeddedSdkManifest - emits import.meta.resolve URLs and skips .test.ts", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-sdk-list-" });

  try {
    const sourceDir = join(tmp, "sdk");
    const manifestDir = join(tmp, "codegen");
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(manifestDir, { recursive: true });
    await Deno.writeTextFile(join(sourceDir, "client.ts"), "export {};");
    await Deno.writeTextFile(join(sourceDir, "mod.ts"), "export {};");
    await Deno.writeTextFile(join(sourceDir, "client.test.ts"), "// test");
    await Deno.writeTextFile(join(sourceDir, "README.md"), "# sdk");

    const generated = await generateEmbeddedSdkManifest({ manifestDir, sourceDir });

    assertStringIncludes(generated, "\"client.ts\"");
    assertStringIncludes(generated, "\"mod.ts\"");
    /*** Tests must not get embedded — they’d bloat the binary and pull test-only deps into
         downstream projects. ***/
    assertEquals(generated.includes("client.test.ts"), false);
    /*** Non-.ts files are out of scope. ***/
    assertEquals(generated.includes("README.md"), false);
    /*** All entries get the read-only mode 0o644. ***/
    assertStringIncludes(generated, "0o644");
    /*** sourceUrl uses import.meta.resolve so deno compile’s VFS catches the read at runtime — bare
         absolute file:// URLs miss the VFS because Deno only remaps URLs derived from
         module resolution. ***/
    assertStringIncludes(generated, `import.meta.resolve("../sdk/client.ts")`);
    assertStringIncludes(generated, `import.meta.resolve("../sdk/mod.ts")`);
    /*** The old absolute-file:// form must be gone. ***/
    assertEquals(generated.includes(`file://${sourceDir}`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("refreshEmbeddedSdkManifest - writes manifest under codegen/", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-refresh-sdk-" });

  try {
    /*** Stand up a fake repo root with sdk/ + codegen/. ***/
    const sdkDir = join(tmp, "sdk");
    const codegenDir = join(tmp, "codegen");
    await Deno.mkdir(sdkDir, { recursive: true });
    await Deno.mkdir(codegenDir, { recursive: true });
    await Deno.writeTextFile(join(sdkDir, "mod.ts"), "export {};");
    await Deno.writeTextFile(join(sdkDir, "client.ts"), "export {};");
    await Deno.writeTextFile(join(sdkDir, "client.test.ts"), "// test");

    const result = await refreshEmbeddedSdkManifest(tmp);

    assertEquals(result.sdkSourceDir, sdkDir);
    assertEquals(result.fileCount, 2);
    assertEquals(result.wrote, true);

    /*** Both .ts files made it into the include list (sorted). ***/
    assertEquals(result.includePaths.includes(join(sdkDir, "mod.ts")), true);
    assertEquals(result.includePaths.includes(join(sdkDir, "client.ts")), true);

    /*** Manifest file written + readable. ***/
    const manifestText = await Deno.readTextFile(join(codegenDir, "embedded-sdk-manifest.ts"));
    assertStringIncludes(manifestText, "EMBEDDED_SDK_MANIFEST");
    assertStringIncludes(manifestText, "\"mod.ts\"");
    assertStringIncludes(manifestText, "\"client.ts\"");
    assertEquals(manifestText.includes("client.test.ts"), false);

    /*** Re-running with no source changes is a no-op (no rewrite). ***/
    const second = await refreshEmbeddedSdkManifest(tmp);
    assertEquals(second.wrote, false);
    assertEquals(second.fileCount, 2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("BuildCommand.buildCompileArgs - includes SDK paths when supplied", () => {
  const command = new BuildCommand();
  const args = command.buildCompileArgs({}, [], ["/abs/sdk/mod.ts", "/abs/sdk/client.ts"]);
  assertEquals(args.includes("/abs/sdk/mod.ts"), true);
  assertEquals(args.includes("/abs/sdk/client.ts"), true);

  for (const path of ["/abs/sdk/mod.ts", "/abs/sdk/client.ts"]) {
    const i = args.indexOf(path);
    assertEquals(args[i - 1], "--include");
  }
});
