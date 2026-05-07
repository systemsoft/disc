/**
 * Tests for constraint validation in SchemaValidator
 *
 * Verifies that constraint arguments are type-checked against
 * the property type and that argument counts are validated.
 */

import { assertEquals } from "@std/assert";
import * as AST from "./ast.ts";
import { SchemaValidator } from "./validator.ts";

function makeDocument(
  propertyType: string,
  constraints: AST.Constraint[],
): AST.SDLDocument {
  return {
    kind: "SDLDocument",
    declarations: [
      {
        kind: "ModuleDeclaration",
        name: { kind: "QualifiedName", parts: ["default"] },
        declarations: [
          {
            kind: "TypeDeclaration",
            name: { kind: "Identifier", value: "TestType" },
            members: [
              {
                kind: "PropertyDeclaration",
                name: { kind: "Identifier", value: "field" },
                type: {
                  kind: "TypeRef",
                  name: { kind: "QualifiedName", parts: [propertyType] },
                },
                required: true,
                multi: false,
                constraints,
              } as AST.PropertyDeclaration,
            ],
          } as AST.TypeDeclaration,
        ],
      } as AST.ModuleDeclaration,
    ],
  };
}

// ============================================================
// Argument count validation
// ============================================================

Deno.test("Validator - max_len_value without args produces error", () => {
  const doc = makeDocument("str", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "max_len_value" },
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(
    result.errors!.some((e) => e.message.includes("max_len_value") && e.message.includes("one argument")),
    true,
  );
});

Deno.test("Validator - one_of without args produces error", () => {
  const doc = makeDocument("str", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "one_of" },
    args: [],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(
    result.errors!.some((e) => e.message.includes("one_of") && e.message.includes("at least one")),
    true,
  );
});

Deno.test("Validator - expression without on produces error", () => {
  const doc = makeDocument("int32", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "expression" },
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(
    result.errors!.some((e) => e.message.includes("expression") && e.message.includes("'on' expression")),
    true,
  );
});

// ============================================================
// Type compatibility validation
// ============================================================

Deno.test("Validator - max_len_value on non-string type produces error", () => {
  const doc = makeDocument("int32", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "max_len_value" },
    args: [{ kind: "Literal", type: "integer", value: 255 } as AST.Literal],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(
    result.errors!.some((e) =>
      e.message.includes("max_len_value")
      && e.message.includes("'str' or 'bytes'")
    ),
    true,
  );
});

Deno.test("Validator - max_len_value on str type is valid", () => {
  const doc = makeDocument("str", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "max_len_value" },
    args: [{ kind: "Literal", type: "integer", value: 255 } as AST.Literal],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("Validator - min_value on str type produces error", () => {
  const doc = makeDocument("str", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "min_value" },
    args: [{ kind: "Literal", type: "integer", value: 0 } as AST.Literal],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(
    result.errors!.some((e) =>
      e.message.includes("min_value")
      && e.message.includes("numeric or temporal")
    ),
    true,
  );
});

Deno.test("Validator - min_value on int64 type is valid", () => {
  const doc = makeDocument("int64", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "min_value" },
    args: [{ kind: "Literal", type: "integer", value: 0 } as AST.Literal],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("Validator - max_ex_value on float64 type is valid", () => {
  const doc = makeDocument("float64", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "max_ex_value" },
    args: [{ kind: "Literal", type: "float", value: 100.0 } as AST.Literal],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("Validator - min_ex_value on bool type produces error", () => {
  const doc = makeDocument("bool", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "min_ex_value" },
    args: [{ kind: "Literal", type: "integer", value: 0 } as AST.Literal],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, false);
  assertEquals(
    result.errors!.some((e) =>
      e.message.includes("min_ex_value")
      && e.message.includes("numeric or temporal")
    ),
    true,
  );
});

// ============================================================
// Valid constraint usage
// ============================================================

Deno.test("Validator - one_of with valid args is accepted", () => {
  const doc = makeDocument("str", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "one_of" },
    args: [
      { kind: "Literal", type: "string", value: "active" } as AST.Literal,
      { kind: "Literal", type: "string", value: "inactive" } as AST.Literal,
    ],
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("Validator - exclusive constraint with no args is valid", () => {
  const doc = makeDocument("str", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "exclusive" },
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});

Deno.test("Validator - expression with on expression is valid", () => {
  const doc = makeDocument("int32", [{
    kind: "Constraint",
    name: { kind: "Identifier", value: "expression" },
    on: {
      kind: "BinaryOp",
      operator: ">",
      left: {
        kind: "PathExpression",
        path: "__subject__",
      } as unknown as AST.Expression,
      right: { kind: "Literal", type: "integer", value: 0 } as AST.Literal,
    } as unknown as AST.Expression,
  }]);

  const validator = new SchemaValidator();
  const result = validator.validate(doc);

  assertEquals(result.ok, true);
});
