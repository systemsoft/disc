/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests -- Phase 23 Compiler Features
 *
 * Tests the full pipeline against real PostgreSQL for Phase 23 features:
 *   - Enum literal in FILTER (Status.active -> 'active'::status)
 *   - Tuple element access (.0, .1, .2)
 *   - Named tuple field access (.name, .age)
 *   - WITH MODULE namespace scoping
 *   - IS type check (discriminator column filtering)
 *   - Polymorphic shape fields [IS Type].property
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import type { Schema, TypeDef } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// =========================================================================
// Phase 23.1 -- Enum Literal in FILTER
// =========================================================================

Deno.test({
  name: "PG Phase 23: Enum literal in FILTER -- Status.active matches correct rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create the PG enum type and table manually.
      // The enum type name must be "status" (not "status_type") because
      // the compiler uses getEnumSqlType("Status") -> "status" for casts.
      await pool.query("DROP TABLE IF EXISTS items CASCADE");
      await pool.query("DROP TYPE IF EXISTS status CASCADE");
      await pool.query(
        "CREATE TYPE status AS ENUM ('active', 'inactive', 'pending')"
      );
      await pool.query(`
        CREATE TABLE items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR NOT NULL,
          status status NOT NULL
        )
      `);

      // Insert test data
      await pool.query(`
        INSERT INTO items (name, status) VALUES
          ('alpha', 'active'),
          ('beta', 'inactive'),
          ('gamma', 'active'),
          ('delta', 'pending')
      `);

      // Build schema with Status enum and Item type
      const statusType: TypeDef = {
        name: "Status",
        kind: "enum",
        tableName: "status",
        properties: new Map(),
        links: new Map(),
        enumValues: ["active", "inactive", "pending"]
      };

      const itemType: TypeDef = {
        name: "Item",
        kind: "object",
        tableName: "items",
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
            edgeqlType: "uuid",
            hasDefault: true
          }],
          ["name", {
            name: "name",
            type: "str",
            required: true,
            multi: false,
            columnName: "name",
            edgeqlType: "str"
          }],
          ["status", {
            name: "status",
            type: "status_type",
            required: true,
            multi: false,
            columnName: "status",
            edgeqlType: "str"
          }]
        ]),
        links: new Map()
      };

      const schema: Schema = {
        types: new Map([
          ["Status", statusType],
          ["Item", itemType]
        ]),
        functions: getBuiltinFunctions()
      };

      // Compile EdgeQL: SELECT Item { name } FILTER .status = Status.active
      const sql = compileEdgeQL(
        "SELECT Item { name } FILTER .status = Status.active",
        schema
      );

      // Execute the compiled SQL
      const result = await pool.query(sql);

      // Should return 2 rows: alpha and gamma (both active)
      assertEquals(
        result.rowCount,
        2,
        "Should return exactly 2 active items"
      );

      const names = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).name;
      });
      assertEquals(
        (names as string[]).sort(),
        ["alpha", "gamma"],
        "Active items should be alpha and gamma"
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS items CASCADE");
      await pool.query("DROP TYPE IF EXISTS status CASCADE");
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 23.2 -- Tuple Element Access
// =========================================================================

Deno.test({
  name: "PG Phase 23: Tuple element access -- (1, 2, 3).1 returns 2",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Build a minimal schema (needed for compilation context)
      const schema: Schema = {
        types: new Map(),
        functions: getBuiltinFunctions()
      };

      // Compile: SELECT (1, 2, 3).1
      const sql = compileEdgeQL("SELECT (1, 2, 3).1", schema);

      // Execute the compiled SQL
      const result = await pool.query(sql);

      assertEquals(
        result.rowCount >= 1,
        true,
        "Should return at least one row"
      );

      // The result should contain the value 2
      const firstRow = result.rows[0];
      const values = Object.values(firstRow as Record<string, unknown>);

      // The jsonb access returns the value as jsonb, which may be a number or string
      const extractedValue = Number(values[0]);
      assertEquals(extractedValue, 2, "Tuple element .1 should be 2");
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 23.2 -- Named Tuple Field Access
// =========================================================================

Deno.test({
  name: "PG Phase 23: Named tuple field access -- (name := 'hello', age := 42).name returns 'hello'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const schema: Schema = {
        types: new Map(),
        functions: getBuiltinFunctions()
      };

      // Compile: SELECT (name := 'hello', age := 42).name
      const sql = compileEdgeQL(
        "SELECT (name := \"hello\", age := 42).name",
        schema
      );

      const result = await pool.query(sql);

      assertEquals(
        result.rowCount >= 1,
        true,
        "Should return at least one row"
      );

      const firstRow = result.rows[0];
      const values = Object.values(firstRow as Record<string, unknown>);

      // Named tuple field access with ->> returns text
      assertEquals(
        String(values[0]).replace(/"/g, ""),
        "hello",
        "Named tuple .name should be 'hello'"
      );
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 23.3 -- WITH MODULE Namespace Scoping
// =========================================================================

Deno.test({
  name: "PG Phase 23: WITH MODULE -- resolves unqualified type name in module scope",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create the table manually
      await pool.query("DROP TABLE IF EXISTS other_foo CASCADE");
      await pool.query(`
        CREATE TABLE other_foo (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR NOT NULL
        )
      `);
      await pool.query(
        "INSERT INTO other_foo (name) VALUES ('test_item')"
      );

      // Build schema with other::Foo type
      const otherFoo: TypeDef = {
        name: "other::Foo",
        kind: "object",
        tableName: "other_foo",
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
            edgeqlType: "uuid",
            hasDefault: true
          }],
          ["name", {
            name: "name",
            type: "str",
            required: true,
            multi: false,
            columnName: "name",
            edgeqlType: "str"
          }]
        ]),
        links: new Map()
      };

      const schema: Schema = {
        types: new Map([
          ["other::Foo", otherFoo]
        ]),
        functions: getBuiltinFunctions()
      };

      // Compile: WITH MODULE other SELECT Foo { name }
      const sql = compileEdgeQL(
        "WITH MODULE other SELECT Foo { name }",
        schema
      );

      const result = await pool.query(sql);

      assertEquals(result.rowCount, 1, "Should return 1 row from other::Foo");

      const row = result.rows[0];
      const data = (row as Record<string, unknown>).jsonb_build_object ?? row;
      assertEquals(
        (data as Record<string, unknown>).name,
        "test_item",
        "Should return the test_item row"
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS other_foo CASCADE");
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 23.5 -- IS Type Check (Discriminator Column)
// =========================================================================

// Per-subtype-table model: Disc's production migration engine emits one
// physical table per concrete subtype (no physical table for the abstract
// parent — engine.ts:891). `SELECT <Abstract>` lowers to `UNION ALL`
// across the subtypes' tables. Each subtype's table carries a `__type__`
// column with a default of its own type name (DDL emission at
// `migration/ddl.ts:398-412`), so `IS <Type>` checks reduce to
// `__type__ = '<Type>'` over the union — no shared `shapes` table.
Deno.test({
  name: "PG Phase 23: IS type check -- FILTER Shape IS Circle returns only circles",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Per-subtype tables: one for Circle, one for Rectangle. The
      // `__type__` column gates `IS <Type>` filtering at the UNION
      // level — no abstract `shapes` table is created.
      await pool.query("DROP TABLE IF EXISTS circles CASCADE");
      await pool.query("DROP TABLE IF EXISTS rectangles CASCADE");
      await pool.query(`
        CREATE TABLE circles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          __type__ VARCHAR(255) NOT NULL DEFAULT 'Circle',
          color VARCHAR
        )
      `);
      await pool.query(`
        CREATE TABLE rectangles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          __type__ VARCHAR(255) NOT NULL DEFAULT 'Rectangle',
          color VARCHAR
        )
      `);

      // 2 circles + 2 rectangles. The default `__type__` value carries
      // the subtype name without the test having to set it explicitly.
      await pool.query(
        `INSERT INTO circles (color) VALUES ('red'), ('green')`
      );
      await pool.query(
        `INSERT INTO rectangles (color) VALUES ('blue'), ('yellow')`
      );

      // Build schema with Shape hierarchy. Abstract Shape has no
      // `tableName` — production semantics: abstract types have no
      // physical table. Concrete subtypes carry their own tableName
      // and inherit the same property shape so the UNION's projection
      // is uniform.
      const shape: TypeDef = {
        name: "Shape",
        kind: "object",
        // Abstract types have no physical table; `tableName` is a
        // placeholder empty string here (the production path skips
        // tableName lookups for abstract types via the `abstract` flag).
        tableName: "",
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
            hasDefault: true
          }],
          ["__type__", {
            name: "__type__",
            type: "text",
            required: true,
            multi: false,
            columnName: "__type__",
            edgeqlType: "str"
          }],
          ["color", {
            name: "color",
            type: "text",
            required: false,
            multi: false,
            columnName: "color",
            edgeqlType: "str"
          }]
        ]),
        links: new Map()
      };

      const circle: TypeDef = {
        name: "Circle",
        kind: "object",
        tableName: "circles",
        parentTypes: ["Shape"],
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
            edgeqlType: "uuid",
            hasDefault: true
          }],
          ["__type__", {
            name: "__type__",
            type: "text",
            required: true,
            multi: false,
            columnName: "__type__",
            edgeqlType: "str"
          }],
          ["color", {
            name: "color",
            type: "text",
            required: false,
            multi: false,
            columnName: "color",
            edgeqlType: "str"
          }]
        ]),
        links: new Map()
      };

      const rectangle: TypeDef = {
        name: "Rectangle",
        kind: "object",
        tableName: "rectangles",
        parentTypes: ["Shape"],
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
            edgeqlType: "uuid",
            hasDefault: true
          }],
          ["__type__", {
            name: "__type__",
            type: "text",
            required: true,
            multi: false,
            columnName: "__type__",
            edgeqlType: "str"
          }],
          ["color", {
            name: "color",
            type: "text",
            required: false,
            multi: false,
            columnName: "color",
            edgeqlType: "str"
          }]
        ]),
        links: new Map()
      };

      const schema: Schema = {
        types: new Map([
          ["Shape", shape],
          ["Circle", circle],
          ["Rectangle", rectangle]
        ]),
        functions: getBuiltinFunctions()
      };

      // Compile: SELECT Shape { color } FILTER .id IS Circle
      const sql = compileEdgeQL(
        "SELECT Shape { color } FILTER .id IS Circle",
        schema
      );

      const result = await pool.query(sql);

      // Should return only the 2 Circle rows
      assertEquals(
        result.rowCount,
        2,
        "Should return exactly 2 circles"
      );

      const colors = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return (data as Record<string, unknown>).color;
      });
      assertEquals(
        (colors as string[]).sort(),
        ["green", "red"],
        "Circle colors should be green and red"
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS circles CASCADE");
      await pool.query("DROP TABLE IF EXISTS rectangles CASCADE");
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 23.5 -- Polymorphic Shape Field [IS Type].property
// =========================================================================

// `compilePolymorphicSelect` extends each UNION branch's projection
// to include subtype-specific columns referenced by polymorphic shape
// fields elsewhere in the SELECT. Branches whose subtype doesn't own
// the column project `NULL::<pg-type>` so the union's column shape
// stays consistent — the outer CASE expression in
// `compilePolymorphicShapeElement` then resolves `<alias>.<col>`
// without "column shape_1.<col> does not exist" errors.
Deno.test({
  name: "PG Phase 23: Polymorphic shape -- [IS Circle].radius returns radius for circles, null for others",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Per-subtype tables. Each subtype carries its own columns;
      // there's no shared `shapes` table.
      await pool.query("DROP TABLE IF EXISTS circles CASCADE");
      await pool.query("DROP TABLE IF EXISTS rectangles CASCADE");
      await pool.query(`
        CREATE TABLE circles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          __type__ VARCHAR(255) NOT NULL DEFAULT 'Circle',
          color VARCHAR,
          radius DOUBLE PRECISION
        )
      `);
      await pool.query(`
        CREATE TABLE rectangles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          __type__ VARCHAR(255) NOT NULL DEFAULT 'Rectangle',
          color VARCHAR,
          width DOUBLE PRECISION,
          height DOUBLE PRECISION
        )
      `);

      // 2 circles + 1 rectangle.
      await pool.query(
        `INSERT INTO circles (color, radius) VALUES ('red', 5.0), ('green', 10.0)`
      );
      await pool.query(
        `INSERT INTO rectangles (color, width, height) VALUES ('blue', 3.0, 4.0)`
      );

      // Build schema with hierarchy. Abstract Shape has no tableName.
      const shape: TypeDef = {
        name: "Shape",
        kind: "object",
        // Abstract types have no physical table; `tableName` is a
        // placeholder empty string here (the production path skips
        // tableName lookups for abstract types via the `abstract` flag).
        tableName: "",
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
            hasDefault: true
          }],
          ["__type__", {
            name: "__type__",
            type: "text",
            required: true,
            multi: false,
            columnName: "__type__",
            edgeqlType: "str"
          }],
          ["color", {
            name: "color",
            type: "text",
            required: false,
            multi: false,
            columnName: "color",
            edgeqlType: "str"
          }]
        ]),
        links: new Map()
      };

      const circle: TypeDef = {
        name: "Circle",
        kind: "object",
        tableName: "circles",
        parentTypes: ["Shape"],
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
            edgeqlType: "uuid",
            hasDefault: true
          }],
          ["__type__", {
            name: "__type__",
            type: "text",
            required: true,
            multi: false,
            columnName: "__type__",
            edgeqlType: "str"
          }],
          ["color", {
            name: "color",
            type: "text",
            required: false,
            multi: false,
            columnName: "color",
            edgeqlType: "str"
          }],
          ["radius", {
            name: "radius",
            type: "double precision",
            required: true,
            multi: false,
            columnName: "radius",
            edgeqlType: "float64"
          }]
        ]),
        links: new Map()
      };

      const rectangle: TypeDef = {
        name: "Rectangle",
        kind: "object",
        tableName: "rectangles",
        parentTypes: ["Shape"],
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
            edgeqlType: "uuid",
            hasDefault: true
          }],
          ["__type__", {
            name: "__type__",
            type: "text",
            required: true,
            multi: false,
            columnName: "__type__",
            edgeqlType: "str"
          }],
          ["color", {
            name: "color",
            type: "text",
            required: false,
            multi: false,
            columnName: "color",
            edgeqlType: "str"
          }],
          ["width", {
            name: "width",
            type: "double precision",
            required: true,
            multi: false,
            columnName: "width",
            edgeqlType: "float64"
          }],
          ["height", {
            name: "height",
            type: "double precision",
            required: true,
            multi: false,
            columnName: "height",
            edgeqlType: "float64"
          }]
        ]),
        links: new Map()
      };

      const schema: Schema = {
        types: new Map([
          ["Shape", shape],
          ["Circle", circle],
          ["Rectangle", rectangle]
        ]),
        functions: getBuiltinFunctions()
      };

      // Compile: SELECT Shape { color, [IS Circle].radius }
      const sql = compileEdgeQL(
        "SELECT Shape { color, [IS Circle].radius }",
        schema
      );

      const result = await pool.query(sql);

      // Should return all 3 shapes
      assertEquals(
        result.rowCount,
        3,
        "Should return all 3 shapes"
      );

      // Extract results
      const rows = result.rows.map((row: Record<string, unknown>) => {
        const data = row.jsonb_build_object ?? row;
        return data as Record<string, unknown>;
      });

      // Circles should have radius, rectangles should have null
      const circleRows = rows.filter(r => Number(r.radius) > 0);
      assertEquals(
        circleRows.length,
        2,
        "Should have 2 rows with non-null radius (circles)"
      );

      const rectRows = rows.filter(r => r.radius === null || r.radius === undefined);
      assertEquals(
        rectRows.length,
        1,
        "Should have 1 row with null radius (rectangle)"
      );

      // Verify specific radius values (use numeric sort comparator)
      const radiusValues = circleRows.map(r => Number(r.radius)).sort(
        (a, b) => a - b
      );
      assertEquals(
        radiusValues,
        [5, 10],
        "Circle radii should be 5 and 10"
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS circles CASCADE");
      await pool.query("DROP TABLE IF EXISTS rectangles CASCADE");
      await pool.close();
    }
  }
});

// =========================================================================
// Phase 23.6 -- DDL __type__ Column Generation via Real PG
// =========================================================================

Deno.test({
  name: "PG Phase 23: DDL-generated __type__ column -- INSERT with default and query discriminator",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Use the DDL generator to produce CREATE TABLE with __type__
      const { DDLGenerator } = await import("../migration/ddl.ts");
      const generator = new DDLGenerator();
      const createOp: import("../migration/types.ts").CreateTypeOperation = {
        kind: "CreateType",
        typeName: "Animal",
        properties: [
          {
            name: "name",
            type: "str",
            required: true,
            multi: false,
            constraints: [],
            annotations: {}
          }
        ],
        links: [],
        subtypes: ["Dog", "Cat"]
      };
      const ddlStatements = generator.generateDDL([createOp]);

      // Execute the DDL
      for (const stmt of ddlStatements) {
        await pool.query(stmt);
      }

      // Insert a row without specifying __type__ -- should default to 'Animal'
      await pool.query(
        "INSERT INTO animal (id, name) VALUES (gen_random_uuid(), 'Generic')"
      );

      // Insert rows with explicit __type__ for subtypes
      await pool.query(
        "INSERT INTO animal (id, __type__, name) VALUES (gen_random_uuid(), 'Dog', 'Rex')"
      );
      await pool.query(
        "INSERT INTO animal (id, __type__, name) VALUES (gen_random_uuid(), 'Cat', 'Whiskers')"
      );

      // Verify __type__ column values
      const allResult = await pool.query(
        "SELECT name, __type__ FROM animal ORDER BY name"
      );
      assertEquals(allResult.rowCount, 3, "Should have 3 animals");

      // Generic should default to 'Animal'
      const genericRow = allResult.rows.find(
        (r: Record<string, unknown>) => r.name === "Generic"
      ) as Record<string, unknown>;
      assertExists(genericRow, "Generic should exist");
      assertEquals(
        genericRow.__type__,
        "Animal",
        "Default __type__ should be 'Animal'"
      );

      // Filter by __type__ to get only Dogs
      const dogResult = await pool.query(
        "SELECT name FROM animal WHERE __type__ = 'Dog'"
      );
      assertEquals(dogResult.rowCount, 1, "Should have 1 dog");
      assertEquals(
        (dogResult.rows[0] as Record<string, unknown>).name,
        "Rex",
        "Dog should be Rex"
      );

      // Filter by __type__ to get only Cats
      const catResult = await pool.query(
        "SELECT name FROM animal WHERE __type__ = 'Cat'"
      );
      assertEquals(catResult.rowCount, 1, "Should have 1 cat");
      assertEquals(
        (catResult.rows[0] as Record<string, unknown>).name,
        "Whiskers",
        "Cat should be Whiskers"
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS animal CASCADE");
      await pool.close();
    }
  }
});
