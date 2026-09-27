/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Config-variable registry (#5988 + #6444 — Phase 2)
 *
 * The registry is the single source of truth for every CONFIGURE-able
 * key: name, scope, type, default, and the `secret` flag that gates
 * whether a value is masked when surfaced through introspection or
 * admin endpoints. The CONFIGURE compiler derives its key→pg-name map
 * from the registry, so adding a key is one entry rather than two.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ConfigurationError } from "../lib/errors.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import {
  CONFIG_REGISTRY,
  getConfigRegistry,
  lookupConfigKey,
  maskIfSecret
} from "./config-registry.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
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

Deno.test("config-registry - the registry is the CONFIGURE allowlist", () => {
  // Every key CONFIGURE accepts: Gel's documented keys that map to a
  // PostgreSQL setting, plus the PostgreSQL-named keys Disc already had
  // (less `listen_addresses` and `log_min_duration_statement`, see below).
  // Adding a key here opens it to CONFIGURE — review it for safety first.
  const names = getConfigRegistry().map(d => d.name).sort();
  assertEquals(names, [
    "default_statistics_target",
    "effective_cache_size",
    "effective_io_concurrency",
    "idle_in_transaction_session_timeout",
    "lock_timeout",
    "maintenance_work_mem",
    "max_connections",
    "query_execution_timeout",
    "query_work_mem",
    "session_idle_transaction_timeout",
    "shared_buffers",
    "work_mem"
  ]);
});

Deno.test("config-registry - Gel's keys map to the PostgreSQL settings Gel backs them with", () => {
  assertEquals(lookupConfigKey("session_idle_transaction_timeout")?.pgName, "idle_in_transaction_session_timeout");
  assertEquals(lookupConfigKey("query_work_mem")?.pgName, "work_mem");
  assertEquals(lookupConfigKey("effective_io_concurrency")?.pgName, "effective_io_concurrency");
  assertEquals(lookupConfigKey("default_statistics_target")?.pgName, "default_statistics_target");
});

Deno.test("config-registry - only the timeouts may be configured per session", () => {
  const session = getConfigRegistry()
    .filter(d => d.defaultScope === "session")
    .map(d => d.name)
    .sort();
  assertEquals(session, [
    "idle_in_transaction_session_timeout",
    "lock_timeout",
    "query_execution_timeout",
    "session_idle_transaction_timeout"
  ]);
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
    if (idx >= 0) {
      CONFIG_REGISTRY.splice(idx, 1);
    }
  }
});

// =========================================================================
// CONFIGURE compilation regression — derived map must still work
// =========================================================================

Deno.test("config-registry - CONFIGURE SYSTEM SET work_mem still compiles via registry", () => {
  const sql = compileEdgeQL("CONFIGURE SYSTEM SET work_mem := '256MB'");
  assertEquals(sql.includes("ALTER SYSTEM SET work_mem"), true);
});

Deno.test("config-registry - CONFIGURE maps Gel's query_work_mem to work_mem", () => {
  const sql = compileEdgeQL("CONFIGURE SYSTEM SET query_work_mem := '64MB'");
  assertEquals(sql, "ALTER SYSTEM SET work_mem = '64MB'");
});

Deno.test("config-registry - CONFIGURE renames query_execution_timeout to statement_timeout", () => {
  const sql = compileEdgeQL(
    "CONFIGURE SESSION SET query_execution_timeout := 30000"
  );
  assertEquals(sql.includes("statement_timeout"), true);
});

Deno.test("config-registry - CONFIGURE rejects a key the registry doesn't list (Gel's ConfigurationError)", () => {
  // Unknown keys used to pass straight to PostgreSQL (`SET LOCAL <key>`,
  // `ALTER SYSTEM SET <key>`), which reached every PostgreSQL setting.
  for (
    const query of [
      "CONFIGURE SESSION SET custom_setting := 42",
      "CONFIGURE SESSION RESET custom_setting",
      "CONFIGURE SYSTEM SET myapp.feature_flag := 'on'",
      "CONFIGURE DATABASE SET custom_setting := 42",
      "CONFIGURE INSTANCE RESET custom_setting"
    ]
  ) {
    assertThrows(() => compileEdgeQL(query), ConfigurationError, "unrecognized configuration parameter", query);
  }
});

Deno.test("config-registry - CONFIGURE never reaches a dangerous PostgreSQL setting", () => {
  // Secrets, file paths, code loading, logging, networking, replication and
  // superuser-only settings — none is in the registry, at any scope.
  const dangerous = [
    "archive_command",
    "data_directory",
    "dynamic_library_path",
    "hba_file",
    "listen_addresses",
    "local_preload_libraries",
    "log_directory",
    "log_min_duration_statement",
    "log_statement",
    "password_encryption",
    "port",
    "restore_command",
    "session_preload_libraries",
    "session_replication_role",
    "shared_preload_libraries",
    "ssl",
    "ssl_cert_file",
    "ssl_key_file",
    "ssl_passphrase_command"
  ];
  for (const key of dangerous) {
    assertEquals(lookupConfigKey(key), undefined, key);
    for (const scope of ["SESSION", "DATABASE", "INSTANCE", "SYSTEM"]) {
      const query = `CONFIGURE ${scope} SET ${key} := 'x'`;
      assertThrows(() => compileEdgeQL(query), ConfigurationError, "unrecognized configuration parameter", query);
    }
  }
});

Deno.test("config-registry - CONFIGURE SESSION rejects a system-level key (as Gel does)", () => {
  for (const query of ["CONFIGURE SESSION SET work_mem := '1GB'", "CONFIGURE SESSION RESET shared_buffers"]) {
    assertThrows(() => compileEdgeQL(query), ConfigurationError, "is a system-level configuration parameter", query);
  }
  // A system-level key is still accepted at a persistent scope.
  assertEquals(compileEdgeQL("CONFIGURE SYSTEM RESET work_mem"), "ALTER SYSTEM RESET work_mem");
});

Deno.test("config-registry - CONFIGURE SESSION accepts a session-level key", () => {
  assertEquals(
    compileEdgeQL("CONFIGURE SESSION SET session_idle_transaction_timeout := '5s'"),
    "SET LOCAL idle_in_transaction_session_timeout = '5s'"
  );
  assertEquals(compileEdgeQL("CONFIGURE SESSION RESET lock_timeout"), "RESET lock_timeout");
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
