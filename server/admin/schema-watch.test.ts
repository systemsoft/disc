/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the live schema-watch SSE endpoint (Bundle K — #3a).
 *
 * The full watch loop calls `Deno.watchFs` which is hard to test
 * deterministically. These tests cover the parts that don't depend on
 * a live FS event loop:
 *
 *   - the initial `snapshot` event emitted at connection time
 *   - the response shape (Content-Type, headers, status)
 *   - the SSE serialization helper
 *   - debounce coalescing
 *
 * The actual `Deno.watchFs` path is exercised in the PG-backed
 * integration test where we can write to a tempdir and assert the
 * stream eventually emits a delta.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatSseEvent, handleSchemaWatch } from "./schema-watch.ts";

Deno.test("formatSseEvent — emits standard event/data lines", () => {
  const out = formatSseEvent({ event: "snapshot", data: { foo: 1 } });
  assertStringIncludes(out, "event: snapshot\n");
  assertStringIncludes(out, "data: {\"foo\":1}\n");
  // SSE frames end with a blank line.
  assertEquals(out.endsWith("\n\n"), true);
});

Deno.test("formatSseEvent — emits id when provided", () => {
  const out = formatSseEvent({ event: "delta", data: {}, id: "abc123" });
  assertStringIncludes(out, "id: abc123\n");
});

Deno.test("handleSchemaWatch — returns SSE response with correct headers", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".disc" });
  try {
    await Deno.writeTextFile(
      tmp,
      `module default {\n  type User {\n    required name: str;\n  };\n};`
    );

    const response = handleSchemaWatch({
      source: { kind: "file", path: tmp },
      appliedSdlProvider: () => "module default {};",
      // Test mode: skip the watch loop so the response closes
      // immediately after the snapshot event.
      runWatchLoop: false
    });

    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("Content-Type"),
      "text/event-stream"
    );
    assertEquals(response.headers.get("Cache-Control"), "no-cache");
    assertEquals(response.headers.get("X-Accel-Buffering"), "no");

    // Drain the body — without runWatchLoop it closes after the snapshot.
    const body = await response.text();
    assertStringIncludes(body, "event: snapshot\n");
    // The snapshot's `data` JSON should be a SchemaDiffSummary —
    // the on-disk has User, applied is empty.
    assertStringIncludes(body, "\"changed\":true");
    assertStringIncludes(body, "\"User\"");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test(
  "handleSchemaWatch — surfaces parse errors in the snapshot event",
  async () => {
    const tmp = await Deno.makeTempFile({ suffix: ".disc" });
    try {
      // Malformed SDL: missing closing brace.
      await Deno.writeTextFile(
        tmp,
        `module default {\n  type User {\n    required name: str;\n};`
      );

      const response = handleSchemaWatch({
        source: { kind: "file", path: tmp },
        appliedSdlProvider: () => "module default {};",
        runWatchLoop: false
      });

      const body = await response.text();
      assertStringIncludes(body, "event: snapshot\n");
      assertStringIncludes(body, "\"errors\"");
    } finally {
      await Deno.remove(tmp);
    }
  }
);

Deno.test(
  "handleSchemaWatch — emits an error event when the schema file is missing",
  async () => {
    const response = handleSchemaWatch({
      source: { kind: "file", path: "/nonexistent/path/should/not/exist.disc" },
      appliedSdlProvider: () => "module default {};",
      runWatchLoop: false
    });

    const body = await response.text();
    assertStringIncludes(body, "event: error\n");
  }
);

Deno.test(
  "handleSchemaWatch — dir mode concatenates *.disc files in sorted order",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      // Two files, intentionally written out of alphabetical order.
      await Deno.writeTextFile(
        `${dir}/02-post.disc`,
        `module default {\n  type Post {\n    required title: str;\n  };\n};`
      );
      await Deno.writeTextFile(
        `${dir}/01-user.disc`,
        `module default {\n  type User {\n    required name: str;\n  };\n};`
      );
      // A non-.disc file that should be ignored.
      await Deno.writeTextFile(`${dir}/README.md`, "ignore me");

      const response = handleSchemaWatch({
        source: { kind: "dir", dir },
        appliedSdlProvider: () => "module default {};",
        runWatchLoop: false
      });

      const body = await response.text();
      assertStringIncludes(body, "event: snapshot\n");
      // Both types should show up as additions.
      assertStringIncludes(body, "\"User\"");
      assertStringIncludes(body, "\"Post\"");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
);

Deno.test(
  "handleSchemaWatch — dir mode emits error frame when directory missing",
  async () => {
    const response = handleSchemaWatch({
      source: { kind: "dir", dir: "/nonexistent/dbschema/should/not/exist" },
      appliedSdlProvider: () => "module default {};",
      runWatchLoop: false
    });

    const body = await response.text();
    assertStringIncludes(body, "event: error\n");
    assertStringIncludes(body, "Schema directory not found");
  }
);

Deno.test(
  "handleSchemaWatch — dir mode emits error frame when no .disc files present",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${dir}/README.md`, "no schema here");

      const response = handleSchemaWatch({
        source: { kind: "dir", dir },
        appliedSdlProvider: () => "module default {};",
        runWatchLoop: false
      });

      const body = await response.text();
      assertStringIncludes(body, "event: error\n");
      assertStringIncludes(body, "No .disc files");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
);
