/**
 * Tests for Phase 23.5: Polymorphic Query Compilation
 *
 * Validates:
 * - Parsing of [IS Type] type intersection in paths
 * - Parsing of polymorphic shape fields: [IS Type].property
 * - IS / IS NOT binary operator compilation with discriminator column
 * - Type intersection filtering in compiled SQL
 * - Polymorphic shape field compilation (CASE WHEN)
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { CompilationError } from "../lib/errors.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import type { Schema, TypeDef } from "./context.ts";

// ---------------------------------------------------------------------------
// Helper: build a minimal TypeDef
// ---------------------------------------------------------------------------

function makeTypeDef(
  overrides: Partial<TypeDef> & Pick<TypeDef, "name" | "tableName">,
): TypeDef {
  return {
    kind: "object",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["__type__", {
        name: "__type__",
        type: "text",
        required: true,
        multi: false,
        columnName: "__type__",
        edgeqlType: "str",
      }],
    ]),
    links: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a two-level hierarchy schema (Shape -> Circle, Rectangle)
// ---------------------------------------------------------------------------

function createPolymorphicSchema(): Schema {
  const shape = makeTypeDef({
    name: "Shape",
    tableName: "shapes",
    abstract: true,
    subtypes: ["Circle", "Rectangle"],
    discriminatorColumn: "__type__",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["__type__", {
        name: "__type__",
        type: "text",
        required: true,
        multi: false,
        columnName: "__type__",
        edgeqlType: "str",
      }],
      ["color", {
        name: "color",
        type: "text",
        required: false,
        multi: false,
        columnName: "color",
        edgeqlType: "str",
      }],
    ]),
  });

  const circle = makeTypeDef({
    name: "Circle",
    tableName: "circles",
    parentType: "Shape",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["__type__", {
        name: "__type__",
        type: "text",
        required: true,
        multi: false,
        columnName: "__type__",
        edgeqlType: "str",
      }],
      ["color", {
        name: "color",
        type: "text",
        required: false,
        multi: false,
        columnName: "color",
        edgeqlType: "str",
      }],
      ["radius", {
        name: "radius",
        type: "double precision",
        required: true,
        multi: false,
        columnName: "radius",
        edgeqlType: "float64",
      }],
    ]),
  });

  const rectangle = makeTypeDef({
    name: "Rectangle",
    tableName: "rectangles",
    parentType: "Shape",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["__type__", {
        name: "__type__",
        type: "text",
        required: true,
        multi: false,
        columnName: "__type__",
        edgeqlType: "str",
      }],
      ["color", {
        name: "color",
        type: "text",
        required: false,
        multi: false,
        columnName: "color",
        edgeqlType: "str",
      }],
      ["width", {
        name: "width",
        type: "double precision",
        required: true,
        multi: false,
        columnName: "width",
        edgeqlType: "float64",
      }],
      ["height", {
        name: "height",
        type: "double precision",
        required: true,
        multi: false,
        columnName: "height",
        edgeqlType: "float64",
      }],
    ]),
  });

  return {
    types: new Map([
      ["Shape", shape],
      ["Circle", circle],
      ["Rectangle", rectangle],
    ]),
    functions: getBuiltinFunctions(),
  };
}

// ---------------------------------------------------------------------------
// Helper: three-level hierarchy (Shape -> Circle -> Ellipse, Rectangle)
// ---------------------------------------------------------------------------

function createMultiLevelSchema(): Schema {
  const base = createPolymorphicSchema();
  const types = new Map(base.types);

  // Update Circle to have a subtype
  const circle = types.get("Circle")!;
  types.set("Circle", { ...circle, subtypes: ["Ellipse"] });

  // Add Ellipse as a child of Circle
  const ellipse = makeTypeDef({
    name: "Ellipse",
    tableName: "ellipses",
    parentType: "Circle",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["__type__", {
        name: "__type__",
        type: "text",
        required: true,
        multi: false,
        columnName: "__type__",
        edgeqlType: "str",
      }],
      ["color", {
        name: "color",
        type: "text",
        required: false,
        multi: false,
        columnName: "color",
        edgeqlType: "str",
      }],
      ["radius", {
        name: "radius",
        type: "double precision",
        required: true,
        multi: false,
        columnName: "radius",
        edgeqlType: "float64",
      }],
      ["eccentricity", {
        name: "eccentricity",
        type: "double precision",
        required: true,
        multi: false,
        columnName: "eccentricity",
        edgeqlType: "float64",
      }],
    ]),
  });
  types.set("Ellipse", ellipse);

  return { types, functions: base.functions };
}

// ---------------------------------------------------------------------------
// Helpers: compile EdgeQL to SQL string
// ---------------------------------------------------------------------------

function compileEdgeQL(source: string, schema?: Schema): string {
  const s = schema || createPolymorphicSchema();
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(s);
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

function parseEdgeQL(source: string) {
  const parser = new EdgeQLParser(source);
  return parser.parse();
}

// ---------------------------------------------------------------------------
// Test 1: Parse [IS Circle] in path — AST has type_intersection step
// ---------------------------------------------------------------------------

Deno.test("polymorphic - parse [IS Type] type intersection in path", () => {
  const ast = parseEdgeQL("SELECT Shape[IS Circle]");

  // The SELECT expr should be a path with a type_intersection step
  assertEquals(ast.kind, "SelectQuery");
  const selectQuery = ast;
  const expr = selectQuery.expr;

  // The parser produces a Path: Shape -> [IS Circle]
  assertEquals(expr.kind, "Path");
  if (expr.kind === "Path") {
    // First step is Shape (property), second is type_intersection
    assertEquals(expr.steps.length, 2);
    assertEquals(expr.steps[0].type, "property");
    assertEquals(expr.steps[0].name, "Shape");
    assertEquals(expr.steps[1].type, "type_intersection");
    assertEquals(expr.steps[1].name, "Circle");
  }
});

// ---------------------------------------------------------------------------
// Test 2: Parse polymorphic shape: SELECT Shape { [IS Circle].radius }
// ---------------------------------------------------------------------------

Deno.test("polymorphic - parse polymorphic shape field [IS Type].property", () => {
  const ast = parseEdgeQL("SELECT Shape { [IS Circle].radius }");

  assertEquals(ast.kind, "SelectQuery");
  const selectQuery = ast;
  assertEquals(selectQuery.shape !== undefined, true);

  if (selectQuery.shape) {
    assertEquals(selectQuery.shape.elements.length, 1);
    const element = selectQuery.shape.elements[0];

    // The element should have typeFilter set
    assertEquals(element.typeFilter, "Circle");
    // The property name should be "radius"
    assertEquals(element.name?.name, "radius");
  }
});

// ---------------------------------------------------------------------------
// Test 3: Compile IS for leaf type (no subtypes) -> __type__ = 'Circle'
// ---------------------------------------------------------------------------

Deno.test("polymorphic - compile IS for leaf type produces equality check", () => {
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS Circle");

  // Circle has no subtypes, so it should be __type__ = 'Circle'
  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "'Circle'");
  // Should NOT use IN for a leaf type
  assertEquals(sql.includes("IN ("), false);
});

// ---------------------------------------------------------------------------
// Test 4: Compile IS for parent type with subtypes -> __type__ IN (...)
// ---------------------------------------------------------------------------

Deno.test("polymorphic - compile IS for parent type produces IN check", () => {
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS Shape");

  // Shape has subtypes [Circle, Rectangle], so should use IN
  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "IN");
  assertStringIncludes(sql, "'Shape'");
  assertStringIncludes(sql, "'Circle'");
  assertStringIncludes(sql, "'Rectangle'");
});

// ---------------------------------------------------------------------------
// Test 5: Compile IS NOT -> negated check
// ---------------------------------------------------------------------------

Deno.test("polymorphic - compile IS NOT for leaf type produces != check", () => {
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS NOT Circle");

  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "'Circle'");
  // Should be != for leaf type
  assertStringIncludes(sql, "!=");
});

Deno.test("polymorphic - compile IS NOT for parent type produces NOT IN check", () => {
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS NOT Shape");

  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "NOT IN");
  assertStringIncludes(sql, "'Shape'");
  assertStringIncludes(sql, "'Circle'");
  assertStringIncludes(sql, "'Rectangle'");
});

// ---------------------------------------------------------------------------
// Test 6: Type intersection in filter: SELECT Shape FILTER Shape IS Circle
// ---------------------------------------------------------------------------

Deno.test("polymorphic - IS in filter clause generates WHERE with __type__ check", () => {
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS Circle");

  assertStringIncludes(sql, "WHERE");
  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "'Circle'");
});

// ---------------------------------------------------------------------------
// Test 7: Polymorphic shape field generates CASE WHEN
// ---------------------------------------------------------------------------

Deno.test("polymorphic - shape field [IS Circle].radius produces CASE WHEN", () => {
  const sql = compileEdgeQL("SELECT Shape { color, [IS Circle].radius }");

  // Should have CASE WHEN for the polymorphic field
  assertStringIncludes(sql, "CASE");
  assertStringIncludes(sql, "WHEN");
  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "'Circle'");
  assertStringIncludes(sql, "radius");
  assertStringIncludes(sql, "THEN");
  assertStringIncludes(sql, "ELSE");
  assertStringIncludes(sql, "NULL");
  assertStringIncludes(sql, "END");

  // Should also have the regular color field
  assertStringIncludes(sql, "'color'");
});

// ---------------------------------------------------------------------------
// Test 8: Unknown type in IS -> CompilationError
// ---------------------------------------------------------------------------

Deno.test("polymorphic - IS with unknown type throws CompilationError", () => {
  assertThrows(
    () => compileEdgeQL("SELECT Shape FILTER .id IS UnknownType"),
    CompilationError,
    "not found",
  );
});

// ---------------------------------------------------------------------------
// Test 9: Multiple polymorphic fields in same shape
// ---------------------------------------------------------------------------

Deno.test("polymorphic - multiple polymorphic fields in same shape", () => {
  const sql = compileEdgeQL(
    "SELECT Shape { [IS Circle].radius, [IS Rectangle].width }",
  );

  // Should have two CASE WHEN expressions
  // Count CASE occurrences
  const caseCount = (sql.match(/CASE/g) || []).length;
  assertEquals(
    caseCount >= 2,
    true,
    `Expected at least 2 CASE expressions, got ${caseCount}`,
  );

  assertStringIncludes(sql, "radius");
  assertStringIncludes(sql, "width");
  assertStringIncludes(sql, "'Circle'");
  assertStringIncludes(sql, "'Rectangle'");
});

// ---------------------------------------------------------------------------
// Test 10: Nested hierarchy — IS check includes transitive subtypes
// ---------------------------------------------------------------------------

Deno.test("polymorphic - IS on type with nested subtypes includes transitive children", () => {
  const schema = createMultiLevelSchema();
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS Circle", schema);

  // Circle has subtype Ellipse, so IS Circle should match both
  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "IN");
  assertStringIncludes(sql, "'Circle'");
  assertStringIncludes(sql, "'Ellipse'");
});

// ---------------------------------------------------------------------------
// Test 11: IS with non-abstract (leaf) type
// ---------------------------------------------------------------------------

Deno.test("polymorphic - IS with leaf type (Rectangle) uses simple equality", () => {
  const sql = compileEdgeQL("SELECT Shape FILTER .id IS Rectangle");

  // Rectangle is a leaf with no subtypes
  assertStringIncludes(sql, "__type__");
  assertStringIncludes(sql, "'Rectangle'");
  // Should use = not IN
  assertEquals(sql.includes("IN ("), false);
});

// ---------------------------------------------------------------------------
// Test 12: Type intersection path step parsing
// ---------------------------------------------------------------------------

Deno.test("polymorphic - type intersection [IS Type] is distinct from array indexing", () => {
  // [IS Type] should produce a type_intersection path step
  const astTypeIntersect = parseEdgeQL("SELECT Shape[IS Circle]");
  assertEquals(astTypeIntersect.kind, "SelectQuery");
  if (astTypeIntersect.expr.kind === "Path") {
    const lastStep =
      astTypeIntersect.expr.steps[astTypeIntersect.expr.steps.length - 1];
    assertEquals(lastStep.type, "type_intersection");
    assertEquals(lastStep.name, "Circle");
  }

  // [0] should produce an IndexExpression (array indexing)
  const astIndex = parseEdgeQL("SELECT Shape[0]");
  assertEquals(astIndex.kind, "SelectQuery");
  // The expr should be an IndexExpression
  assertEquals(astIndex.expr.kind, "IndexExpression");
});

// ---------------------------------------------------------------------------
// Test 13: Polymorphic shape with type that has nested subtypes
// ---------------------------------------------------------------------------

Deno.test("polymorphic - polymorphic shape field with nested subtypes includes them in CASE WHEN", () => {
  const schema = createMultiLevelSchema();
  const sql = compileEdgeQL("SELECT Shape { [IS Circle].radius }", schema);

  // Circle has subtype Ellipse, so the CASE WHEN should match both
  assertStringIncludes(sql, "CASE");
  assertStringIncludes(sql, "'Circle'");
  assertStringIncludes(sql, "'Ellipse'");
  assertStringIncludes(sql, "IN");
  assertStringIncludes(sql, "radius");
});

// ---------------------------------------------------------------------------
// Test 14: Polymorphic shape field with unknown type -> CompilationError
// ---------------------------------------------------------------------------

Deno.test("polymorphic - polymorphic shape field with unknown type throws error", () => {
  assertThrows(
    () => compileEdgeQL("SELECT Shape { [IS Triangle].sides }"),
    CompilationError,
    "not found",
  );
});
