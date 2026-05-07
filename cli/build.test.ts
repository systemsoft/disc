import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { AVAILABLE_PLATFORMS, BuildCommand, generateEmbeddedPgManifest, generateUiManifest, platformPgStagingDir, refreshEmbeddedPgManifest } from "./build.ts";

Deno.test("BuildCommand - maps linux-x64 to x86_64-unknown-linux-gnu", () => {
  const command = new BuildCommand();
  assertEquals(
    command.mapPlatform("linux-x64"),
    "x86_64-unknown-linux-gnu",
  );
});

Deno.test("BuildCommand - maps darwin-arm64 to aarch64-apple-darwin", () => {
  const command = new BuildCommand();
  assertEquals(
    command.mapPlatform("darwin-arm64"),
    "aarch64-apple-darwin",
  );
});

Deno.test("BuildCommand - rejects invalid platform with helpful message", () => {
  const command = new BuildCommand();
  assertThrows(
    () => command.validatePlatform("windows-x64"),
    Error,
    "Invalid platform",
  );
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

Deno.test("BuildCommand - available platforms list contains all 4 platforms", () => {
  assertEquals(AVAILABLE_PLATFORMS.length, 4);
  assertEquals(AVAILABLE_PLATFORMS.includes("darwin-arm64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("darwin-x64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("linux-arm64"), true);
  assertEquals(AVAILABLE_PLATFORMS.includes("linux-x64"), true);
});

Deno.test("generateUiManifest - emits manifest from build dir contents", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-manifest-" });
  try {
    const buildDir = join(tmp, "ui", "build");
    await Deno.mkdir(join(buildDir, "_app", "immutable"), { recursive: true });
    await Deno.writeTextFile(join(buildDir, "index.html"), "<html/>");
    await Deno.writeTextFile(join(buildDir, "_app", "version.json"), "{}");
    await Deno.writeTextFile(
      join(buildDir, "_app", "immutable", "app.abc.js"),
      "/*js*/",
    );

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

Deno.test("generateUiManifest - throws when build dir is empty", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-manifest-empty-" });
  try {
    const buildDir = join(tmp, "ui", "build");
    await Deno.mkdir(buildDir, { recursive: true });

    let threw = false;
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
      pgVersion: "16.4",
      sourceDir: join(tmp, "does-not-exist"),
    });
    assertStringIncludes(generated, "EMBEDDED_PG_MANIFEST");
    assertStringIncludes(generated, "[]");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("generateEmbeddedPgManifest - lists files with absolute sourceUrl + correct mode", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-embed-pg-list-" });
  try {
    const sourceDir = join(tmp, "pg");
    await Deno.mkdir(join(sourceDir, "bin"), { recursive: true });
    await Deno.mkdir(join(sourceDir, "share"), { recursive: true });
    await Deno.writeTextFile(join(sourceDir, "bin", "postgres"), "fake");
    await Deno.writeTextFile(join(sourceDir, "share", "tz.txt"), "fake");

    const generated = await generateEmbeddedPgManifest({
      pgVersion: "16.4",
      sourceDir,
    });

    assertStringIncludes(generated, "\"bin/postgres\"");
    assertStringIncludes(generated, "\"share/tz.txt\"");
    // bin/* gets executable mode
    assertStringIncludes(generated, "0o755");
    // non-bin gets 0o644
    assertStringIncludes(generated, "0o644");
    // sourceUrl uses file:// + abs path so deno compile --include resolves
    assertStringIncludes(generated, `file://${sourceDir}/bin/postgres`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("BuildCommand.buildCompileArgs - includes PG paths when supplied", () => {
  const command = new BuildCommand();
  const args = command.buildCompileArgs({}, [
    "/abs/pg/bin/postgres",
    "/abs/pg/lib/libpq.dylib",
  ]);
  assertEquals(args.includes("/abs/pg/bin/postgres"), true);
  assertEquals(args.includes("/abs/pg/lib/libpq.dylib"), true);
  // Each --include path is preceded by a literal "--include" arg.
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

// =====================================================================
// Bundle I follow-up — cross-platform reproducible builds
// =====================================================================

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

// A "complete" PG distribution for test purposes: enough files to clear
// the minimum-file-count threshold + includes bin/postgres + a few
// share/timezone entries (PG init needs these). Builds the path list
// with a fake staging root so the gate only inspects the strings, not
// the filesystem.
function fakePgPaths(stagingDir: string, fileCount: number): string[] {
  const paths: string[] = [
    `${stagingDir}/bin/postgres`,
    `${stagingDir}/bin/initdb`,
    `${stagingDir}/bin/pg_ctl`,
    `${stagingDir}/share/timezone/UTC`,
    `${stagingDir}/share/extension/plpgsql.control`,
  ];
  // Pad with fake share/ files until we hit the target count.
  for (let i = 0; paths.length < fileCount; i++) {
    paths.push(`${stagingDir}/share/timezone/zone-${i}`);
  }
  return paths;
}

Deno.test("assertEmbeddedPgPresent - throws when --platform set and 0 files staged", () => {
  const command = new BuildCommand();
  let threw = false;
  try {
    command.assertEmbeddedPgPresent(
      { platform: "linux-x64" },
      [],
      "/dist/embedded-pg/linux-x64/16.4",
    );
  } catch (err) {
    threw = true;
    assertStringIncludes(
      (err as Error).message,
      "0 embedded PG files",
    );
    assertStringIncludes(
      (err as Error).message,
      "linux-x64",
    );
    assertStringIncludes(
      (err as Error).message,
      "DISC_BUILD_NO_BUNDLE_PG",
    );
  }
  assertEquals(
    threw,
    true,
    "assertEmbeddedPgPresent must throw when --platform is set and 0 files were staged.",
  );
});

Deno.test("assertEmbeddedPgPresent - throws when --platform set and bin/postgres missing", () => {
  const command = new BuildCommand();
  // Plenty of files but bin/postgres absent — partial extraction.
  // The embedded PG is useless without the postgres binary itself.
  const paths: string[] = [];
  for (let i = 0; i < 100; i++) {
    paths.push(`/staging/share/timezone/zone-${i}`);
  }
  let threw = false;
  try {
    command.assertEmbeddedPgPresent(
      { platform: "linux-x64" },
      paths,
      "/staging",
    );
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "bin/postgres");
    assertStringIncludes((err as Error).message, "linux-x64");
  }
  assertEquals(
    threw,
    true,
    "assertEmbeddedPgPresent must throw when bin/postgres is missing from the embedded paths.",
  );
});

Deno.test("assertEmbeddedPgPresent - throws when --platform set and file count below threshold", () => {
  const command = new BuildCommand();
  // bin/postgres present but only 3 files total — partial extract.
  // A real PG distribution has hundreds of files (timezone data,
  // extensions, locale data); 3 means most of share/ never landed.
  const paths = [
    "/staging/bin/postgres",
    "/staging/bin/initdb",
    "/staging/bin/pg_ctl",
  ];
  let threw = false;
  try {
    command.assertEmbeddedPgPresent(
      { platform: "linux-x64" },
      paths,
      "/staging",
    );
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "only 3 embedded PG files");
    assertStringIncludes((err as Error).message, "linux-x64");
    assertStringIncludes((err as Error).message, "partial extraction");
  }
  assertEquals(
    threw,
    true,
    "assertEmbeddedPgPresent must throw when file count is far below a real PG distribution's count.",
  );
});

Deno.test("assertEmbeddedPgPresent - no-op when --platform set and full PG distribution", () => {
  const command = new BuildCommand();
  // No throw expected — bin/postgres present + ample files.
  command.assertEmbeddedPgPresent(
    { platform: "linux-x64" },
    fakePgPaths("/staging", 137),
    "/staging",
  );
});

Deno.test("assertEmbeddedPgPresent - no-op when no --platform (host build)", () => {
  const command = new BuildCommand();
  // Host builds should never throw — local dev without PG cache is
  // expected (the binary downloads PG on first run).
  command.assertEmbeddedPgPresent({}, [], "/missing");
  command.assertEmbeddedPgPresent({}, fakePgPaths("/staging", 137), "/has-files");
  // Even a partial / incomplete cache shouldn't fail a host build.
  command.assertEmbeddedPgPresent({}, ["/just/one/file"], "/partial");
});

Deno.test("assertEmbeddedPgPresent - no-op when --lite even with --platform", () => {
  const command = new BuildCommand();
  // --lite explicitly opts out of PG embedding, so any path list is fine.
  command.assertEmbeddedPgPresent(
    { platform: "linux-x64", lite: true },
    [],
    "/dist/embedded-pg/linux-x64/16.4",
  );
});

Deno.test("assertEmbeddedPgPresent - no-op when DISC_BUILD_NO_BUNDLE_PG=1 even with --platform", () => {
  const command = new BuildCommand();
  const prev = Deno.env.get("DISC_BUILD_NO_BUNDLE_PG");
  Deno.env.set("DISC_BUILD_NO_BUNDLE_PG", "1");
  try {
    // Explicit opt-out via env: 0 files is correct.
    command.assertEmbeddedPgPresent(
      { platform: "linux-x64" },
      [],
      "/dist/embedded-pg/linux-x64/16.4",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("DISC_BUILD_NO_BUNDLE_PG");
    else Deno.env.set("DISC_BUILD_NO_BUNDLE_PG", prev);
  }
});

Deno.test("refreshEmbeddedPgManifest - honors pgSourceDirOverride for cross-compile staging", async () => {
  // Stage a fake PG distribution under a per-platform dir and confirm
  // the manifest emitter sources from THAT path, not from <DISC_HOME>.
  const tmp = await Deno.makeTempDir({ prefix: "disc-pg-staging-" });
  try {
    const stagingDir = join(tmp, "dist", "embedded-pg", "linux-x64", "16.4");
    await Deno.mkdir(join(stagingDir, "bin"), { recursive: true });
    await Deno.writeTextFile(join(stagingDir, "bin", "postgres"), "fake");
    await Deno.chmod(join(stagingDir, "bin", "postgres"), 0o755);

    // refreshEmbeddedPgManifest writes its output under
    // `<rootDir>/postgres/embedded-pg-manifest.ts`. Use a tmp rootDir so
    // we don't clobber the real manifest.
    const fakeRoot = await Deno.makeTempDir({ prefix: "disc-pg-root-" });
    try {
      await Deno.mkdir(join(fakeRoot, "postgres"), { recursive: true });
      const result = await refreshEmbeddedPgManifest(
        fakeRoot,
        "16.4",
        stagingDir,
      );
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
