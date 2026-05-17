/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for BaseExtension
 */

import { assertEquals } from "@std/assert";
import type { FunctionDef, TypeDef } from "../compiler/context.ts";
import { BaseExtension } from "./base-extension.ts";
import type { ExtensionContext, ExtensionMetadata } from "./types.ts";

// Minimal concrete subclass used across all tests
class TestExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "test-ext",
    version: "1.0.0",
    description: "Test extension"
  };
}

// Minimal ExtensionContext stub — no real DB connection needed
function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as unknown as ExtensionContext["logger"]
  };
}

// ── State lifecycle ──────────────────────────────────────────────────

Deno.test("BaseExtension - state starts as uninitialized", () => {
  const ext = new TestExtension();
  assertEquals(ext.state, "uninitialized");
});

Deno.test("BaseExtension - initialize sets state to ready", async () => {
  const ext = new TestExtension();
  await ext.initialize(makeContext());
  assertEquals(ext.state, "ready");
});

Deno.test("BaseExtension - shutdown sets state to shutdown", async () => {
  const ext = new TestExtension();
  await ext.initialize(makeContext());
  await ext.shutdown();
  assertEquals(ext.state, "shutdown");
});

// ── Default return values ────────────────────────────────────────────

Deno.test("BaseExtension - getFunctions returns empty array", () => {
  const ext = new TestExtension();
  const fns: FunctionDef[] = ext.getFunctions();
  assertEquals(fns.length, 0);
});

Deno.test("BaseExtension - getTypes returns empty array", () => {
  const ext = new TestExtension();
  const types: TypeDef[] = ext.getTypes();
  assertEquals(types.length, 0);
});

Deno.test("BaseExtension - getRoutes returns empty array", () => {
  const ext = new TestExtension();
  assertEquals(ext.getRoutes().length, 0);
});

Deno.test("BaseExtension - getMiddleware returns empty array", () => {
  const ext = new TestExtension();
  assertEquals(ext.getMiddleware().length, 0);
});

Deno.test("BaseExtension - getDatabaseSetup returns empty setupSql", () => {
  const ext = new TestExtension();
  const setup = ext.getDatabaseSetup();
  assertEquals(setup.setupSql.length, 0);
});

Deno.test("BaseExtension - getCompilerHooks returns empty array", () => {
  const ext = new TestExtension();
  assertEquals(ext.getCompilerHooks().length, 0);
});

// ── Health check ─────────────────────────────────────────────────────

Deno.test("BaseExtension - healthCheck returns unhealthy before initialize", async () => {
  const ext = new TestExtension();
  const result = await ext.healthCheck();
  assertEquals(result.healthy, false);
});

Deno.test("BaseExtension - healthCheck returns healthy after initialize", async () => {
  const ext = new TestExtension();
  await ext.initialize(makeContext());
  const result = await ext.healthCheck();
  assertEquals(result.healthy, true);
});

Deno.test("BaseExtension - healthCheck returns unhealthy after shutdown", async () => {
  const ext = new TestExtension();
  await ext.initialize(makeContext());
  await ext.shutdown();
  const result = await ext.healthCheck();
  assertEquals(result.healthy, false);
});
