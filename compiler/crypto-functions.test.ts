/**
 * Tests for std::* crypto functions (gh/geldata#5065).
 *
 * Verifies registration in getBuiltinFunctions() + end-to-end EdgeQL ->
 * SQL compilation for the string-input variants.
 *
 * Runtime correctness of the underlying SQL (md5, sha1/256/512, hmac,
 * encode/decode) and the lib/stdlib-sql.ts bootstrap is exercised
 * against a real Postgres in MigrationTracker integration tests
 * (DISC_PG_AUTO=1 picks them up).
 *
 * Registry keys use the compiler's `parts.join("_")` form (so EdgeQL
 * `std::md5(...)` resolves via the key `std_md5`). PG-side wrapper
 * functions of the same name are created in lib/stdlib-sql.ts.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
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

// ── Registration ──────────────────────────────────────────────────────

Deno.test("std::md5 registered (no sqlName — wrapper has matching name)", () => {
  const fn = getBuiltinFunctions().get("std::md5");
  assertExists(fn, "std_md5 should be registered");
  assertEquals(fn.name, "std::md5");
  assertEquals(fn.returnType, "bytes");
  assertEquals(fn.args.length, 1);
  assertEquals(fn.args[0].type, "bytes");
});

Deno.test("std::sha1 registered (pgcrypto-backed wrapper)", () => {
  const fn = getBuiltinFunctions().get("std::sha1");
  assertExists(fn);
  assertEquals(fn.name, "std::sha1");
  assertEquals(fn.returnType, "bytes");
});

Deno.test("std::sha256 registered with PG built-in SHA256", () => {
  const fn = getBuiltinFunctions().get("std::sha256");
  assertExists(fn);
  assertEquals(fn.sqlName, "SHA256");
  assertEquals(fn.returnType, "bytes");
});

Deno.test("std::sha512 registered with PG built-in SHA512", () => {
  const fn = getBuiltinFunctions().get("std::sha512");
  assertExists(fn);
  assertEquals(fn.sqlName, "SHA512");
});

Deno.test("std::hmac registered with PG/pgcrypto HMAC and (msg, key, algo) signature", () => {
  const fn = getBuiltinFunctions().get("std::hmac");
  assertExists(fn);
  assertEquals(fn.sqlName, "HMAC");
  assertEquals(fn.returnType, "bytes");
  assertEquals(fn.args.length, 3);
  assertEquals(fn.args[0].name, "msg");
  assertEquals(fn.args[0].type, "bytes");
  assertEquals(fn.args[1].name, "key");
  assertEquals(fn.args[1].type, "bytes");
  assertEquals(fn.args[2].name, "algo");
  assertEquals(fn.args[2].type, "str");
});

Deno.test("std::hex_encode and std::hex_decode registered", () => {
  const enc = getBuiltinFunctions().get("std::hex_encode");
  const dec = getBuiltinFunctions().get("std::hex_decode");
  assertExists(enc);
  assertExists(dec);
  assertEquals(enc.returnType, "str");
  assertEquals(dec.returnType, "bytes");
});

Deno.test("std::base64_encode and std::base64_decode registered", () => {
  const enc = getBuiltinFunctions().get("std::base64_encode");
  const dec = getBuiltinFunctions().get("std::base64_decode");
  assertExists(enc);
  assertExists(dec);
  assertEquals(enc.returnType, "str");
  assertEquals(dec.returnType, "bytes");
});

// ── Compilation (string-input variants only — bytes literal isn't
// supported in the lexer at present, so bytes-input compile-shape
// coverage lives in the runtime PG integration test path) ─────────────

Deno.test("std::base64_decode compiles to std_base64_decode(...)", () => {
  const sql = compileEdgeQL("SELECT std::base64_decode('aGVsbG8=')");
  assertStringIncludes(sql, "std_base64_decode");
});

Deno.test("std::hex_decode compiles to std_hex_decode(...)", () => {
  const sql = compileEdgeQL("SELECT std::hex_decode('48656c6c6f')");
  assertStringIncludes(sql, "std_hex_decode");
});
