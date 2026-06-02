/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for `/config` REST endpoint (#5988 + #6444 — Phase 3 + 4 + 5)
 */

import { assertEquals } from "@std/assert";
import { handleGetConfig, handleSetConfig } from "./config-endpoint.ts";
import type {
  ConfigRouteContext,
  ConfigWriteRouteContext
} from "./config-endpoint.ts";
import { CONFIG_REGISTRY } from "../compiler/config-registry.ts";

function makeCtx(
  overrides: Partial<ConfigRouteContext> = {}
): ConfigRouteContext {
  return {
    defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
    ...overrides
  };
}

Deno.test("GET /config - returns 200 with key registry", async () => {
  const response = await handleGetConfig(makeCtx());
  assertEquals(response.status, 200);

  const body = JSON.parse(await response.text());
  assertEquals(Array.isArray(body.keys), true);
  assertEquals(body.keys.length > 0, true);
});

Deno.test("GET /config - each key has metadata fields", async () => {
  const response = await handleGetConfig(makeCtx());
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
  const response = await handleGetConfig(makeCtx());
  const body = JSON.parse(await response.text());

  const names = new Set<string>(
    body.keys.map((k: { name: string; }) => k.name)
  );
  assertEquals(names.has("work_mem"), true);
  assertEquals(names.has("max_connections"), true);
  assertEquals(names.has("query_execution_timeout"), true);
});

Deno.test("GET /config - returns JSON content-type", async () => {
  const response = await handleGetConfig(makeCtx());
  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("GET /config - currentValue is null when no fetcher (dry-run)", async () => {
  const response = await handleGetConfig(makeCtx());
  const body = JSON.parse(await response.text());

  for (const def of body.keys) {
    assertEquals(def.currentValue, null);
  }
});

Deno.test("GET /config - fetcher value is surfaced by pgName", async () => {
  const fetchCurrentValues = (pgNames: string[]) => {
    const m = new Map<string, string | null>();
    // work_mem maps pgName === "work_mem"
    if (pgNames.includes("work_mem"))
      m.set("work_mem", "4MB");
    return Promise.resolve(m);
  };

  const response = await handleGetConfig(makeCtx({ fetchCurrentValues }));
  const body = JSON.parse(await response.text());
  const workMem = body.keys.find((k: { name: string; }) => k.name === "work_mem");
  assertEquals(workMem.currentValue, "4MB");
});

Deno.test("GET /config - aliased pgName (query_execution_timeout → statement_timeout)", async () => {
  const fetchCurrentValues = (_pgNames: string[]) => Promise.resolve(new Map([["statement_timeout", "30s"]]));

  const response = await handleGetConfig(makeCtx({ fetchCurrentValues }));
  const body = JSON.parse(await response.text());
  const key = body.keys.find((k: { name: string; }) => k.name === "query_execution_timeout");
  assertEquals(key.currentValue, "30s");
});

Deno.test("GET /config - secret values are masked to null even when fetched", async () => {
  // Append a synthetic secret key so we exercise the fail-closed path
  // without shipping a real secret. CONFIG_REGISTRY is mutable by contract.
  const SECRET_NAME = "__test_secret_key";
  CONFIG_REGISTRY.push({
    name: SECRET_NAME,
    pgName: SECRET_NAME,
    edgeqlType: "str",
    defaultScope: "session",
    secret: true,
    description: "synthetic secret for masking test"
  });

  try {
    const fetchCurrentValues = (_pgNames: string[]) => Promise.resolve(new Map([[SECRET_NAME, "super-secret-value"]]));

    const response = await handleGetConfig(makeCtx({ fetchCurrentValues }));
    const body = JSON.parse(await response.text());
    const key = body.keys.find((k: { name: string; }) => k.name === SECRET_NAME);
    // Even though the fetcher returned a value, masking nulls it server-side.
    assertEquals(key.currentValue, null);
    assertEquals(JSON.stringify(body).includes("super-secret-value"), false);
  } finally {
    const idx = CONFIG_REGISTRY.findIndex(k => k.name === SECRET_NAME);
    if (idx >= 0)
      CONFIG_REGISTRY.splice(idx, 1);
  }
});

Deno.test("GET /config - fetcher rejection degrades to null values, not 500", async () => {
  const fetchCurrentValues = (_pgNames: string[]) => Promise.reject(new Error("pool exploded"));

  const response = await handleGetConfig(makeCtx({ fetchCurrentValues }));
  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());
  for (const def of body.keys) {
    assertEquals(def.currentValue, null);
  }
});

// --- POST /config (handleSetConfig) ---

function makeWriteCtx(
  setValue: ConfigWriteRouteContext["setValue"]
): ConfigWriteRouteContext {
  return {
    defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
    setValue
  };
}

const neverCalled: ConfigWriteRouteContext["setValue"] = () => {
  throw new Error("setValue should not be called");
};

Deno.test("POST /config - persists a known key and returns the live value", async () => {
  let receivedPgName: string | undefined;
  let receivedValue: string | undefined;
  const setValue = (pgName: string, value: string) => {
    receivedPgName = pgName;
    receivedValue = value;
    return Promise.resolve({ value: "8MB", pendingRestart: false });
  };

  const response = await handleSetConfig(
    { name: "work_mem", value: "8MB" },
    makeWriteCtx(setValue)
  );
  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());
  assertEquals(body.name, "work_mem");
  assertEquals(body.currentValue, "8MB");
  assertEquals(body.pendingRestart, false);
  // The writer receives the PG GUC name, not the EdgeQL key.
  assertEquals(receivedPgName, "work_mem");
  assertEquals(receivedValue, "8MB");
});

Deno.test("POST /config - resolves aliased pgName for the writer", async () => {
  let receivedPgName: string | undefined;
  const setValue = (pgName: string, _value: string) => {
    receivedPgName = pgName;
    return Promise.resolve({ value: "30s", pendingRestart: false });
  };

  const response = await handleSetConfig(
    { name: "query_execution_timeout", value: "30s" },
    makeWriteCtx(setValue)
  );
  assertEquals(response.status, 200);
  assertEquals(receivedPgName, "statement_timeout");
});

Deno.test("POST /config - surfaces pendingRestart from the writer", async () => {
  const setValue = () => Promise.resolve({ value: "128MB", pendingRestart: true });

  const response = await handleSetConfig(
    { name: "shared_buffers", value: "256MB" },
    makeWriteCtx(setValue)
  );
  const body = JSON.parse(await response.text());
  assertEquals(body.pendingRestart, true);
});

Deno.test("POST /config - rejects unknown key with 400 (writer untouched)", async () => {
  const response = await handleSetConfig(
    { name: "not_a_real_key", value: "x" },
    makeWriteCtx(neverCalled)
  );
  assertEquals(response.status, 400);
});

Deno.test("POST /config - refuses secret key with 403 (writer untouched)", async () => {
  const SECRET_NAME = "__test_secret_write";
  CONFIG_REGISTRY.push({
    name: SECRET_NAME,
    pgName: SECRET_NAME,
    edgeqlType: "str",
    defaultScope: "session",
    secret: true,
    description: "synthetic secret for write-gate test"
  });

  try {
    const response = await handleSetConfig(
      { name: SECRET_NAME, value: "x" },
      makeWriteCtx(neverCalled)
    );
    assertEquals(response.status, 403);
  } finally {
    const idx = CONFIG_REGISTRY.findIndex(k => k.name === SECRET_NAME);
    if (idx >= 0)
      CONFIG_REGISTRY.splice(idx, 1);
  }
});

Deno.test("POST /config - missing fields are 400", async () => {
  const cases: unknown[] = [
    {},
    { name: "work_mem" },
    { value: "8MB" },
    { name: "work_mem", value: 123 },
    "not an object",
    null
  ];
  for (const body of cases) {
    const response = await handleSetConfig(body, makeWriteCtx(neverCalled));
    assertEquals(response.status, 400);
  }
});

Deno.test("POST /config - over-long value is 400 (writer untouched)", async () => {
  const response = await handleSetConfig(
    { name: "work_mem", value: "x".repeat(2000) },
    makeWriteCtx(neverCalled)
  );
  assertEquals(response.status, 400);
});

Deno.test("POST /config - writer rejection (bad value) surfaces as 400", async () => {
  const setValue = () => Promise.reject(new Error("invalid value for parameter \"work_mem\""));

  const response = await handleSetConfig(
    { name: "work_mem", value: "banana" },
    makeWriteCtx(setValue)
  );
  assertEquals(response.status, 400);
  const body = JSON.parse(await response.text());
  assertEquals(body.error.includes("invalid value"), true);
});
