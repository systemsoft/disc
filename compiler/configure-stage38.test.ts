/**
 * Stage 38: CONFIGURE Queries
 *
 * Phase 1: Parser — CONFIGURE AST and parsing (8 tests)
 * Phase 2: Compilation — config key resolution and SQL generation (6 tests)
 * Phase 3: Config persistence (6 tests)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { assertThrows } from "@std/assert/throws";
import type { ConfigureQuery } from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
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

function parseConfig(source: string): ConfigureQuery {
  const parser = new EdgeQLParser(source);
  return parser.parse() as ConfigureQuery;
}

// ===========================================================================
// PHASE 1: Parser — CONFIGURE AST and parsing
// ===========================================================================

Deno.test("CONFIGURE parser — SESSION SET parses", () => {
  const ast = parseConfig("CONFIGURE SESSION SET work_mem := '256MB'");
  assertEquals(ast.kind, "ConfigureQuery");
  assertEquals(ast.scope, "SESSION");
  assertEquals(ast.action, "SET");
  assertEquals(ast.key, "work_mem");
});

Deno.test("CONFIGURE parser — DATABASE SET parses", () => {
  const ast = parseConfig(
    "CONFIGURE DATABASE SET query_execution_timeout := 30000"
  );
  assertEquals(ast.kind, "ConfigureQuery");
  assertEquals(ast.scope, "DATABASE");
  assertEquals(ast.action, "SET");
  assertEquals(ast.key, "query_execution_timeout");
});

Deno.test("CONFIGURE parser — INSTANCE SET parses", () => {
  const ast = parseConfig(
    "CONFIGURE INSTANCE SET max_connections := 100"
  );
  assertEquals(ast.kind, "ConfigureQuery");
  assertEquals(ast.scope, "INSTANCE");
  assertEquals(ast.action, "SET");
  assertEquals(ast.key, "max_connections");
});

Deno.test("CONFIGURE parser — SYSTEM SET parses", () => {
  const ast = parseConfig("CONFIGURE SYSTEM SET shared_buffers := '1GB'");
  assertEquals(ast.kind, "ConfigureQuery");
  assertEquals(ast.scope, "SYSTEM");
  assertEquals(ast.action, "SET");
  assertEquals(ast.key, "shared_buffers");
});

Deno.test("CONFIGURE parser — SESSION RESET parses", () => {
  const ast = parseConfig("CONFIGURE SESSION RESET work_mem");
  assertEquals(ast.kind, "ConfigureQuery");
  assertEquals(ast.scope, "SESSION");
  assertEquals(ast.action, "RESET");
  assertEquals(ast.key, "work_mem");
  assertEquals(ast.value, undefined);
});

Deno.test("CONFIGURE parser — SYSTEM RESET parses", () => {
  const ast = parseConfig("CONFIGURE SYSTEM RESET shared_buffers");
  assertEquals(ast.kind, "ConfigureQuery");
  assertEquals(ast.scope, "SYSTEM");
  assertEquals(ast.action, "RESET");
  assertEquals(ast.key, "shared_buffers");
});

Deno.test("CONFIGURE parser — dotted key parses", () => {
  const ast = parseConfig("CONFIGURE SESSION SET query.timeout := 5000");
  assertEquals(ast.key, "query.timeout");
});

Deno.test("CONFIGURE parser — invalid scope throws", () => {
  assertThrows(
    () => parseConfig("CONFIGURE INVALID SET foo := 1"),
    Error,
    "Expected 'SESSION'"
  );
});

// ===========================================================================
// PHASE 2: Compilation — config key resolution
// ===========================================================================

Deno.test("CONFIGURE compile — SESSION SET compiles to SET LOCAL", () => {
  const sql = compileEdgeQL("CONFIGURE SESSION SET work_mem := '256MB'");
  assertStringIncludes(sql, "SET LOCAL");
  assertStringIncludes(sql, "work_mem");
  assertStringIncludes(sql, "'256MB'");
});

Deno.test("CONFIGURE compile — SESSION SET maps known key", () => {
  const sql = compileEdgeQL(
    "CONFIGURE SESSION SET query_execution_timeout := 30000"
  );
  assertStringIncludes(sql, "SET LOCAL");
  assertStringIncludes(sql, "statement_timeout");
  assertStringIncludes(sql, "30000");
});

Deno.test("CONFIGURE compile — SYSTEM SET compiles to ALTER SYSTEM SET", () => {
  const sql = compileEdgeQL("CONFIGURE SYSTEM SET shared_buffers := '1GB'");
  assertStringIncludes(sql, "ALTER SYSTEM SET");
  assertStringIncludes(sql, "shared_buffers");
});

Deno.test("CONFIGURE compile — SESSION RESET compiles to RESET", () => {
  const sql = compileEdgeQL("CONFIGURE SESSION RESET work_mem");
  assertStringIncludes(sql, "RESET");
  assertStringIncludes(sql, "work_mem");
});

Deno.test("CONFIGURE compile — SYSTEM RESET compiles to ALTER SYSTEM RESET", () => {
  const sql = compileEdgeQL("CONFIGURE SYSTEM RESET shared_buffers");
  assertStringIncludes(sql, "ALTER SYSTEM RESET");
  assertStringIncludes(sql, "shared_buffers");
});

Deno.test("CONFIGURE compile — DATABASE SET compiles to disc_config upsert", () => {
  const sql = compileEdgeQL(
    "CONFIGURE DATABASE SET query_execution_timeout := 30000"
  );
  assertStringIncludes(sql, "INSERT INTO disc_config");
  assertStringIncludes(sql, "ON CONFLICT");
  assertStringIncludes(sql, "'DATABASE'");
});

// ===========================================================================
// PHASE 3: Config persistence — disc_config table DDL
// ===========================================================================

Deno.test("CONFIGURE compile — DATABASE RESET deletes from disc_config", () => {
  const sql = compileEdgeQL(
    "CONFIGURE DATABASE RESET query_execution_timeout"
  );
  assertStringIncludes(sql, "DELETE FROM disc_config");
  assertStringIncludes(sql, "'DATABASE'");
});

Deno.test("CONFIGURE compile — INSTANCE SET uses INSTANCE scope", () => {
  const sql = compileEdgeQL(
    "CONFIGURE INSTANCE SET max_connections := 200"
  );
  assertStringIncludes(sql, "INSERT INTO disc_config");
  assertStringIncludes(sql, "'INSTANCE'");
});

Deno.test("CONFIGURE compile — INSTANCE RESET deletes from disc_config", () => {
  const sql = compileEdgeQL(
    "CONFIGURE INSTANCE RESET max_connections"
  );
  assertStringIncludes(sql, "DELETE FROM disc_config");
  assertStringIncludes(sql, "'INSTANCE'");
});

Deno.test("CONFIGURE compile — unknown key passes through unchanged", () => {
  const sql = compileEdgeQL(
    "CONFIGURE SESSION SET custom_setting := 42"
  );
  assertStringIncludes(sql, "SET LOCAL");
  assertStringIncludes(sql, "custom_setting");
  assertStringIncludes(sql, "42");
});
