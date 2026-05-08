/**
 * Tests for AccessExtensionAdapter
 */

import { assertEquals } from "@std/assert";
import { AccessEvaluator } from "../access/evaluator.ts";
import { AccessSQLInjector } from "../access/sql-injector.ts";
import type { AccessConfig } from "../access/types.ts";
import { AccessExtensionAdapter } from "./access-extension.ts";
import type { AccessExtensionAdapterOptions } from "./access-extension.ts";
import type { ExtensionContext } from "./types.ts";

// ── Test helpers ──────────────────────────────────────────────────────

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
      error: () => {},
      info: () => {},
      warn: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as unknown as ExtensionContext["logger"]
  };
}

const defaultAccessConfig: AccessConfig = {
  defaultAllow: true,
  enableAudit: false,
  enableRLS: false,
  mode: "permissive"
};

function makeAdapter(): AccessExtensionAdapter {
  const evaluator = new AccessEvaluator(defaultAccessConfig);
  const injector = new AccessSQLInjector(evaluator);
  const options: AccessExtensionAdapterOptions = { evaluator, injector };
  return new AccessExtensionAdapter(options);
}

// ── Metadata ──────────────────────────────────────────────────────────

Deno.test("AccessExtensionAdapter - metadata name is access", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.metadata.name, "access");
});

Deno.test("AccessExtensionAdapter - metadata version is 1.0.0", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.metadata.version, "1.0.0");
});

Deno.test("AccessExtensionAdapter - metadata description is set", () => {
  const adapter = makeAdapter();
  assertEquals(typeof adapter.metadata.description, "string");
  assertEquals((adapter.metadata.description ?? "").length > 0, true);
});

// ── Routes and functions ──────────────────────────────────────────────

Deno.test("AccessExtensionAdapter - getRoutes returns empty array", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.getRoutes().length, 0);
});

Deno.test("AccessExtensionAdapter - getMiddleware returns empty array", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.getMiddleware().length, 0);
});

Deno.test("AccessExtensionAdapter - getFunctions returns empty array", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.getFunctions().length, 0);
});

Deno.test("AccessExtensionAdapter - getDatabaseSetup returns empty setupSql", () => {
  const adapter = makeAdapter();
  const setup = adapter.getDatabaseSetup();
  assertEquals(setup.setupSql.length, 0);
});

// ── Exposed internals ─────────────────────────────────────────────────

Deno.test("AccessExtensionAdapter - getEvaluator returns the evaluator passed in constructor", () => {
  const evaluator = new AccessEvaluator(defaultAccessConfig);
  const injector = new AccessSQLInjector(evaluator);
  const adapter = new AccessExtensionAdapter({ evaluator, injector });
  assertEquals(adapter.getEvaluator(), evaluator);
});

Deno.test("AccessExtensionAdapter - getInjector returns the injector passed in constructor", () => {
  const evaluator = new AccessEvaluator(defaultAccessConfig);
  const injector = new AccessSQLInjector(evaluator);
  const adapter = new AccessExtensionAdapter({ evaluator, injector });
  assertEquals(adapter.getInjector(), injector);
});

// ── Health check ──────────────────────────────────────────────────────

Deno.test("AccessExtensionAdapter - healthCheck returns unhealthy before initialize", async () => {
  const adapter = makeAdapter();
  const result = await adapter.healthCheck();
  assertEquals(result.healthy, false);
});

Deno.test("AccessExtensionAdapter - healthCheck returns healthy after initialize", async () => {
  const adapter = makeAdapter();
  await adapter.initialize(makeContext());
  const result = await adapter.healthCheck();
  assertEquals(result.healthy, true);
});

// ── Lifecycle ─────────────────────────────────────────────────────────

Deno.test("AccessExtensionAdapter - state starts as uninitialized", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.state, "uninitialized");
});

Deno.test("AccessExtensionAdapter - initialize sets state to ready", async () => {
  const adapter = makeAdapter();
  await adapter.initialize(makeContext());
  assertEquals(adapter.state, "ready");
});

Deno.test("AccessExtensionAdapter - shutdown sets state to shutdown", async () => {
  const adapter = makeAdapter();
  await adapter.initialize(makeContext());
  await adapter.shutdown();
  assertEquals(adapter.state, "shutdown");
});

Deno.test("AccessExtensionAdapter - healthCheck returns unhealthy after shutdown", async () => {
  const adapter = makeAdapter();
  await adapter.initialize(makeContext());
  await adapter.shutdown();
  const result = await adapter.healthCheck();
  assertEquals(result.healthy, false);
});
