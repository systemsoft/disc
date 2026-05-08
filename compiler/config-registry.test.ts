/**
 * Config-variable registry (#5988 + #6444 — Phase 2)
 *
 * The registry is the single source of truth for every CONFIGURE-able
 * key: name, scope, type, default, and the `secret` flag that gates
 * whether a value is masked when surfaced through introspection or
 * admin endpoints. The CONFIGURE compiler derives its key→pg-name map
 * from the registry, so adding a key is one entry rather than two.
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { CONFIG_REGISTRY, getConfigRegistry, lookupConfigKey, maskIfSecret } from "./config-registry.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok)
    throw result.error;
  return codegen.generate(result.value);
}

// =========================================================================
// Registry lookup
// =========================================================================

Deno.test("config-registry - lookupConfigKey returns metadata for known key", () => {
  const def = lookupConfigKey("work_mem");
  assertEquals(def !== undefined, true);
  assertEquals(def!.name, "work_mem");
  assertEquals(def!.pgName, "work_mem");
  assertEquals(def!.secret, false);
});

Deno.test("config-registry - lookupConfigKey returns mapped pgName for renamed key", () => {
  const def = lookupConfigKey("query_execution_timeout");
  assertEquals(def !== undefined, true);
  assertEquals(def!.pgName, "statement_timeout");
});

Deno.test("config-registry - lookupConfigKey returns undefined for unknown key", () => {
  assertEquals(lookupConfigKey("nope_not_a_real_key"), undefined);
});

Deno.test("config-registry - getConfigRegistry covers prior CONFIGURE_KEY_MAP entries", () => {
  const names = new Set(getConfigRegistry().map(d => d.name));
  // Every key from the prior flat map must still be present —
  // existing CONFIGURE statements would otherwise stop compiling.
  const priorKeys = [
    "query_execution_timeout",
    "listen_addresses",
    "shared_buffers",
    "work_mem",
    "maintenance_work_mem",
    "effective_cache_size",
    "max_connections",
    "log_min_duration_statement",
    "idle_in_transaction_session_timeout",
    "lock_timeout"
  ];
  for (const k of priorKeys) {
    assertEquals(names.has(k), true, `missing prior key: ${k}`);
  }
});

Deno.test("config-registry - all current keys are non-secret (Postgres tuning knobs)", () => {
  for (const def of CONFIG_REGISTRY) {
    assertEquals(
      def.secret,
      false,
      `key ${def.name} unexpectedly marked secret`
    );
  }
});

// =========================================================================
// maskIfSecret helper
// =========================================================================

Deno.test("config-registry - maskIfSecret returns value for non-secret key", () => {
  assertEquals(maskIfSecret("work_mem", "256MB"), "256MB");
});

Deno.test("config-registry - maskIfSecret returns null for unknown key (fail-closed)", () => {
  // Unknown keys could be anything, including secrets we haven't catalogued.
  // Default to masking to err on the side of safety.
  assertEquals(maskIfSecret("unknown_future_key", "sensitive!"), null);
});

Deno.test("config-registry - maskIfSecret returns null for explicitly secret key", () => {
  // Inject a synthetic secret entry to exercise the mask path without
  // shipping a real secret in the registry yet (no CONFIGURE-able
  // secrets exist in disc today; jwtSecret etc. are constructor args).
  const synthetic = "__test_only_secret_key__";
  CONFIG_REGISTRY.push({
    name: synthetic,
    pgName: synthetic,
    edgeqlType: "str",
    defaultScope: "system",
    secret: true
  });
  try {
    assertEquals(maskIfSecret(synthetic, "swordfish"), null);
  } finally {
    const idx = CONFIG_REGISTRY.findIndex(d => d.name === synthetic);
    if (idx >= 0)
      CONFIG_REGISTRY.splice(idx, 1);
  }
});

// =========================================================================
// CONFIGURE compilation regression — derived map must still work
// =========================================================================

Deno.test("config-registry - CONFIGURE SESSION SET work_mem still compiles via registry", () => {
  const sql = compileEdgeQL("CONFIGURE SESSION SET work_mem := '256MB'");
  assertEquals(sql.includes("SET LOCAL work_mem"), true);
});

Deno.test("config-registry - CONFIGURE renames query_execution_timeout to statement_timeout", () => {
  const sql = compileEdgeQL(
    "CONFIGURE SESSION SET query_execution_timeout := 30000"
  );
  assertEquals(sql.includes("statement_timeout"), true);
});

Deno.test("config-registry - CONFIGURE unknown key passes through unchanged (no registry entry)", () => {
  // Pre-existing behavior: unknown EdgeQL keys map to themselves at the
  // PG layer. The registry shouldn't tighten this — userland custom
  // settings (like `myapp.feature_flag`) need to round-trip.
  const sql = compileEdgeQL("CONFIGURE SESSION SET custom_setting := 42");
  assertEquals(sql.includes("custom_setting"), true);
});

// =========================================================================
// cfg::describe_settings() introspection function
// =========================================================================

Deno.test("config-registry - cfg::describe_settings() compiles to JSON of registry", () => {
  const sql = compileEdgeQL("SELECT cfg::describe_settings()");
  // The registry is serialized as a JSON literal cast to jsonb.
  assertEquals(sql.includes("::jsonb"), true);
  assertEquals(sql.includes("work_mem"), true);
  assertEquals(sql.includes("\"secret\""), true);
});
