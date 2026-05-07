/**
 * Tests for EdgeQL Parser — GlobalRef and SetGlobalQuery
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "./parser.ts";

Deno.test("EdgeQL Parser - GlobalRef in filter expression", () => {
  const source = `
    SELECT User
    FILTER .id = global current_user_id
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.filter?.kind, "BinaryOp");
    if (ast.filter?.kind === "BinaryOp") {
      assertEquals(ast.filter.op, "=");
      assertEquals(ast.filter.right.kind, "GlobalRef");
      if (ast.filter.right.kind === "GlobalRef") {
        assertEquals(ast.filter.right.name, "current_user_id");
        assertEquals(ast.filter.right.module, undefined);
      }
    }
  }
});

Deno.test("EdgeQL Parser - Qualified GlobalRef with module", () => {
  const source = `
    SELECT User
    FILTER .id = global default::current_user_id
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.filter?.kind, "BinaryOp");
    if (ast.filter?.kind === "BinaryOp") {
      assertEquals(ast.filter.right.kind, "GlobalRef");
      if (ast.filter.right.kind === "GlobalRef") {
        assertEquals(ast.filter.right.name, "current_user_id");
        assertEquals(ast.filter.right.module, "default");
      }
    }
  }
});

Deno.test("EdgeQL Parser - SET GLOBAL with type-cast value", () => {
  const source = `SET GLOBAL current_user_id := <uuid>'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SetGlobalQuery");
  if (ast.kind === "SetGlobalQuery") {
    assertEquals(ast.name, "current_user_id");
    assertEquals(ast.module, undefined);
    assertEquals(ast.value.kind, "TypeCast");
    if (ast.value.kind === "TypeCast") {
      assertEquals(ast.value.type.name.parts, ["uuid"]);
      assertEquals(ast.value.expr.kind, "Literal");
    }
  }
});

Deno.test("EdgeQL Parser - SET GLOBAL with qualified name", () => {
  const source = `SET GLOBAL default::current_user_id := <uuid>'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SetGlobalQuery");
  if (ast.kind === "SetGlobalQuery") {
    assertEquals(ast.name, "current_user_id");
    assertEquals(ast.module, "default");
    assertEquals(ast.value.kind, "TypeCast");
  }
});

Deno.test("EdgeQL Parser - SET GLOBAL with numeric value", () => {
  const source = `SET GLOBAL some_var := 42`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SetGlobalQuery");
  if (ast.kind === "SetGlobalQuery") {
    assertEquals(ast.name, "some_var");
    assertEquals(ast.module, undefined);
    assertEquals(ast.value.kind, "Literal");
    if (ast.value.kind === "Literal") {
      assertEquals(ast.value.type, "integer");
      assertEquals(ast.value.value, 42);
    }
  }
});
