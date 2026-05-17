/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertStringIncludes } from "@std/assert";
import { configureLogging, getLogger, Logger } from "./logger.ts";

// Helper to capture log output
function captureOutput(): { lines: string[]; output: (line: string) => void; } {
  const lines: string[] = [];
  return { lines, output: (line: string) => lines.push(line) };
}

Deno.test("JSON format outputs valid JSON with required fields", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const log = new Logger("test-module");
  log.info("Hello world");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.level, "INFO");
  assertEquals(entry.module, "test-module");
  assertEquals(entry.message, "Hello world");
  assertEquals(typeof entry.timestamp, "string");
});

Deno.test("text format outputs readable line", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "text", output });

  const log = new Logger("text-module");
  log.warn("Something happened");

  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "[WARN]");
  assertStringIncludes(lines[0], "[text-module]");
  assertStringIncludes(lines[0], "Something happened");
});

Deno.test("level filtering — DEBUG messages hidden at INFO level", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "INFO", format: "json", output });

  const log = new Logger("filter-module");
  log.debug("Should not appear");

  assertEquals(lines.length, 0);
});

Deno.test("level filtering — ERROR messages shown at INFO level", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "INFO", format: "json", output });

  const log = new Logger("filter-module");
  log.error("This should appear");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.level, "ERROR");
});

Deno.test("child context merging", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const log = new Logger("parent-module");
  const child = log.child({ service: "auth", userId: "u-123" });
  child.info("Child message");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.service, "auth");
  assertEquals(entry.userId, "u-123");
  assertEquals(entry.message, "Child message");
});

Deno.test("withRequest scoping adds requestId", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const log = new Logger("request-module");
  const scoped = log.withRequest("req_abc123", "127.0.0.1");
  scoped.info("Handling request");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.requestId, "req_abc123");
  assertEquals(entry.clientIp, "127.0.0.1");
});

Deno.test("configureLogging changes level", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "ERROR", format: "json", output });

  const log = new Logger("level-change");
  log.warn("Should be hidden at ERROR level");
  log.error("Should appear");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.level, "ERROR");
});

Deno.test("configureLogging changes format", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "text", output });

  const log = new Logger("format-change");
  log.info("Text format test");

  assertEquals(lines.length, 1);
  // Text format should NOT be valid JSON
  let isJson = true;
  try {
    JSON.parse(lines[0]);
  } catch {
    isJson = false;
  }
  assertEquals(isJson, false);
});

Deno.test("ISO timestamp validation", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const before = new Date();
  const log = new Logger("timestamp-module");
  log.info("Timestamp test");
  const after = new Date();

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  const ts = new Date(entry.timestamp);
  assertEquals(ts >= before, true);
  assertEquals(ts <= after, true);
});

Deno.test("extra fields merged into output", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const log = new Logger("extra-module");
  log.info("With extras", { durationMs: 42, query: "SELECT 1" });

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.durationMs, 42);
  assertEquals(entry.query, "SELECT 1");
});

Deno.test("module name included in output", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const log = new Logger("my-specific-module");
  log.debug("Debug message");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.module, "my-specific-module");
});

Deno.test("getLogger factory creates Logger with module name", () => {
  const { lines, output } = captureOutput();
  configureLogging({ level: "DEBUG", format: "json", output });

  const log = getLogger("factory-module");
  log.info("Factory test");

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.module, "factory-module");
  assertEquals(entry.message, "Factory test");
});
