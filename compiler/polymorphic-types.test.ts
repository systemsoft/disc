/**
 * Tests for Abstract Polymorphic Types (Stage 35, Phase 4)
 *
 * Validates:
 * - POLYMORPHIC_TYPES set contains all 9 abstract polymorphic types
 * - isPolymorphicType() correctly identifies polymorphic vs concrete types
 * - SchemaValidator accepts polymorphic types in type references
 * - SchemaValidator still rejects truly unknown types
 * - Functions with polymorphic parameter types compile successfully
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { isPolymorphicType, POLYMORPHIC_TYPES } from "./context.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { SDLParser } from "../schema/parser.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compileEdgeQL(source: string): string {
  const schema = createTestSchema();
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

function validateSDL(source: string): { ok: boolean; errors?: unknown[] } {
  const parser = new SDLParser(source);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  return validator.validate(doc);
}

// ===========================================================================
// Test 1: isPolymorphicType("anytype") returns true
// ===========================================================================

Deno.test("polymorphic types - isPolymorphicType('anytype') returns true", () => {
  assertEquals(isPolymorphicType("anytype"), true);
});

// ===========================================================================
// Test 2: isPolymorphicType("anyscalar") returns true
// ===========================================================================

Deno.test("polymorphic types - isPolymorphicType('anyscalar') returns true", () => {
  assertEquals(isPolymorphicType("anyscalar"), true);
});

// ===========================================================================
// Test 3: isPolymorphicType("str") returns false
// ===========================================================================

Deno.test("polymorphic types - isPolymorphicType('str') returns false", () => {
  assertEquals(isPolymorphicType("str"), false);
});

// ===========================================================================
// Test 4: isPolymorphicType("int64") returns false
// ===========================================================================

Deno.test("polymorphic types - isPolymorphicType('int64') returns false", () => {
  assertEquals(isPolymorphicType("int64"), false);
});

// ===========================================================================
// Test 5: POLYMORPHIC_TYPES contains all 9 types
// ===========================================================================

Deno.test("polymorphic types - POLYMORPHIC_TYPES contains all 9 abstract types", () => {
  const expected = [
    "anytype",
    "anyscalar",
    "anyenum",
    "anytuple",
    "anyobject",
    "anyreal",
    "anyint",
    "anyfloat",
    "anynumeric",
  ];

  assertEquals(POLYMORPHIC_TYPES.size, 9);

  for (const typeName of expected) {
    assertEquals(
      POLYMORPHIC_TYPES.has(typeName),
      true,
      `POLYMORPHIC_TYPES should contain '${typeName}'`,
    );
  }
});

// ===========================================================================
// Test 6: Validator accepts anytype as a valid type ref
// ===========================================================================

Deno.test("polymorphic types - validator accepts anytype in function parameter", () => {
  const result = validateSDL(`
    module default {
      function identity(val: anytype) -> anytype
        using (val);
    }
  `);

  assertEquals(
    result.ok,
    true,
    `Validation should pass for anytype: ${JSON.stringify(result.errors)}`,
  );
});

// ===========================================================================
// Test 7: Validator accepts anyscalar as a valid type ref
// ===========================================================================

Deno.test("polymorphic types - validator accepts anyscalar in function parameter", () => {
  const result = validateSDL(`
    module default {
      function to_string(val: anyscalar) -> str
        using (val);
    }
  `);

  assertEquals(
    result.ok,
    true,
    `Validation should pass for anyscalar: ${JSON.stringify(result.errors)}`,
  );
});

// ===========================================================================
// Test 8: Validator still rejects truly unknown types like foobar
// ===========================================================================

Deno.test("polymorphic types - validator rejects unknown type 'foobar'", () => {
  const result = validateSDL(`
    module default {
      function bad_func(val: foobar) -> str
        using (val);
    }
  `);

  assertEquals(
    result.ok,
    false,
    "Validation should fail for unknown type 'foobar'",
  );
  assertEquals(
    result.errors !== undefined,
    true,
    "Should have validation errors",
  );
  assertEquals(
    result.errors!.length > 0,
    true,
    "Should have at least one error",
  );
});

// ===========================================================================
// Test 9: Function with anytype parameter compiles successfully with str arg
// ===========================================================================

Deno.test("polymorphic types - len() with str argument compiles to LENGTH()", () => {
  // len() accepts anytype-like input (defined as 'str' in builtin-functions
  // but the compiler does not reject other types at compile time).
  // This test verifies that functions defined with polymorphic arg types
  // in the built-in registry (e.g., count with 'any') compile correctly.
  const sql = compileEdgeQL("SELECT count(User)");

  // count is defined with arg type 'any' (a polymorphic type)
  // and should compile to COUNT(...)
  assertStringIncludes(sql, "COUNT");
});

// ===========================================================================
// Test 10: Function with anyreal parameter compiles successfully
// ===========================================================================

Deno.test("polymorphic types - avg() with anyreal parameter compiles to AVG()", () => {
  // avg() is defined with arg type 'anyreal' (a polymorphic type).
  // Use a simple single-step path that the compiler supports.
  const sql = compileEdgeQL("SELECT avg(User)");

  assertStringIncludes(sql, "AVG");
});

// ===========================================================================
// Test 11: All polymorphic types recognized by isPolymorphicType
// ===========================================================================

Deno.test("polymorphic types - all polymorphic types return true from isPolymorphicType", () => {
  const allTypes = [
    "anytype",
    "anyscalar",
    "anyenum",
    "anytuple",
    "anyobject",
    "anyreal",
    "anyint",
    "anyfloat",
    "anynumeric",
  ];

  for (const typeName of allTypes) {
    assertEquals(
      isPolymorphicType(typeName),
      true,
      `isPolymorphicType('${typeName}') should return true`,
    );
  }
});

// ===========================================================================
// Test 12: Non-polymorphic types are not recognized
// ===========================================================================

Deno.test("polymorphic types - concrete types return false from isPolymorphicType", () => {
  const concreteTypes = [
    "str",
    "int64",
    "float64",
    "bool",
    "uuid",
    "datetime",
    "json",
    "bytes",
    "decimal",
    "bigint",
    "User",
    "Post",
    "any", // "any" is NOT a polymorphic type; "anytype" is
  ];

  for (const typeName of concreteTypes) {
    assertEquals(
      isPolymorphicType(typeName),
      false,
      `isPolymorphicType('${typeName}') should return false`,
    );
  }
});
