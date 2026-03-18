/**
 * Codegen types module tests
 */

import { assertEquals, assertExists } from "@std/assert";
import * as Types from "./types.ts";

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
  // Required string
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", true, false), "string");

  // Optional string
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("str", false, false),
    "string | null",
  );

  // Required string array
  assertEquals(Types.mapEdgeQLTypeToTypeScript("str", true, true), "string[]");

  // Optional string array
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("str", false, true),
    "string[] | null",
  );
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for numeric types", () => {
  assertEquals(Types.mapEdgeQLTypeToTypeScript("int32", true, false), "number");
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("float64", false, false),
    "number | null",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("decimal", true, true),
    "number[]",
  );
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for datetime types", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("datetime", true, false),
    "Date",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_datetime", false, false),
    "Date | null",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_date", true, false),
    "string",
  );
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_time", true, true),
    "string[]",
  );
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for special types", () => {
  assertEquals(Types.mapEdgeQLTypeToTypeScript("uuid", true, false), "string");
  assertEquals(Types.mapEdgeQLTypeToTypeScript("json", true, false), "unknown");
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("bytes", false, false),
    "Uint8Array | null",
  );
});

Deno.test("Types - mapEdgeQLTypeToTypeScript for custom object types", () => {
  // For object types that don't have built-in mappings
  assertEquals(Types.mapEdgeQLTypeToTypeScript("User", true, false), "User");
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("User", false, false),
    "User | null",
  );
  assertEquals(Types.mapEdgeQLTypeToTypeScript("Post", true, true), "Post[]");
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("MyCustomType", false, true),
    "MyCustomType[] | null",
  );
});

Deno.test("Types - DEFAULT_TYPE_MAPPINGS completeness", () => {
  const expectedTypes = [
    "str",
    "bool",
    "int16",
    "int32",
    "int64",
    "float32",
    "float64",
    "decimal",
    "uuid",
    "datetime",
    "duration",
    "bytes",
    "json",
    "cal::local_datetime",
    "cal::local_date",
    "cal::local_time",
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

  // importRequired is optional
  if (mapping.importRequired !== undefined) {
    assertEquals(typeof mapping.importRequired, "string");
  }
});

Deno.test("Types - CodegenConfig interface defaults", () => {
  // Test that partial config can be constructed
  const partialConfig: Partial<Types.CodegenConfig> = {
    outputDir: "./test-output",
    target: "client",
  };

  assertEquals(partialConfig.outputDir, "./test-output");
  assertEquals(partialConfig.target, "client");

  // Test full config
  const fullConfig: Types.CodegenConfig = {
    outputDir: "./generated",
    schemaSource: "./schema.esdl",
    target: "both",
    typePrefix: "",
    interfaceSuffix: "",
    includeQueryBuilders: true,
    includeMutations: true,
    includeClient: true,
    formatOutput: true,
  };

  assertEquals(fullConfig.target, "both");
  assertEquals(fullConfig.includeQueryBuilders, true);
});

Deno.test("Types - PropertyDefinition structure", () => {
  const property: Types.PropertyDefinition = {
    name: "email",
    type: "string",
    optional: false,
    nullable: false,
    array: false,
    description: "User email address",
    defaultValue: undefined,
  };

  assertEquals(property.name, "email");
  assertEquals(property.type, "string");
  assertEquals(property.optional, false);
  assertEquals(property.array, false);
});

Deno.test("Types - TypeDefinition structure", () => {
  const typeDef: Types.TypeDefinition = {
    name: "User",
    kind: "interface",
    properties: [{
      name: "id",
      type: "string",
      optional: false,
      nullable: false,
      array: false,
    }],
    extends: [],
    export: true,
    description: "User entity type",
  };

  assertEquals(typeDef.name, "User");
  assertEquals(typeDef.kind, "interface");
  assertEquals(typeDef.export, true);
  assertEquals(typeDef.properties.length, 1);
});

Deno.test("Types - GeneratedFile structure", () => {
  const file: Types.GeneratedFile = {
    path: "generated/types.ts",
    content: "export interface User { id: string; }",
    type: "types",
  };

  assertEquals(file.path, "generated/types.ts");
  assertEquals(file.type, "types");
  assertEquals(file.content.includes("interface User"), true);
});

Deno.test("Types - CodegenResult structure", () => {
  const result: Types.CodegenResult = {
    files: [{
      path: "types.ts",
      content: "// Generated types",
      type: "types",
    }],
    warnings: ["Type mapping fallback used"],
    errors: [],
  };

  assertEquals(result.files.length, 1);
  assertEquals(result.warnings.length, 1);
  assertEquals(result.errors.length, 0);
});

Deno.test("Types - edge cases for type mapping", () => {
  // Test empty string type
  assertEquals(Types.mapEdgeQLTypeToTypeScript("", true, false), "");

  // Test type with special characters (should be handled by custom type logic)
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("My::Special::Type", true, false),
    "My::Special::Type",
  );

  // Test null safety with arrays
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("str", false, true),
    "string[] | null",
  );
});
