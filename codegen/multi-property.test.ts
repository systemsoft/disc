/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Codegen for `multi` scalar properties: the generated type is `T[]`, the
 * typed insert/update (TypeScript, Rust and Go clients) send the array as one bound parameter and assign it with
 * `array_unpack(<array<T>>$p)` (one row holding the whole set, not one row per
 * element), and a typed filter takes one element (`{ scopes: "read" }` →
 * `.scopes = <str>$…`, true when any element matches).
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import type { Schema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitGo } from "./emit-go.ts";
import { emitRust } from "./emit-rust.ts";
import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `
module default {
  type Token {
    required name: str;
    multi scopes: str;
  }
  type Plain {
    required name: str;
  }
}
`;

function schema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function config(target: "client" | "rust" | "go"): CodegenConfig {
  return {
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    interfaceSuffix: "",
    outputDir: "./generated",
    schemaSource: "./dbschema/default.disc",
    target,
    typePrefix: ""
  } as CodegenConfig;
}

function tsFile(suffix: string): string {
  const files = emitTypeScript(schemaToIR(schema()), config("client"));
  const file = files.find(f => f.path.endsWith(suffix)) ?? (suffix === "types.ts" ? files.find(f => f.path.endsWith("interfaces.ts")) : undefined);
  assert(file, `expected ${suffix}`);
  return file.content;
}

Deno.test("codegen multi property - the TS type, insert and update shapes are arrays", () => {
  const types = tsFile("types.ts");
  assertStringIncludes(types, "scopes?: string[] | null;");
  assertStringIncludes(types.slice(types.indexOf("interface TokenInsert")), "scopes?: string[];");
  assertStringIncludes(types.slice(types.indexOf("interface TokenUpdate")), "scopes?: string[];");
});

Deno.test("codegen multi property - a typed filter takes one element", () => {
  const types = tsFile("types.ts");
  const filter = types.slice(types.indexOf("interface TokenFilter {"));
  assert(/scopes\?: string \| \w+/.test(filter), filter.slice(0, 200));
  assertEquals(/scopes\?: string\[\]/.test(filter.slice(0, filter.indexOf("}"))), false);
});

Deno.test("codegen multi property - TS insert/update assign the array with array_unpack", () => {
  const queries = tsFile("queries.ts");
  const start = queries.indexOf("class TokenQueryBuilder");
  const token = queries.slice(start, queries.indexOf("\n}\n", start));
  assertStringIncludes(token, `scopes: "<array<str>>"`);
  assertStringIncludes(token, `_multiProperties = new Set<string>(["scopes"])`);
  assertStringIncludes(token, "array_unpack(${TokenQueryBuilder._typeCasts[key]}$${key})");
  // The filter/revive type info keeps the element cast.
  assertStringIncludes(token.slice(token.indexOf("_typeInfo")), `scopes: "<str>"`);
});

Deno.test("codegen multi property - a type without multi properties keeps the plain template", () => {
  const queries = tsFile("queries.ts");
  const plain = queries.slice(queries.indexOf("class PlainQueryBuilder"));
  assertEquals(plain.slice(0, plain.indexOf("\n}\n")).includes("_multiProperties"), false);
});

Deno.test("codegen multi property - Rust insert/update assign the array with array_unpack", () => {
  const lib = emitRust(schemaToIR(schema()), config("rust")).map(f => f.content).join("\n");
  assertStringIncludes(lib, `"scopes" => "<array<str>>",`);
  assertStringIncludes(lib, `fn is_multi_property(field: &str) -> bool {`);
  assertStringIncludes(lib, "assignments.push(format!(\"{} := array_unpack({}${})\", key, Self::type_cast(key), key));");
  assertStringIncludes(lib, "pub scopes: Option<Vec<String>>");
});

Deno.test("codegen multi property - Go insert/update assign the array with array_unpack", () => {
  const code = emitGo(schemaToIR(schema()), config("go")).map(f => f.content).join("\n");
  assertStringIncludes(code, `return "<array<str>>"`);
  assertStringIncludes(code, "isMultiProperty(field string) bool {");
  assertStringIncludes(code, "fmt.Sprintf(\"%s := array_unpack(%s$%s)\", key, b.typeCast(key), key)");
});
