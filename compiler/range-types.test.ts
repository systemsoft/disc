/**
 * Range & Multirange Type System Tests
 *
 * Verifies that range<T> and multirange<T> parameterized types are correctly
 * handled across the Disc compilation pipeline:
 *   - AST TypeRef creation with params field
 *   - SDL parser handling of angle-bracket type parameters
 *   - typeToString() serialization in the differ
 *   - DDL mapEdgeQLTypeToPostgreSQL() returns correct PG types
 *   - Validator accepts valid inner types and rejects invalid ones
 *   - Full SDL -> schema flow: SchemaManager produces correct SQL types
 *
 * Range type mappings:
 *   range<int32>             -> PG int4range
 *   range<int64>             -> PG int8range
 *   range<float64>           -> PG numrange
 *   range<decimal>           -> PG numrange
 *   range<datetime>          -> PG tstzrange
 *   range<cal::local_date>   -> PG daterange
 *   range<cal::local_datetime> -> PG tsrange
 *
 * Multirange type mappings:
 *   multirange<int32>             -> PG int4multirange
 *   multirange<int64>             -> PG int8multirange
 *   multirange<float64>           -> PG nummultirange
 *   multirange<decimal>           -> PG nummultirange
 *   multirange<datetime>          -> PG tstzmultirange
 *   multirange<cal::local_date>   -> PG datemultirange
 *   multirange<cal::local_datetime> -> PG tsmultirange
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaDiffer } from "../migration/differ.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import * as MigrationTypes from "../migration/types.ts";
import * as AST from "../schema/ast.ts";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { Schema } from "./context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse SDL source into a compiler-ready Schema via SchemaManager.
 */
function createSchemaFromSDL(sdl: string): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }
  return manager.modulesToSchema(parseResult.value);
}

// ============================================================
// 1. AST TypeRef creation with params
// ============================================================

Deno.test("AST - createTypeRef with params produces correct TypeRef", () => {
  const innerName = AST.createQualifiedName(["int32"]);
  const innerRef = AST.createTypeRef(innerName);
  const outerName = AST.createQualifiedName(["range"]);
  const outerRef = AST.createTypeRef(outerName, false, false, [innerRef]);

  assertEquals(outerRef.kind, "TypeRef");
  assertEquals(outerRef.name.parts, ["range"]);
  assertEquals(outerRef.params !== undefined, true);
  assertEquals(outerRef.params!.length, 1);
  assertEquals(outerRef.params![0].name.parts, ["int32"]);
});

Deno.test("AST - createTypeRef without params has no params field", () => {
  const name = AST.createQualifiedName(["str"]);
  const ref = AST.createTypeRef(name);

  assertEquals(ref.params, undefined);
});

// ============================================================
// 2. SDL parser - parseTypeRef() with angle brackets
// ============================================================

Deno.test("Parser - parses range<int32> property type", () => {
  const sdl = `
    type Booking {
      required price_range: range<int32>;
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();

  const typeDecl = doc.declarations[0] as AST.TypeDeclaration;
  const prop = typeDecl.members[0] as AST.PropertyDeclaration;

  assertEquals(prop.type.name.parts, ["range"]);
  assertEquals(prop.type.params !== undefined, true);
  assertEquals(prop.type.params!.length, 1);
  assertEquals(prop.type.params![0].name.parts, ["int32"]);
});

Deno.test("Parser - parses multirange<datetime> property type", () => {
  const sdl = `
    type Schedule {
      availability: multirange<datetime>;
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();

  const typeDecl = doc.declarations[0] as AST.TypeDeclaration;
  const prop = typeDecl.members[0] as AST.PropertyDeclaration;

  assertEquals(prop.type.name.parts, ["multirange"]);
  assertEquals(prop.type.params !== undefined, true);
  assertEquals(prop.type.params!.length, 1);
  assertEquals(prop.type.params![0].name.parts, ["datetime"]);
});

Deno.test("Parser - parses range<cal::local_date> with qualified inner type", () => {
  const sdl = `
    type Reservation {
      stay_dates: range<cal::local_date>;
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();

  const typeDecl = doc.declarations[0] as AST.TypeDeclaration;
  const prop = typeDecl.members[0] as AST.PropertyDeclaration;

  assertEquals(prop.type.name.parts, ["range"]);
  assertEquals(prop.type.params![0].name.parts, ["cal", "local_date"]);
});

// ============================================================
// 3. Differ - typeToString() serialization
// ============================================================

Deno.test("Differ - typeToString() serializes range<int32> correctly", () => {
  const sdl = `
    type TestType {
      required val: range<int32>;
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const converter = new SDLConverter();
  const modules = converter.convertToModules(doc);

  const differ = new SchemaDiffer();
  const ops = differ.diff([], modules);

  // The CreateType operation should have a property with type "range<int32>"
  const createOp = ops.find((op) => op.kind === "CreateType") as MigrationTypes.CreateTypeOperation;
  assertEquals(createOp !== undefined, true);

  const valProp = createOp.properties.find((p) => p.name === "val");
  assertEquals(valProp !== undefined, true);
  assertEquals(valProp!.type, "range<int32>");
});

Deno.test("Differ - typeToString() serializes multirange<cal::local_date> correctly", () => {
  const sdl = `
    type TestType {
      dates: multirange<cal::local_date>;
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const converter = new SDLConverter();
  const modules = converter.convertToModules(doc);

  const differ = new SchemaDiffer();
  const ops = differ.diff([], modules);

  const createOp = ops.find((op) => op.kind === "CreateType") as MigrationTypes.CreateTypeOperation;
  const datesProp = createOp.properties.find((p) => p.name === "dates");
  assertEquals(datesProp!.type, "multirange<cal::local_date>");
});

// ============================================================
// 4. DDL Generator - mapEdgeQLTypeToPostgreSQL()
// ============================================================

Deno.test("DDL Generator - range<int32> generates INT4RANGE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Booking",
    properties: [
      {
        name: "price_range",
        type: "range<int32>",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "INT4RANGE");
});

Deno.test("DDL Generator - range<int64> generates INT8RANGE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Test",
    properties: [
      {
        name: "big_range",
        type: "range<int64>",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createTable!, "INT8RANGE");
});

Deno.test("DDL Generator - range<datetime> generates TSTZRANGE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Meeting",
    properties: [
      {
        name: "time_slot",
        type: "range<datetime>",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createTable!, "TSTZRANGE");
});

Deno.test("DDL Generator - multirange<int32> generates INT4MULTIRANGE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Inventory",
    properties: [
      {
        name: "price_ranges",
        type: "multirange<int32>",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createTable!, "INT4MULTIRANGE");
});

Deno.test("DDL Generator - multirange<cal::local_date> generates DATEMULTIRANGE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Schedule",
    properties: [
      {
        name: "blocked_dates",
        type: "multirange<cal::local_date>",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertStringIncludes(createTable!, "DATEMULTIRANGE");
});

// ============================================================
// 5. Validator - accepts valid inner types, rejects invalid
// ============================================================

Deno.test("Validator - accepts range<int32> as valid", () => {
  const sdl = `
    module default {
      type TestType {
        val: range<int32>;
      };
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Validator - accepts multirange<datetime> as valid", () => {
  const sdl = `
    module default {
      type TestType {
        val: multirange<datetime>;
      };
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Validator - rejects range<str> as invalid", () => {
  const sdl = `
    module default {
      type TestType {
        val: range<str>;
      };
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, false);
  assertEquals(result.errors !== undefined, true);
  assertStringIncludes(result.errors![0].message, "not a valid inner type");
});

Deno.test("Validator - rejects range<bool> as invalid", () => {
  const sdl = `
    module default {
      type TestType {
        val: range<bool>;
      };
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, false);
  assertStringIncludes(result.errors![0].message, "not a valid inner type");
});

// ============================================================
// 6. Full SDL -> Schema flow via SchemaManager
// ============================================================

Deno.test("SchemaManager - range<int32> property has correct edgeqlType", () => {
  const sdl = `
    type Booking {
      required price_range: range<int32>;
    }
  `;
  const schema = createSchemaFromSDL(sdl);
  const bookingType = schema.types.get("Booking");
  assertEquals(bookingType !== undefined, true);

  const prop = bookingType!.properties.get("price_range");
  assertEquals(prop !== undefined, true);
  assertEquals(prop!.edgeqlType, "range<int32>");
  assertEquals(prop!.type, "int4range");
});

Deno.test("SchemaManager - multirange<cal::local_date> property has correct SQL type", () => {
  const sdl = `
    type Schedule {
      blocked_dates: multirange<cal::local_date>;
    }
  `;
  const schema = createSchemaFromSDL(sdl);
  const scheduleType = schema.types.get("Schedule");
  assertEquals(scheduleType !== undefined, true);

  const prop = scheduleType!.properties.get("blocked_dates");
  assertEquals(prop !== undefined, true);
  assertEquals(prop!.edgeqlType, "multirange<cal::local_date>");
  assertEquals(prop!.type, "datemultirange");
});
