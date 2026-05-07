/**
 * Tests for Type Hierarchy DDL Generation (Phase 23.6)
 *
 * Verifies that the DDL generator correctly adds __type__ discriminator
 * columns for types participating in an inheritance hierarchy.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DDLGenerator } from "./ddl.ts";
import * as Types from "./types.ts";

// ============================================================
// Test 1: Parent type with subtypes gets __type__ column
// ============================================================

Deno.test("DDL Type Hierarchy - parent type with subtypes gets __type__ column in DDL", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Shape",
    properties: [
      {
        name: "color",
        type: "str",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    abstract: true,
    subtypes: ["Circle", "Rectangle"],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));

  assertEquals(
    createTable !== undefined,
    true,
    "Should have a CREATE TABLE statement",
  );
  assertStringIncludes(createTable!, "__type__");
  assertStringIncludes(createTable!, "VARCHAR(255)");
  assertStringIncludes(createTable!, "NOT NULL");
  assertStringIncludes(createTable!, "DEFAULT 'Shape'");
});

// ============================================================
// Test 2: Child type gets __type__ column with its own name as default
// ============================================================

Deno.test("DDL Type Hierarchy - child type gets __type__ column with own name as default", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Circle",
    properties: [
      {
        name: "radius",
        type: "float64",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    parentTypes: ["Shape"],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));

  assertEquals(
    createTable !== undefined,
    true,
    "Should have a CREATE TABLE statement",
  );
  assertStringIncludes(createTable!, "__type__");
  assertStringIncludes(createTable!, "DEFAULT 'Circle'");
});

// ============================================================
// Test 3: Multi-level hierarchy — all levels get __type__ column
// ============================================================

Deno.test("DDL Type Hierarchy - multi-level hierarchy: all levels get __type__ column", () => {
  const generator = new DDLGenerator();

  // Shape (root, abstract, has subtypes)
  const shapeOp: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Shape",
    properties: [
      {
        name: "color",
        type: "str",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    abstract: true,
    subtypes: ["Circle"],
  };

  // Circle (middle, has parent and subtypes)
  const circleOp: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Circle",
    properties: [
      {
        name: "radius",
        type: "float64",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    parentTypes: ["Shape"],
    subtypes: ["Ellipse"],
  };

  // Ellipse (leaf, has parent, no subtypes)
  const ellipseOp: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Ellipse",
    properties: [
      {
        name: "eccentricity",
        type: "float64",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    parentTypes: ["Circle"],
  };

  const statements = generator.generateDDL([shapeOp, circleOp, ellipseOp]);
  const createStatements = statements.filter((s) => s.startsWith("CREATE TABLE"));

  assertEquals(
    createStatements.length,
    3,
    "Should have 3 CREATE TABLE statements",
  );

  // All three should have __type__ column
  for (const stmt of createStatements) {
    assertStringIncludes(stmt, "__type__");
    assertStringIncludes(stmt, "VARCHAR(255)");
    assertStringIncludes(stmt, "NOT NULL");
  }

  // Verify each has its own type name as default
  const shapeTable = createStatements.find((s) => s.includes("DEFAULT 'Shape'"));
  assertEquals(
    shapeTable !== undefined,
    true,
    "Shape table should default to 'Shape'",
  );

  const circleTable = createStatements.find((s) => s.includes("DEFAULT 'Circle'"));
  assertEquals(
    circleTable !== undefined,
    true,
    "Circle table should default to 'Circle'",
  );

  const ellipseTable = createStatements.find((s) => s.includes("DEFAULT 'Ellipse'"));
  assertEquals(
    ellipseTable !== undefined,
    true,
    "Ellipse table should default to 'Ellipse'",
  );
});

// ============================================================
// Test 4: Types without hierarchy don't get __type__ column
// ============================================================

Deno.test("DDL Type Hierarchy - types without hierarchy do NOT get __type__ column", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "User",
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    // No abstract, parentTypes, or subtypes
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));

  assertEquals(
    createTable !== undefined,
    true,
    "Should have a CREATE TABLE statement",
  );
  assertEquals(
    createTable!.includes("__type__"),
    false,
    "Standalone type should NOT have __type__ column",
  );
});

// ============================================================
// Test 5: Abstract types still generate DDL with __type__
// ============================================================

Deno.test("DDL Type Hierarchy - abstract types with subtypes generate DDL with __type__", () => {
  const generator = new DDLGenerator();
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Vehicle",
    properties: [
      {
        name: "speed",
        type: "int32",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
    abstract: true,
    subtypes: ["Car", "Truck"],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));

  assertEquals(
    createTable !== undefined,
    true,
    "Abstract type should still generate CREATE TABLE",
  );
  assertStringIncludes(createTable!, "__type__");
  assertStringIncludes(createTable!, "DEFAULT 'Vehicle'");
  assertStringIncludes(createTable!, "VARCHAR(255)");
  assertStringIncludes(createTable!, "NOT NULL");
});
