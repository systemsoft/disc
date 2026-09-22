/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Function lookup (S7a): `f`, `std::f` and the emitted `std_f` spelling resolve
 * to one registry entry, whichever spelling the entry is keyed under, and the
 * SQL that comes out is the same for every spelling.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema, lookupFunction } from "./context.ts";

const schema = createTestSchema();

function compileEdgeQL(source: string): string {
  const result = new EdgeQLCompiler(schema, { enableAccessControl: false }).compile(new EdgeQLParser(source).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim();
}

Deno.test("lookupFunction: an entry keyed bare resolves as f, std::f and std_f", () => {
  for (const parts of [["len"], ["std", "len"], ["std_len"]]) {
    assertEquals(lookupFunction(schema, parts)?.name, "len", parts.join("::"));
  }
  for (const parts of [["json_array_unpack"], ["std", "json_array_unpack"]]) {
    assertEquals(lookupFunction(schema, parts)?.name, "json_array_unpack", parts.join("::"));
  }
});

Deno.test("lookupFunction: an entry keyed std::f resolves as f, std::f and std_f", () => {
  for (const parts of [["base64_decode"], ["std", "base64_decode"], ["std_base64_decode"]]) {
    assertEquals(lookupFunction(schema, parts)?.name, "std::base64_decode", parts.join("::"));
  }
});

Deno.test("lookupFunction: module-qualified entries resolve under their own module only", () => {
  assertExists(lookupFunction(schema, ["fts", "search"]));
  assertExists(lookupFunction(schema, ["math_log2"]));
  assertEquals(lookupFunction(schema, ["enc", "base64_decode"]), undefined);
  assertEquals(lookupFunction(schema, ["no_such_function"]), undefined);
});

Deno.test("function call: std::len and len compile alike", () => {
  assertEquals(compileEdgeQL("select std::len('abc')"), "SELECT LENGTH('abc')");
  assertEquals(compileEdgeQL("select len('abc')"), "SELECT LENGTH('abc')");
});

Deno.test("function call: bare base64_decode reaches the std_base64_decode wrapper", () => {
  assertEquals(compileEdgeQL("select base64_decode('aGk=')"), "SELECT std_base64_decode('aGk=')");
  assertEquals(compileEdgeQL("select std::base64_decode('aGk=')"), "SELECT std_base64_decode('aGk=')");
});

Deno.test("function call: a std::-qualified call gets the function's special compilation", () => {
  assertStringIncludes(compileEdgeQL("select std::json_get(<json>$j, 'k')"), "-> 'k'");
  assertEquals(compileEdgeQL("select std::to_str(1)"), compileEdgeQL("select to_str(1)"));
});

// ── Unknown functions are rejected (S7) ──────────────────────────────────

function compileError(source: string, against = schema): string {
  const result = new EdgeQLCompiler(against, { enableAccessControl: false }).compile(new EdgeQLParser(source).parse());
  return result.ok ? "" : result.error.message;
}

Deno.test("unknown function: a call to a function nobody registered is a compile error naming it", () => {
  assertStringIncludes(compileError("select enc::base64_decode('aGk=')"), "'enc::base64_decode'");
  assertStringIncludes(compileError("select no_such_function(1)"), "'no_such_function'");
  assertStringIncludes(compileError("select User { n := str_uper(.name) }"), "'str_uper'");
});

Deno.test("unknown function: also with an OVER clause, and nested in an argument", () => {
  assertStringIncludes(compileError("select User { n := no_such_window() over (order by .name) }"), "'no_such_window'");
  assertStringIncludes(compileError("select len(no_such_function('a'))"), "'no_such_function'");
});

Deno.test("unknown function: built-ins resolve even when the schema object carries no function map entries", () => {
  const bare = { ...schema, functions: new Map() };

  assertEquals(compileError("select len('abc')", bare), "");
  assertEquals(compileError("select std::base64_decode('aGk=')", bare), "");
  assertStringIncludes(compileError("select no_such_function(1)", bare), "'no_such_function'");
});

Deno.test("unknown function: a function the schema adds (extension, custom) compiles", () => {
  const extended = {
    ...schema,
    functions: new Map([...schema.functions, ["shout", { args: [{ name: "s", required: true, type: "str" }], name: "shout", returnType: "str" }]])
  };

  assertEquals(compileEdgeQLWith(extended, "select shout('a')"), "SELECT shout('a')");
});

function compileEdgeQLWith(against: typeof schema, source: string): string {
  const result = new EdgeQLCompiler(against, { enableAccessControl: false }).compile(new EdgeQLParser(source).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim();
}

Deno.test("unknown function: an SDL-declared function compiles, bare and module-qualified", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(`
    module default {
      function shout(s: str) -> str using (str_upper(s));
      type Note { required body: str; }
    }
    module util {
      function twice(n: int64) -> int64 using (n * 2);
    }
  `);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  const declared = manager.modulesToSchema(parsed.value);

  assertEquals(declared.functions.get("shout")?.returnType, "str");
  assertEquals(compileEdgeQLWith(declared, "select Note { loud := shout(.body) }").includes("shout(note_1.body)"), true);
  assertEquals(compileEdgeQLWith(declared, "select default::shout('a')"), "SELECT shout('a')");
  assertEquals(compileEdgeQLWith(declared, "select util::twice(2)"), "SELECT util_twice(2)");
  assertStringIncludes(compileError("select twice(2)", declared), "'twice'");
  // Built-ins are still there next to the declared ones.
  assertEquals(compileEdgeQLWith(declared, "select len('abc')"), "SELECT LENGTH('abc')");
});

// Documented in functions.md as a built-in (`select disc_uuidv7();`) and created
// in PostgreSQL by lib/stdlib-sql.ts, but it was never in the registry: it only
// worked because unknown names used to pass through.
Deno.test("unknown function: disc_uuidv7, the documented stdlib function, is a known built-in", () => {
  assertEquals(compileEdgeQL("select disc_uuidv7()"), "SELECT disc_uuidv7()");
  assertEquals(lookupFunction(schema, ["disc_uuidv7"])?.returnType, "uuid");
});
