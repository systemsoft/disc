/**
 * Tests for Expression Converter
 *
 * Verifies SDL Expression → AccessExpressionNode conversion.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { convertExpression } from "./expression-converter.ts";
import type { Expression } from "../schema/ast.ts";
import { ValidationError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// 1. Literal — string
// ---------------------------------------------------------------------------

Deno.test("expression-converter: string literal", () => {
  const expr: Expression = { kind: "Literal", type: "string", value: "hello" };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLiteral");
  assertEquals((result as any).type, "string");
  assertEquals((result as any).value, "hello");
});

// ---------------------------------------------------------------------------
// 2. Literal — integer maps to number
// ---------------------------------------------------------------------------

Deno.test("expression-converter: integer literal maps to number", () => {
  const expr: Expression = { kind: "Literal", type: "integer", value: 42 };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLiteral");
  assertEquals((result as any).type, "number");
  assertEquals((result as any).value, 42);
});

// ---------------------------------------------------------------------------
// 3. Literal — float maps to number
// ---------------------------------------------------------------------------

Deno.test("expression-converter: float literal maps to number", () => {
  const expr: Expression = { kind: "Literal", type: "float", value: 3.14 };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLiteral");
  assertEquals((result as any).type, "number");
  assertEquals((result as any).value, 3.14);
});

// ---------------------------------------------------------------------------
// 4. Literal — boolean
// ---------------------------------------------------------------------------

Deno.test("expression-converter: boolean literal", () => {
  const expr: Expression = { kind: "Literal", type: "boolean", value: true };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLiteral");
  assertEquals((result as any).type, "boolean");
  assertEquals((result as any).value, true);
});

// ---------------------------------------------------------------------------
// 5. PathExpression — global
// ---------------------------------------------------------------------------

Deno.test("expression-converter: global path becomes AccessGlobal", () => {
  const expr: Expression = { kind: "PathExpression", path: ["global", "current_user"] };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessGlobal");
  assertEquals((result as any).name, "current_user");
});

// ---------------------------------------------------------------------------
// 6. PathExpression — dot-prefixed
// ---------------------------------------------------------------------------

Deno.test("expression-converter: dot-prefixed path strips leading dot", () => {
  const expr: Expression = { kind: "PathExpression", path: [".", "author", "id"] };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessPath");
  assertEquals((result as any).path, ["author", "id"]);
});

// ---------------------------------------------------------------------------
// 7. PathExpression — plain path
// ---------------------------------------------------------------------------

Deno.test("expression-converter: plain path passes through", () => {
  const expr: Expression = { kind: "PathExpression", path: ["name"] };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessPath");
  assertEquals((result as any).path, ["name"]);
});

// ---------------------------------------------------------------------------
// 8. BinaryOp — comparison (=)
// ---------------------------------------------------------------------------

Deno.test("expression-converter: binary comparison (=)", () => {
  const expr: Expression = {
    kind: "BinaryOp",
    op: "=",
    left: { kind: "PathExpression", path: [".", "id"] },
    right: { kind: "PathExpression", path: ["global", "current_user"] },
  };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessComparison");
  assertEquals((result as any).operator, "=");
  assertEquals((result as any).left.kind, "AccessPath");
  assertEquals((result as any).right.kind, "AccessGlobal");
});

// ---------------------------------------------------------------------------
// 9. BinaryOp — logical (and)
// ---------------------------------------------------------------------------

Deno.test("expression-converter: binary logical (and)", () => {
  const expr: Expression = {
    kind: "BinaryOp",
    op: "and",
    left: { kind: "Literal", type: "boolean", value: true },
    right: { kind: "Literal", type: "boolean", value: false },
  };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLogical");
  assertEquals((result as any).operator, "and");
  assertEquals((result as any).operands.length, 2);
});

// ---------------------------------------------------------------------------
// 10. UnaryOp — not
// ---------------------------------------------------------------------------

Deno.test("expression-converter: unary not", () => {
  const expr: Expression = {
    kind: "UnaryOp",
    op: "not",
    operand: { kind: "Literal", type: "boolean", value: true },
  };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLogical");
  assertEquals((result as any).operator, "not");
  assertEquals((result as any).operands.length, 1);
});

// ---------------------------------------------------------------------------
// 11. FunctionCall
// ---------------------------------------------------------------------------

Deno.test("expression-converter: function call", () => {
  const expr: Expression = {
    kind: "FunctionCall",
    name: { kind: "QualifiedName", parts: ["std", "len"] },
    args: [{ kind: "PathExpression", path: [".", "name"] }],
  };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessFunction");
  assertEquals((result as any).name, "std::len");
  assertEquals((result as any).args.length, 1);
  assertEquals((result as any).args[0].kind, "AccessPath");
});

// ---------------------------------------------------------------------------
// 12. TypeCast — strips cast, recurses
// ---------------------------------------------------------------------------

Deno.test("expression-converter: type cast strips cast and recurses", () => {
  const expr: Expression = {
    kind: "TypeCast",
    expr: { kind: "Literal", type: "string", value: "42" },
    type: { kind: "TypeRef", name: { kind: "QualifiedName", parts: ["int64"] }, optional: false, array: false },
  };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessLiteral");
  assertEquals((result as any).value, "42");
});

// ---------------------------------------------------------------------------
// 13. Parameter — throws ValidationError
// ---------------------------------------------------------------------------

Deno.test("expression-converter: parameter throws ValidationError", () => {
  const expr: Expression = { kind: "Parameter", name: "foo" };

  assertThrows(
    () => convertExpression(expr),
    ValidationError,
    "not valid in access policies",
  );
});

// ---------------------------------------------------------------------------
// 14. Optional comparison operators (?=, ?!=)
// ---------------------------------------------------------------------------

Deno.test("expression-converter: optional comparison ?= maps to =", () => {
  const expr: Expression = {
    kind: "BinaryOp",
    op: "?=",
    left: { kind: "PathExpression", path: [".", "status"] },
    right: { kind: "Literal", type: "string", value: "active" },
  };
  const result = convertExpression(expr);

  assertEquals(result.kind, "AccessComparison");
  assertEquals((result as any).operator, "=");
});
