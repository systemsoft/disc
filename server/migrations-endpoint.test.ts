/**
 * Tests for the migration history REST endpoint.
 *
 * Covers GET /migrations:
 *   - returns 200 with the wrapped { migrations: [...] } payload
 *   - sets JSON content-type
 *   - returns an empty migrations array when no history exists
 *   - returns 503 when the provider throws (tracker init failure, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { MigrationHistoryEntry } from "../migration/types.ts";
import { handleGetMigrations, type MigrationsProvider, type MigrationsRouteContext } from "./migrations-endpoint.ts";

function makeCtx(provider: MigrationsProvider): MigrationsRouteContext {
  return {
    migrationsProvider: provider,
    defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
  };
}

function entry(
  overrides: Partial<MigrationHistoryEntry> = {},
): MigrationHistoryEntry {
  return {
    id: "m20260101T000000_abc123",
    name: "create_item",
    description: "Create type Item",
    schemaHash: "deadbeef",
    appliedAt: new Date("2026-01-01T00:00:00Z"),
    durationMs: 7,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    dataMigration: false,
    appliedOrder: 1,
    ...overrides,
  };
}

Deno.test("GET /migrations - returns 200 with wrapped migrations array", async () => {
  const history = [entry({ name: "create_item" }), entry({ name: "add_user" })];
  const response = await handleGetMigrations(
    makeCtx(() => Promise.resolve(history)),
  );

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());
  assertEquals(Array.isArray(body.migrations), true);
  assertEquals(body.migrations.length, 2);
  assertEquals(body.migrations[0].name, "create_item");
  assertEquals(body.migrations[1].name, "add_user");
});

Deno.test("GET /migrations - returns JSON content-type", async () => {
  const response = await handleGetMigrations(
    makeCtx(() => Promise.resolve([])),
  );
  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("GET /migrations - empty history yields { migrations: [] }", async () => {
  const response = await handleGetMigrations(
    makeCtx(() => Promise.resolve([])),
  );

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());
  assertEquals(body.migrations, []);
});

Deno.test("GET /migrations - 503 when provider throws (tracker uninitialized)", async () => {
  const response = await handleGetMigrations(
    makeCtx(() => {
      throw new Error("Migration tracker not initialized");
    }),
  );

  assertEquals(response.status, 503);
  const body = JSON.parse(await response.text());
  assertEquals(body.error, "Migration history unavailable");
  assertStringIncludes(body.details, "not initialized");
});

Deno.test("GET /migrations - 503 when provider rejects async", async () => {
  const response = await handleGetMigrations(
    makeCtx(() => Promise.reject(new Error("pool drained"))),
  );

  assertEquals(response.status, 503);
  const body = JSON.parse(await response.text());
  assertEquals(body.error, "Migration history unavailable");
  assertStringIncludes(body.details, "pool drained");
});

Deno.test("GET /migrations - non-Error thrown values are coerced to string", async () => {
  const response = await handleGetMigrations(
    makeCtx(() => {
      throw "raw string failure"; // unusual but possible
    }),
  );

  assertEquals(response.status, 503);
  const body = JSON.parse(await response.text());
  assertStringIncludes(body.details, "raw string failure");
});

Deno.test("GET /migrations - preserves all history-entry fields", async () => {
  const ts = new Date("2026-04-01T12:34:56Z");
  const e = entry({
    id: "m20260401T123456_xyz",
    name: "alter_user",
    description: "Add email column",
    schemaHash: "cafebabe",
    appliedAt: ts,
    durationMs: 42,
    createdAt: ts,
    dataMigration: true,
  });

  const response = await handleGetMigrations(
    makeCtx(() => Promise.resolve([e])),
  );

  const body = JSON.parse(await response.text());
  const got = body.migrations[0];
  assertEquals(got.id, "m20260401T123456_xyz");
  assertEquals(got.name, "alter_user");
  assertEquals(got.description, "Add email column");
  assertEquals(got.schemaHash, "cafebabe");
  assertEquals(got.durationMs, 42);
  assertEquals(got.dataMigration, true);
  // Date fields round-trip as ISO strings through JSON.
  assertEquals(typeof got.appliedAt, "string");
  assertStringIncludes(got.appliedAt, "2026-04-01");
});
