import { assertEquals, assertThrows } from "@std/assert";
import { AVAILABLE_PLATFORMS, BuildCommand } from "./build.ts";

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
