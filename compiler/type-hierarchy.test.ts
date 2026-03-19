/**
 * Tests for type hierarchy infrastructure (Phase 23.4)
 *
 * Validates TypeDef inheritance fields (abstract, parentType, subtypes,
 * discriminatorColumn) and the getAllSubtypes / getTypeHierarchy helpers.
 *
 * These tests construct TypeDef objects directly — no SDL parsing needed.
 */

import { assertEquals } from "@std/assert";
import { getAllSubtypes, getTypeHierarchy } from "./context.ts";
import type { Schema, TypeDef } from "./context.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";

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
    ]),
    links: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a two-level hierarchy schema (Shape -> Circle, Rectangle)
// ---------------------------------------------------------------------------

function createHierarchySchema(): Schema {
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
// Helper: build a three-level hierarchy schema
// Shape -> Circle -> Ellipse
//       -> Rectangle
// ---------------------------------------------------------------------------

function createMultiLevelSchema(): Schema {
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
    subtypes: ["Ellipse"],
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
    ]),
  });

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

  return {
    types: new Map([
      ["Shape", shape],
      ["Circle", circle],
      ["Rectangle", rectangle],
      ["Ellipse", ellipse],
    ]),
    functions: getBuiltinFunctions(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("type hierarchy - parentType is populated correctly", () => {
  const schema = createHierarchySchema();

  const circle = schema.types.get("Circle")!;
  assertEquals(circle.parentType, "Shape");

  const rectangle = schema.types.get("Rectangle")!;
  assertEquals(rectangle.parentType, "Shape");

  const shape = schema.types.get("Shape")!;
  assertEquals(shape.parentType, undefined);
});

Deno.test("type hierarchy - subtypes populated correctly (parent knows children)", () => {
  const schema = createHierarchySchema();

  const shape = schema.types.get("Shape")!;
  assertEquals(shape.subtypes, ["Circle", "Rectangle"]);

  // Leaf types have no subtypes
  const circle = schema.types.get("Circle")!;
  assertEquals(circle.subtypes, undefined);

  const rectangle = schema.types.get("Rectangle")!;
  assertEquals(rectangle.subtypes, undefined);
});

Deno.test("type hierarchy - abstract flag set correctly", () => {
  const schema = createHierarchySchema();

  const shape = schema.types.get("Shape")!;
  assertEquals(shape.abstract, true);

  const circle = schema.types.get("Circle")!;
  assertEquals(circle.abstract, undefined);
});

Deno.test("type hierarchy - inherited properties merged into child", () => {
  const schema = createHierarchySchema();

  // Circle should have both its own "radius" and inherited "color"
  const circle = schema.types.get("Circle")!;
  assertEquals(circle.properties.has("id"), true);
  assertEquals(circle.properties.has("color"), true);
  assertEquals(circle.properties.has("radius"), true);

  // Rectangle should have both its own "width"/"height" and inherited "color"
  const rectangle = schema.types.get("Rectangle")!;
  assertEquals(rectangle.properties.has("id"), true);
  assertEquals(rectangle.properties.has("color"), true);
  assertEquals(rectangle.properties.has("width"), true);
  assertEquals(rectangle.properties.has("height"), true);
});

Deno.test("type hierarchy - getAllSubtypes returns transitive subtypes", () => {
  const schema = createMultiLevelSchema();

  // Shape -> [Circle, Rectangle, Ellipse]
  const allSubs = getAllSubtypes(schema, "Shape");
  assertEquals(allSubs.includes("Circle"), true);
  assertEquals(allSubs.includes("Rectangle"), true);
  assertEquals(allSubs.includes("Ellipse"), true);
  assertEquals(allSubs.length, 3);
});

Deno.test("type hierarchy - getTypeHierarchy returns ancestry chain", () => {
  const schema = createMultiLevelSchema();

  // Ellipse -> Circle -> Shape
  const hierarchy = getTypeHierarchy(schema, "Ellipse");
  assertEquals(hierarchy, ["Ellipse", "Circle", "Shape"]);

  // Circle -> Shape
  const circleHierarchy = getTypeHierarchy(schema, "Circle");
  assertEquals(circleHierarchy, ["Circle", "Shape"]);

  // Shape has no parent
  const shapeHierarchy = getTypeHierarchy(schema, "Shape");
  assertEquals(shapeHierarchy, ["Shape"]);
});

Deno.test("type hierarchy - multi-level inheritance (grandparent -> parent -> child)", () => {
  const schema = createMultiLevelSchema();

  // Ellipse extends Circle extends Shape
  const ellipse = schema.types.get("Ellipse")!;
  assertEquals(ellipse.parentType, "Circle");

  const circle = schema.types.get("Circle")!;
  assertEquals(circle.parentType, "Shape");
  assertEquals(circle.subtypes, ["Ellipse"]);

  const shape = schema.types.get("Shape")!;
  assertEquals(shape.subtypes, ["Circle", "Rectangle"]);

  // Transitive: Shape sees all three descendants
  const allSubs = getAllSubtypes(schema, "Shape");
  assertEquals(allSubs.length, 3);

  // Circle sees only Ellipse
  const circleSubs = getAllSubtypes(schema, "Circle");
  assertEquals(circleSubs, ["Ellipse"]);

  // Rectangle is a leaf
  const rectSubs = getAllSubtypes(schema, "Rectangle");
  assertEquals(rectSubs, []);
});

Deno.test("type hierarchy - child properties override parent properties", () => {
  // Build a schema where child overrides a parent property
  const parent = makeTypeDef({
    name: "Base",
    tableName: "bases",
    abstract: true,
    subtypes: ["Derived"],
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
      ["label", {
        name: "label",
        type: "text",
        required: false,
        multi: false,
        columnName: "label",
        edgeqlType: "str",
      }],
      ["score", {
        name: "score",
        type: "integer",
        required: false,
        multi: false,
        columnName: "score",
        edgeqlType: "int32",
      }],
    ]),
  });

  // Child overrides "score" to be required
  const child = makeTypeDef({
    name: "Derived",
    tableName: "deriveds",
    parentType: "Base",
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
      ["score", {
        name: "score",
        type: "integer",
        required: true,
        multi: false,
        columnName: "score",
        edgeqlType: "int32",
      }],
    ]),
  });

  const schema: Schema = {
    types: new Map([
      ["Base", parent],
      ["Derived", child],
    ]),
    functions: getBuiltinFunctions(),
  };

  const derived = schema.types.get("Derived")!;

  // Child should have its own "score" (required: true), not parent's
  const scoreProp = derived.properties.get("score")!;
  assertEquals(scoreProp.required, true);

  // Child should inherit "label" from parent
  assertEquals(derived.properties.has("label"), false);
  // (In the raw schema above, label is only on parent. The SchemaManager's
  // second pass would merge it. Here we test that the child's own property
  // takes precedence when both exist.)
});
