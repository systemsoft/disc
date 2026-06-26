/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Codegen types module tests
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertExists } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import * as Types from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("Types - getTypeMapping for built-in types", () => {
  const strMapping = Types.getTypeMapping("str");
  assertExists(strMapping);
  assertEquals(strMapping.edgeqlType, "str");
  assertEquals(strMapping.typescriptType, "string");
  assertEquals(strMapping.nullableType, "string | null");
  assertEquals(strMapping.arrayType, "string[]");

  const boolMapping = Types.getTypeMapping("bool");
  assertExists(boolMapping);
  assertEquals(boolMapping.typescriptType, "boolean");

  const intMapping = Types.getTypeMapping("int32");
  assertExists(intMapping);
  assertEquals(intMapping.typescriptType, "number");
});

Deno.test("Types - getTypeMapping for nonexistent type", () => {
  const mapping = Types.getTypeMapping("NonExistentType");
  assertEquals(mapping, null);
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for primitive types", () => {
  /*** Required string ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", true, false), "string");

  /*** Optional string ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", false, false), "string | null");

  /*** Required string array ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", true, true), "string[]");

  /*** Optional string array ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", false, true), "string[] | null");
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for numeric types", () => {
  assertEquals(Types.mapEdgeQLTypeToTypeScript("int32", true, false), "number");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("float64", false, false), "number | null");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("decimal", true, true), "number[]");
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for datetime types", () => {
  assertEquals(Types.mapEdgeQLTypeToTypeScript("datetime", true, false), "Date");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("cal::local_datetime", false, false), "Date | null");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("cal::local_date", true, false), "string");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("cal::local_time", true, true), "string[]");
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for special types", () => {
  assertEquals(Types.mapEdgeQLTypeToTypeScript("uuid", true, false), "string");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("json", true, false), "unknown");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("bytes", false, false), "Uint8Array | null");
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for collection types", () => {
  /*** array<scalar> → TS array ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("array<str>", true, false), "string[]");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("array<int64>", false, false), "bigint[] | null");

  /*** named tuple → object type ***/
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("tuple<name: str, url: str>", true, false),
    "{ name: string; url: string }"
  );

  /*** positional tuple → TS tuple (int64 → bigint by design) ***/
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("tuple<str, int64>", true, false),
    "[string, bigint]"
  );

  /*** array of named tuple → object[] ***/
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("array<tuple<title: str, url: str>>", true, false),
    "{ title: string; url: string }[]"
  );

  /*** enum member inside a tuple keeps its referenced type name ***/
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("tuple<path: str, shape: PFPShape, source: str>", false, false),
    "{ path: string; shape: PFPShape; source: string } | null"
  );

  /*** Critically: never leak raw EdgeQL syntax (the `<…>` generic is invalid TS here). ***/
  const out = Types.mapEdgeQLTypeToTypeScript("tuple<name: str, url: str>", true, false);
  assertEquals(out.includes("tuple<"), false);
  assertEquals(out.includes("array<"), false);
  assertEquals(/\bstr\b/.test(out), false);
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for custom object types", () => {
  /*** For object types that don’t have built-in mappings ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("User", true, false), "User");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("User", false, false), "User | null");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("Post", true, true), "Post[]");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("MyCustomType", false, true), "MyCustomType[] | null");
});

Deno.test("Types - DEFAULT_TYPE_MAPPINGS completeness", () => {
  const expectedTypes = [
    "bool",
    "bytes",
    "cal::local_date",
    "cal::local_datetime",
    "cal::local_time",
    "datetime",
    "decimal",
    "duration",
    "float32",
    "float64",
    "int16",
    "int32",
    "int64",
    "json",
    "str",
    "uuid"
  ];

  for (const type of expectedTypes) {
    const mapping = Types.getTypeMapping(type);
    assertExists(mapping, `Missing mapping for type: ${type}`);
    assertExists(mapping.typescriptType);
    assertExists(mapping.nullableType);
    assertExists(mapping.arrayType);
  }
});

Deno.test("Types - TypeMapping interface structure", () => {
  const mapping = Types.DEFAULT_TYPE_MAPPINGS[0];

  assertExists(mapping.edgeqlType);
  assertExists(mapping.typescriptType);
  assertExists(mapping.nullableType);
  assertExists(mapping.arrayType);

  /*** importRequired is optional ***/
  if (mapping.importRequired !== undefined)
    assertEquals(typeof mapping.importRequired, "string");
});

Deno.test("Types - CodegenConfig interface defaults", () => {
  /*** Test that partial config can be constructed ***/
  const partialConfig: Partial<Types.CodegenConfig> = {
    outputDir: "./test-output",
    target: "client"
  };

  assertEquals(partialConfig.outputDir, "./test-output");
  assertEquals(partialConfig.target, "client");

  /*** Test full config ***/
  const fullConfig: Types.CodegenConfig = {
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    interfaceSuffix: "",
    outputDir: "./generated",
    schemaSource: "./schema.disc",
    target: "both",
    typePrefix: ""
  };

  assertEquals(fullConfig.target, "both");
  assertEquals(fullConfig.includeQueryBuilders, true);
});

Deno.test("Types - PropertyDefinition structure", () => {
  const property: Types.PropertyDefinition = {
    array: false,
    defaultValue: undefined,
    description: "User email address",
    name: "email",
    nullable: false,
    optional: false,
    type: "string"
  };

  assertEquals(property.name, "email");
  assertEquals(property.type, "string");
  assertEquals(property.optional, false);
  assertEquals(property.array, false);
});

Deno.test("Types - TypeDefinition structure", () => {
  const typeDef: Types.TypeDefinition = {
    description: "User entity type",
    export: true,
    extends: [],
    kind: "interface",
    name: "User",
    properties: [{
      array: false,
      name: "id",
      nullable: false,
      optional: false,
      type: "string"
    }]
  };

  assertEquals(typeDef.name, "User");
  assertEquals(typeDef.kind, "interface");
  assertEquals(typeDef.export, true);
  assertEquals(typeDef.properties.length, 1);
});

Deno.test("Types - GeneratedFile structure", () => {
  const file: Types.GeneratedFile = {
    content: "export interface User { id: string; }",
    path: "generated/types.ts",
    type: "types"
  };

  assertEquals(file.path, "generated/types.ts");
  assertEquals(file.type, "types");
  assertEquals(file.content.includes("interface User"), true);
});

Deno.test("Types - CodegenResult structure", () => {
  const result: Types.CodegenResult = {
    errors: [],
    files: [{
      content: "// Generated types",
      path: "types.ts",
      type: "types"
    }],
    warnings: ["Type mapping fallback used"]
  };

  assertEquals(result.files.length, 1);
  assertEquals(result.warnings.length, 1);
  assertEquals(result.errors.length, 0);
});

Deno.test("Types - edge cases for type mapping", () => {
  /*** Test empty string type ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("", true, false), "");

  /*** Module-qualified type names get stripped down to the bare TS identifier. `::` is invalid in
       TS, and cross-module routing is the generator’s job (via resolveTypeReference / namespace
       prefixing) — never let the raw qualifier leak into the type-mapping fallback. ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("My::Special::Type", true, false), "Type");

  /*** `auto` is the parser’s placeholder for computed-property types and must surface as `unknown`
       rather than an invalid TS keyword. ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("auto", true, false), "unknown");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("auto", false, false), "unknown | null");

  /*** Test null safety with arrays ***/
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", false, true), "string[] | null");
});

/*** --- mapEdgeQLTypeToEdgeQLCast tests --- ***/

Deno.test("Types - mapEdgeQLTypeToEdgeQLCast for standard types", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("str"), "<str>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("int32"), "<int32>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("bool"), "<bool>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("datetime"), "<datetime>");
});

Deno.test("Types - mapEdgeQLTypeToEdgeQLCast for all numeric types", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("int16"), "<int16>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("int64"), "<int64>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("float32"), "<float32>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("float64"), "<float64>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("bigint"), "<bigint>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("decimal"), "<decimal>");
});

Deno.test("Types - mapEdgeQLTypeToEdgeQLCast for temporal types", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("duration"), "<duration>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("cal::local_datetime"), "<cal::local_datetime>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("cal::local_date"), "<cal::local_date>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("cal::local_time"), "<cal::local_time>");
});

Deno.test("Types - mapEdgeQLTypeToEdgeQLCast for uuid, bytes, json, sequence", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("uuid"), "<uuid>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("bytes"), "<bytes>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("json"), "<json>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("sequence"), "<sequence>");
});

Deno.test("Types - mapEdgeQLTypeToEdgeQLCast fallback for unknown type", () => {
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("custom_type"), "<custom_type>");
  assertEquals(Types.mapEdgeQLTypeToEdgeQLCast("my_module::MyType"), "<my_module::MyType>");
});

/*** Polymorphic-type codegen (parentTypes → `extends` on the generated interface) is exercised
     end-to-end by codegen/mod.test.ts and the typescript-generator tests that use a realistic
     Schema with type-hierarchy metadata. Adding another fixture would duplicate setup without
     adding signal — the existing "inheritance" tests in the compiler + migration suites already
     cover the parentTypes path. ***/
