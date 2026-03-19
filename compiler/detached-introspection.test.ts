/**
 * Tests for Detached and Introspection expression compilation stubs
 */

import { assertEquals } from "@std/assert";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();

Deno.test("Compiler - Detached compiles inner expression", () => {
  // Construct AST manually since DETACHED may not be fully parsed yet
  const compiler = new EdgeQLCompiler(schema);
  const codegen = new SQLCodeGenerator();

  const ast = {
    kind: "SelectQuery" as const,
    expr: {
      kind: "Detached" as const,
      expr: {
        kind: "Literal" as const,
        type: "string" as const,
        value: "hello",
      },
    },
  };

  const result = compiler.compile(ast);
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    assertEquals(sql.includes("'hello'"), true);
  }
});

Deno.test("Compiler - Introspection throws CompilationError", () => {
  const compiler = new EdgeQLCompiler(schema);

  const ast = {
    kind: "SelectQuery" as const,
    expr: {
      kind: "Introspection" as const,
      type: {
        kind: "TypeName" as const,
        name: { kind: "QualifiedName" as const, parts: ["User"] },
      },
    },
  };

  const result = compiler.compile(ast);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Introspection"), true);
    assertEquals(result.error.message.includes("not yet supported"), true);
  }
});

Deno.test("Compiler - Introspection error includes type name", () => {
  const compiler = new EdgeQLCompiler(schema);

  const ast = {
    kind: "SelectQuery" as const,
    expr: {
      kind: "Introspection" as const,
      type: {
        kind: "TypeName" as const,
        name: { kind: "QualifiedName" as const, parts: ["default", "Post"] },
      },
    },
  };

  const result = compiler.compile(ast);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("INTROSPECT default::Post"),
      true,
    );
    assertEquals(
      result.error.message.includes("schema reflection catalog"),
      true,
    );
  }
});

Deno.test("Compiler - Detached isolates scope", () => {
  const compiler = new EdgeQLCompiler(schema);

  // Simple test: DETACHED with a literal (no scope needed)
  // Verifies that pushScope/popScope does not break compilation
  const ast = {
    kind: "SelectQuery" as const,
    expr: {
      kind: "Detached" as const,
      expr: {
        kind: "Literal" as const,
        type: "integer" as const,
        value: 42,
      },
    },
  };

  const result = compiler.compile(ast);
  assertEquals(result.ok, true);
});

Deno.test("Compiler - Detached with nested binary expression", () => {
  const compiler = new EdgeQLCompiler(schema);
  const codegen = new SQLCodeGenerator();

  const ast = {
    kind: "SelectQuery" as const,
    expr: {
      kind: "Detached" as const,
      expr: {
        kind: "BinaryOp" as const,
        op: "+" as const,
        left: {
          kind: "Literal" as const,
          type: "integer" as const,
          value: 1,
        },
        right: {
          kind: "Literal" as const,
          type: "integer" as const,
          value: 2,
        },
      },
    },
  };

  const result = compiler.compile(ast);
  assertEquals(result.ok, true);
  if (result.ok) {
    const sql = codegen.generate(result.value);
    assertEquals(sql.includes("1"), true);
    assertEquals(sql.includes("+"), true);
    assertEquals(sql.includes("2"), true);
  }
});
