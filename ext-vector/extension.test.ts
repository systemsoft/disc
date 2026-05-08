/**
 * Tests for VectorExtension
 */

import { assertEquals } from "@std/assert";
import type { ExtensionContext } from "../extensions/types.ts";
import { VectorExtension } from "./extension.ts";

// ── Test helpers ───────────────────────────────────────────────────────

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

// ── Metadata ───────────────────────────────────────────────────────────

Deno.test("VectorExtension - metadata has correct name", () => {
  const ext = new VectorExtension();
  assertEquals(ext.metadata.name, "vector");
});

Deno.test("VectorExtension - metadata has correct version", () => {
  const ext = new VectorExtension();
  assertEquals(ext.metadata.version, "1.0.0");
});

// ── Constructor / config ───────────────────────────────────────────────

Deno.test("VectorExtension - default config uses 1536 dimensions and hnsw index type", async () => {
  const ext = new VectorExtension();
  await ext.initialize(makeContext());
  const health = await ext.healthCheck();
  assertEquals(health.details, "pgvector enabled (1536d, hnsw)");
});

Deno.test("VectorExtension - custom config values are applied", async () => {
  const ext = new VectorExtension({
    defaultDimensions: 768,
    indexType: "ivfflat"
  });
  await ext.initialize(makeContext());
  const health = await ext.healthCheck();
  assertEquals(health.details, "pgvector enabled (768d, ivfflat)");
});

// ── getFunctions ───────────────────────────────────────────────────────

Deno.test("VectorExtension - getFunctions returns 4 functions", () => {
  const ext = new VectorExtension();
  const fns = ext.getFunctions();
  assertEquals(fns.length, 4);
});

Deno.test("VectorExtension - getFunctions includes all expected function names", () => {
  const ext = new VectorExtension();
  const names = ext.getFunctions().map(f => f.name);
  assertEquals(names.includes("cosine_similarity"), true);
  assertEquals(names.includes("l2_distance"), true);
  assertEquals(names.includes("inner_product"), true);
  assertEquals(names.includes("to_vector"), true);
});

Deno.test("VectorExtension - cosine_similarity function has correct shape", () => {
  const ext = new VectorExtension();
  const fn = ext.getFunctions().find(f => f.name === "cosine_similarity");
  assertEquals(fn !== undefined, true);
  assertEquals(fn!.args.length, 2);
  assertEquals(fn!.args[0].name, "a");
  assertEquals(fn!.args[1].name, "b");
  assertEquals(fn!.returnType, "float64");
  assertEquals(fn!.sqlName, "1 - ($1 <=> $2)");
});

// ── getTypes ───────────────────────────────────────────────────────────

Deno.test("VectorExtension - getTypes returns vector scalar type", () => {
  const ext = new VectorExtension();
  const types = ext.getTypes();
  assertEquals(types.length, 1);
  assertEquals(types[0].name, "vector");
  assertEquals(types[0].kind, "scalar");
});

// ── getDatabaseSetup ───────────────────────────────────────────────────

Deno.test("VectorExtension - getDatabaseSetup returns CREATE EXTENSION IF NOT EXISTS vector", () => {
  const ext = new VectorExtension();
  const setup = ext.getDatabaseSetup();
  assertEquals(setup.setupSql.length, 1);
  assertEquals(setup.setupSql[0], "CREATE EXTENSION IF NOT EXISTS vector;");
});

// ── getCompilerHooks ───────────────────────────────────────────────────

Deno.test("VectorExtension - getCompilerHooks returns vector-operators hook", () => {
  const ext = new VectorExtension();
  const hooks = ext.getCompilerHooks();
  assertEquals(hooks.length, 1);
  assertEquals(hooks[0].name, "vector-operators");
});

Deno.test("VectorExtension - compiler hook transforms cosine_similarity correctly", () => {
  const ext = new VectorExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "cosine_similarity",
    ["embedding", "query_vec"]
  );
  assertEquals(result, "1 - (embedding <=> query_vec)");
});

Deno.test("VectorExtension - compiler hook transforms l2_distance correctly", () => {
  const ext = new VectorExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "l2_distance",
    ["v1", "v2"]
  );
  assertEquals(result, "v1 <-> v2");
});

Deno.test("VectorExtension - compiler hook transforms inner_product correctly", () => {
  const ext = new VectorExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "inner_product",
    ["v1", "v2"]
  );
  assertEquals(result, "v1 <#> v2");
});

Deno.test("VectorExtension - compiler hook transforms to_vector correctly", () => {
  const ext = new VectorExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.("to_vector", ["my_array"]);
  assertEquals(result, "my_array::vector");
});

Deno.test("VectorExtension - compiler hook returns undefined for unknown function", () => {
  const ext = new VectorExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.("unknown_fn", ["x"]);
  assertEquals(result, undefined);
});

// ── healthCheck ────────────────────────────────────────────────────────

Deno.test("VectorExtension - healthCheck reports unhealthy before initialize", async () => {
  const ext = new VectorExtension();
  const health = await ext.healthCheck();
  assertEquals(health.healthy, false);
  assertEquals(health.details, undefined);
});

Deno.test("VectorExtension - healthCheck reports healthy after initialize", async () => {
  const ext = new VectorExtension();
  await ext.initialize(makeContext());
  const health = await ext.healthCheck();
  assertEquals(health.healthy, true);
  assertEquals(typeof health.details, "string");
});
