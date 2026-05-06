import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { AVAILABLE_PLATFORMS, BuildCommand, generateUiManifest } from "./build.ts";
import { join } from "@std/path";

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

Deno.test("generateUiManifest - emits sorted, posix-style paths even on backslashed inputs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "disc-ui-manifest-sort-" });
  try {
    const buildDir = join(tmp, "ui", "build");
    await Deno.mkdir(join(buildDir, "z"), { recursive: true });
    await Deno.mkdir(join(buildDir, "a"), { recursive: true });
    await Deno.writeTextFile(join(buildDir, "z", "z.js"), "");
    await Deno.writeTextFile(join(buildDir, "a", "a.js"), "");

    const generated = await generateUiManifest(buildDir);
    const aIdx = generated.indexOf('"a/a.js"');
    const zIdx = generated.indexOf('"z/z.js"');
    assertEquals(aIdx > 0, true);
    assertEquals(zIdx > aIdx, true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
