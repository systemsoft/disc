/**
 * Tests for `/config` REST endpoint (#5988 + #6444 — Phase 3)
 */

import { assertEquals } from "@std/assert";
import { handleGetConfig } from "./config-endpoint.ts";
import type { ConfigRouteContext } from "./config-endpoint.ts";

function makeCtx(): ConfigRouteContext {
  return {
    defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
  };
}

Deno.test("GET /config - returns 200 with key registry", async () => {
  const response = handleGetConfig(makeCtx());
  assertEquals(response.status, 200);

  const body = JSON.parse(await response.text());
  assertEquals(Array.isArray(body.keys), true);
  assertEquals(body.keys.length > 0, true);
});

Deno.test("GET /config - each key has metadata fields", async () => {
  const response = handleGetConfig(makeCtx());
  const body = JSON.parse(await response.text());

  for (const def of body.keys) {
    assertEquals(typeof def.name, "string");
    assertEquals(typeof def.pgName, "string");
    assertEquals(typeof def.edgeqlType, "string");
    assertEquals(typeof def.defaultScope, "string");
    assertEquals(typeof def.secret, "boolean");
  }
});

Deno.test("GET /config - includes work_mem and other prior CONFIGURE keys", async () => {
  const response = handleGetConfig(makeCtx());
  const body = JSON.parse(await response.text());

  const names = new Set<string>(
    body.keys.map((k: { name: string; }) => k.name),
  );
  assertEquals(names.has("work_mem"), true);
  assertEquals(names.has("max_connections"), true);
  assertEquals(names.has("query_execution_timeout"), true);
});

Deno.test("GET /config - returns JSON content-type", () => {
  const response = handleGetConfig(makeCtx());
  assertEquals(response.headers.get("Content-Type"), "application/json");
});
