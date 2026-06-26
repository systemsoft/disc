/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Collection Type Properties Tests (array<T>, tuple<T1, T2, ...>)
 *
 * Verifies that collection types are correctly handled across the Disc
 * compilation pipeline:
 *   - Parser: array<str>, tuple<int64, str>, tuple<float64, float64, bool>
 *     parse correctly with params
 *   - Validator: array with 0 or 2+ params rejected, tuple with 0 params
 *     rejected, valid types accepted
 *   - DDL: mapEdgeQLTypeToPostgreSQL returns correct PG types
 *   - Schema-manager: sdlTypeToSqlType returns correct types
 *   - Differ: typeToString handles collection types
 *
 * Array type mappings:
 *   array<str>       -> TEXT[]
 *   array<int64>     -> BIGINT[]
 *   array<float64>   -> DOUBLE PRECISION[]
 *   array<bool>      -> BOOLEAN[]
 *   array<uuid>      -> UUID[]
 *   array<json>      -> JSONB[]
 *   etc.
 *
 * Tuple type mappings:
 *   tuple<*>         -> JSONB (PostgreSQL has no native tuple type)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { edgeqlTypeToPgType } from "./compiler-base.ts";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaDiffer } from "../migration/differ.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import * as MigrationTypes from "../migration/types.ts";
import * as AST from "../schema/ast.ts";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSDL(sdl: string): AST.SDLDocument {
  const parser = new SDLParser(sdl);
  return parser.parse();
}

function createSchemaFromSDL(sdl: string) {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }
  return manager.modulesToSchema(parseResult.value);
}

// ============================================================
// 1. Parser: collection types parse correctly
// ============================================================

Deno.test("Parser - array<str> parses with one type param", () => {
  const doc = parseSDL(`
    type Config {
      required tags: array<str>;
    }
  `);

  const typeDecl = doc.declarations[0] as AST.TypeDeclaration;
  const prop = typeDecl.members[0] as AST.PropertyDeclaration;

  assertEquals(prop.type.name.parts, ["array"]);
  assertEquals(prop.type.params !== undefined, true);
  assertEquals(prop.type.params!.length, 1);
  assertEquals(prop.type.params![0].name.parts, ["str"]);
});

Deno.test("Parser - tuple<int64, str> parses with two type params", () => {
  const doc = parseSDL(`
    type Point {
      required coord: tuple<int64, str>;
    }
  `);

  const typeDecl = doc.declarations[0] as AST.TypeDeclaration;
  const prop = typeDecl.members[0] as AST.PropertyDeclaration;

  assertEquals(prop.type.name.parts, ["tuple"]);
  assertEquals(prop.type.params !== undefined, true);
  assertEquals(prop.type.params!.length, 2);
  assertEquals(prop.type.params![0].name.parts, ["int64"]);
  assertEquals(prop.type.params![1].name.parts, ["str"]);
});

Deno.test("Parser - tuple<float64, float64, bool> parses with three type params", () => {
  const doc = parseSDL(`
    type GeoPoint {
      required position: tuple<float64, float64, bool>;
    }
  `);

  const typeDecl = doc.declarations[0] as AST.TypeDeclaration;
  const prop = typeDecl.members[0] as AST.PropertyDeclaration;

  assertEquals(prop.type.name.parts, ["tuple"]);
  assertEquals(prop.type.params !== undefined, true);
  assertEquals(prop.type.params!.length, 3);
  assertEquals(prop.type.params![0].name.parts, ["float64"]);
  assertEquals(prop.type.params![1].name.parts, ["float64"]);
  assertEquals(prop.type.params![2].name.parts, ["bool"]);
});

// ============================================================
// 2. Validator: collection type parameter count checks
// ============================================================

Deno.test("Validator - array with exactly 1 param is valid", () => {
  const doc = parseSDL(`
    type Config {
      required tags: array<str>;
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Validator - tuple with 1 param is valid", () => {
  const doc = parseSDL(`
    type Config {
      required value: tuple<int64>;
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Validator - tuple with multiple params is valid", () => {
  const doc = parseSDL(`
    type Config {
      required coord: tuple<float64, float64>;
    }
  `);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Validator - array with 0 params is rejected", () => {
  // Construct AST manually since parser won't produce array without params
  const doc: AST.SDLDocument = {
    kind: "SDLDocument",
    declarations: [
      {
        kind: "TypeDeclaration",
        name: AST.createIdentifier("Config"),
        members: [
          {
            kind: "PropertyDeclaration",
            name: AST.createIdentifier("tags"),
            type: AST.createTypeRef(AST.createQualifiedName(["array"])),
            required: true
          }
        ]
      }
    ]
  };

  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, false);
  assertStringIncludes(result.errors![0].message, "array");
  assertStringIncludes(result.errors![0].message, "exactly one type parameter");
});

Deno.test("Validator - array with 2 params is rejected", () => {
  const doc: AST.SDLDocument = {
    kind: "SDLDocument",
    declarations: [
      {
        kind: "TypeDeclaration",
        name: AST.createIdentifier("Config"),
        members: [
          {
            kind: "PropertyDeclaration",
            name: AST.createIdentifier("tags"),
            type: AST.createTypeRef(
              AST.createQualifiedName(["array"]),
              false,
              false,
              [
                AST.createTypeRef(AST.createQualifiedName(["str"])),
                AST.createTypeRef(AST.createQualifiedName(["int64"]))
              ]
            ),
            required: true
          }
        ]
      }
    ]
  };

  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, false);
  assertStringIncludes(result.errors![0].message, "array");
  assertStringIncludes(result.errors![0].message, "exactly one type parameter");
});

Deno.test("Validator - tuple with 0 params is rejected", () => {
  const doc: AST.SDLDocument = {
    kind: "SDLDocument",
    declarations: [
      {
        kind: "TypeDeclaration",
        name: AST.createIdentifier("Config"),
        members: [
          {
            kind: "PropertyDeclaration",
            name: AST.createIdentifier("value"),
            type: AST.createTypeRef(AST.createQualifiedName(["tuple"])),
            required: true
          }
        ]
      }
    ]
  };

  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, false);
  assertStringIncludes(result.errors![0].message, "tuple");
  assertStringIncludes(
    result.errors![0].message,
    "at least one type parameter"
  );
});

// ============================================================
// 3. DDL: mapEdgeQLTypeToPostgreSQL returns correct PG types
// ============================================================

Deno.test("DDL - array<str> maps to TEXT[]", () => {
  const ddl = new DDLGenerator();
  const ops: MigrationTypes.CreateTypeOperation[] = [
    {
      kind: "CreateType",
      typeName: "Config",
      properties: [
        {
          name: "tags",
          type: "array<str>",
          required: true,
          multi: false,
          constraints: [],
          annotations: {}
        }
      ],
      links: []
    }
  ];

  const statements = ddl.generateDDL(ops);
  const createStmt = statements.find(s => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createStmt!, "TEXT[]");
});

Deno.test("DDL - array<int64> maps to BIGINT[]", () => {
  const ddl = new DDLGenerator();
  const ops: MigrationTypes.CreateTypeOperation[] = [
    {
      kind: "CreateType",
      typeName: "Config",
      properties: [
        {
          name: "scores",
          type: "array<int64>",
          required: true,
          multi: false,
          constraints: [],
          annotations: {}
        }
      ],
      links: []
    }
  ];

  const statements = ddl.generateDDL(ops);
  const createStmt = statements.find(s => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createStmt!, "BIGINT[]");
});

Deno.test("DDL - tuple<str, int64> maps to JSONB", () => {
  const ddl = new DDLGenerator();
  const ops: MigrationTypes.CreateTypeOperation[] = [
    {
      kind: "CreateType",
      typeName: "Config",
      properties: [
        {
          name: "pair",
          type: "tuple<str, int64>",
          required: true,
          multi: false,
          constraints: [],
          annotations: {}
        }
      ],
      links: []
    }
  ];

  const statements = ddl.generateDDL(ops);
  const createStmt = statements.find(s => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createStmt!, "JSONB");
});

// ============================================================
// 4. Schema-manager: sdlTypeToSqlType returns correct types
// ============================================================

Deno.test("SchemaManager - array<str> property gets text[] SQL type", () => {
  const schema = createSchemaFromSDL(`
    type Config {
      required tags: array<str>;
    }
  `);

  const configType = schema.types.get("Config");
  assertEquals(configType !== undefined, true);
  const tagsProp = configType!.properties.get("tags");
  assertEquals(tagsProp !== undefined, true);
  assertEquals(tagsProp!.type, "text[]");
  assertEquals(tagsProp!.edgeqlType, "array<str>");
});

Deno.test("SchemaManager - array<int32> property gets integer[] SQL type", () => {
  const schema = createSchemaFromSDL(`
    type Config {
      required counts: array<int32>;
    }
  `);

  const configType = schema.types.get("Config");
  const countsProp = configType!.properties.get("counts");
  assertEquals(countsProp!.type, "integer[]");
  assertEquals(countsProp!.edgeqlType, "array<int32>");
});

Deno.test("SchemaManager - tuple<float64, float64> property gets jsonb SQL type", () => {
  const schema = createSchemaFromSDL(`
    type GeoPoint {
      required coord: tuple<float64, float64>;
    }
  `);

  const geoType = schema.types.get("GeoPoint");
  assertEquals(geoType !== undefined, true);
  const coordProp = geoType!.properties.get("coord");
  assertEquals(coordProp !== undefined, true);
  assertEquals(coordProp!.type, "jsonb");
  assertEquals(coordProp!.edgeqlType, "tuple<float64, float64>");
});

// Arrow-form (`name -> Type`) collection properties parse as LinkDeclarations
// and must preserve their type parameters through reclassification, exactly
// like the colon form. Regression for bare `<tuple>`/`<array>` casts in codegen.
Deno.test("SchemaManager - arrow-form array<str> property preserves element type", () => {
  const schema = createSchemaFromSDL(`
    type Config {
      captions -> array<str>;
    }
  `);
  const prop = schema.types.get("Config")!.properties.get("captions");
  assertEquals(prop!.type, "text[]");
  assertEquals(prop!.edgeqlType, "array<str>");
});

Deno.test("SchemaManager - arrow-form named tuple property preserves field types", () => {
  const schema = createSchemaFromSDL(`
    type Profile {
      client -> tuple<name: str, url: str>;
    }
  `);
  const prop = schema.types.get("Profile")!.properties.get("client");
  assertEquals(prop!.type, "jsonb");
  assertEquals(prop!.edgeqlType, "tuple<name: str, url: str>");
});

Deno.test("SchemaManager - arrow-form array-of-tuple property preserves full type", () => {
  const schema = createSchemaFromSDL(`
    type Page {
      links -> array<tuple<title: str, url: str>>;
    }
  `);
  const prop = schema.types.get("Page")!.properties.get("links");
  assertEquals(prop!.type, "jsonb");
  assertEquals(prop!.edgeqlType, "array<tuple<title: str, url: str>>");
});

// ============================================================
// 5. Differ: typeToString handles collection types
// ============================================================

Deno.test("Differ - typeToString serializes array<str> correctly", () => {
  const differ = new SchemaDiffer();
  const oldModules: AST.SDLDocument = parseSDL("");
  const newModules: AST.SDLDocument = parseSDL(`
    type Config {
      required tags: array<str>;
    }
  `);

  const converter = new SDLConverter();
  const newMods = converter.convertToModules(newModules);
  const oldMods = converter.convertToModules(oldModules);

  const ops = differ.diff(oldMods, newMods);
  const createOp = ops.find(
    o => o.kind === "CreateType"
  ) as MigrationTypes.CreateTypeOperation;

  const tagsProp = createOp.properties.find(p => p.name === "tags");
  assertEquals(tagsProp !== undefined, true);
  assertEquals(tagsProp!.type, "array<str>");
});

Deno.test("Differ - typeToString serializes tuple<int64, str> correctly", () => {
  const doc = parseSDL(`
    type Config {
      required pair: tuple<int64, str>;
    }
  `);

  const converter = new SDLConverter();
  const emptyMods = converter.convertToModules(parseSDL(""));
  const newMods = converter.convertToModules(doc);

  const differ = new SchemaDiffer();
  const ops = differ.diff(emptyMods, newMods);
  const createOp = ops.find(
    o => o.kind === "CreateType"
  ) as MigrationTypes.CreateTypeOperation;

  const pairProp = createOp.properties.find(p => p.name === "pair");
  assertEquals(pairProp !== undefined, true);
  assertEquals(pairProp!.type, "tuple<int64, str>");
});

Deno.test("Differ - typeToString serializes tuple<float64, float64, bool> correctly", () => {
  const doc = parseSDL(`
    type GeoPoint {
      required position: tuple<float64, float64, bool>;
    }
  `);

  const converter = new SDLConverter();
  const emptyMods = converter.convertToModules(parseSDL(""));
  const newMods = converter.convertToModules(doc);

  const differ = new SchemaDiffer();
  const ops = differ.diff(emptyMods, newMods);
  const createOp = ops.find(
    o => o.kind === "CreateType"
  ) as MigrationTypes.CreateTypeOperation;

  const positionProp = createOp.properties.find(p => p.name === "position");
  assertEquals(positionProp !== undefined, true);
  assertEquals(positionProp!.type, "tuple<float64, float64, bool>");
});

// ============================================================
// 6. Converter: sdlTypeToSqlType handles collection types
// ============================================================

Deno.test("Converter - sdlTypeToSqlType maps array<str> to TEXT[]", () => {
  const converter = new SDLConverter();
  assertEquals(converter.sdlTypeToSqlType("array<str>"), "TEXT[]");
});

Deno.test("Converter - sdlTypeToSqlType maps array<int64> to BIGINT[]", () => {
  const converter = new SDLConverter();
  assertEquals(converter.sdlTypeToSqlType("array<int64>"), "BIGINT[]");
});

Deno.test("Converter - sdlTypeToSqlType maps tuple<str, int64> to JSONB", () => {
  const converter = new SDLConverter();
  assertEquals(converter.sdlTypeToSqlType("tuple<str, int64>"), "JSONB");
});

// ============================================================
// 7. edgeqlTypeToPgType: cast target types (param binding)
// ============================================================

Deno.test("edgeqlTypeToPgType - array<str> maps to text[]", () => {
  assertEquals(edgeqlTypeToPgType("array<str>"), "text[]");
});

Deno.test("edgeqlTypeToPgType - tuple maps to jsonb", () => {
  assertEquals(edgeqlTypeToPgType("tuple<name: str, url: str>"), "jsonb");
  assertEquals(edgeqlTypeToPgType("tuple<str, str>"), "jsonb");
});

Deno.test("edgeqlTypeToPgType - array of tuple maps to jsonb (not a PG array)", () => {
  assertEquals(edgeqlTypeToPgType("array<tuple<title: str, url: str>>"), "jsonb");
  assertEquals(edgeqlTypeToPgType("array<tuple<str, str>>"), "jsonb");
});
