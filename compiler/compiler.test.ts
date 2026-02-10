/**
 * Tests for EdgeQL to SQL Compiler
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }

  return codegen.generate(result.value);
}

Deno.test("SQL Compiler - Simple SELECT", () => {
  const source = "SELECT User";
  const sql = compileEdgeQL(source);

  // Should generate a SELECT with JSON object
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("jsonb_build_object"), true);
  assertEquals(sql.includes("users"), true);
});

Deno.test("SQL Compiler - SELECT with Shape", () => {
  const source = `
    SELECT User {
      name,
      email
    }
  `;

  const sql = compileEdgeQL(source);

  // Should generate SELECT with specific fields in JSON object
  assertEquals(sql.includes("jsonb_build_object"), true);
  assertEquals(sql.includes("'name'"), true);
  assertEquals(sql.includes("'email'"), true);
  assertEquals(sql.includes("users"), true);
});

Deno.test("SQL Compiler - SELECT with Filter", () => {
  const source = `
    SELECT User
    FILTER .active = true
  `;

  const sql = compileEdgeQL(source);

  // Should generate WHERE clause
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("TRUE"), true);
});

Deno.test("SQL Compiler - SELECT with Order and Limit", () => {
  const source = `
    SELECT User {
      name
    }
    ORDER BY .name ASC
    LIMIT 10
  `;

  const sql = compileEdgeQL(source);

  // Should generate ORDER BY and LIMIT
  assertEquals(sql.includes("ORDER BY"), true);
  assertEquals(sql.includes("ASC"), true);
  assertEquals(sql.includes("LIMIT 10"), true);
});

Deno.test("SQL Compiler - Literals", () => {
  const source = `SELECT "hello"`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("'hello'"), true);
});

Deno.test("SQL Compiler - Function Calls", () => {
  const source = `SELECT count(User)`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("COUNT"), true);
});

Deno.test("SQL Code Generator - Column Reference", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "ColumnReference",
          table: "u",
          column: "name",
        },
      }],
    },
  });

  assertEquals(sql.includes("u.name"), true);
});

Deno.test("SQL Code Generator - Binary Expression", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "BinaryExpression",
          operator: "=",
          left: {
            kind: "ColumnReference",
            column: "active",
          },
          right: {
            kind: "LiteralExpression",
            type: "boolean",
            value: true,
          },
        },
      }],
    },
  });

  assertEquals(sql.includes("active = TRUE"), true);
});

Deno.test("SQL Code Generator - JSON Build Object", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "JsonBuildObject",
          fields: [
            {
              kind: "JsonField",
              key: "name",
              value: {
                kind: "ColumnReference",
                column: "name",
              },
            },
            {
              kind: "JsonField",
              key: "email",
              value: {
                kind: "ColumnReference",
                column: "email",
              },
            },
          ],
        },
      }],
    },
  });

  assertEquals(sql.includes("jsonb_build_object"), true);
  assertEquals(sql.includes("'name', name"), true);
  assertEquals(sql.includes("'email', email"), true);
});

Deno.test("SQL Code Generator - Function Call", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "FunctionCall",
          name: "COUNT",
          args: [{
            kind: "LiteralExpression",
            type: "string",
            value: "*",
          }],
        },
      }],
    },
  });

  assertEquals(sql.includes("COUNT('*')"), true);
});

Deno.test("SQL Code Generator - WHERE Clause", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "ColumnReference",
          column: "name",
        },
      }],
    },
    from: {
      kind: "FromClause",
      tables: [{
        kind: "TableReference",
        name: "users",
        alias: "u",
      }],
    },
    where: {
      kind: "WhereClause",
      condition: {
        kind: "BinaryExpression",
        operator: "=",
        left: {
          kind: "ColumnReference",
          table: "u",
          column: "active",
        },
        right: {
          kind: "LiteralExpression",
          type: "boolean",
          value: true,
        },
      },
    },
  });

  assertEquals(sql.includes("FROM"), true);
  assertEquals(sql.includes("users AS u"), true);
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("u.active = TRUE"), true);
});

Deno.test("SQL Code Generator - ORDER BY and LIMIT", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "ColumnReference",
          column: "name",
        },
      }],
    },
    orderBy: {
      kind: "OrderByClause",
      items: [{
        kind: "OrderByItem",
        expression: {
          kind: "ColumnReference",
          column: "name",
        },
        direction: "ASC",
      }],
    },
    limit: {
      kind: "LimitClause",
      count: {
        kind: "LiteralExpression",
        type: "number",
        value: 10,
      },
    },
  });

  assertEquals(sql.includes("ORDER BY"), true);
  assertEquals(sql.includes("name ASC"), true);
  assertEquals(sql.includes("LIMIT 10"), true);
});

Deno.test("SQL Code Generator - Identifier Escaping", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "ColumnReference",
          column: "order", // Reserved keyword
        },
      }],
    },
  });

  assertEquals(sql.includes('"order"'), true);
});

Deno.test("SQL Code Generator - String Escaping", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "LiteralExpression",
          type: "string",
          value: "It's a test",
        },
      }],
    },
  });

  assertEquals(sql.includes("'It''s a test'"), true);
});

Deno.test("SQL Compiler - INSERT Query", () => {
  const source = `
    INSERT User {
      name := "Alice",
      email := "alice@example.com"
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("users"), true);
  assertEquals(sql.includes("name, email"), true);
  assertEquals(sql.includes("'Alice'"), true);
  assertEquals(sql.includes("'alice@example.com'"), true);
  assertEquals(sql.includes("RETURNING"), true);
});

Deno.test("SQL Compiler - INSERT with UNLESS CONFLICT", () => {
  const source = `
    INSERT User {
      name := "Bob",
      email := "bob@example.com"
    }
    UNLESS CONFLICT ON .email
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("ON CONFLICT"), true);
  assertEquals(sql.includes("DO NOTHING"), true);
});

Deno.test("SQL Compiler - UPDATE Query", () => {
  const source = `
    UPDATE User
    FILTER .email = "alice@example.com"
    SET {
      name := "Alice Smith"
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("UPDATE"), true);
  assertEquals(sql.includes("users"), true);
  assertEquals(sql.includes("SET"), true);
  assertEquals(sql.includes("name = 'Alice Smith'"), true);
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("email = 'alice@example.com'"), true);
  assertEquals(sql.includes("RETURNING"), true);
});

Deno.test("SQL Compiler - DELETE Query", () => {
  const source = `
    DELETE User
    FILTER .email = "old@example.com"
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("DELETE FROM"), true);
  assertEquals(sql.includes("users"), true);
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("email = 'old@example.com'"), true);
  assertEquals(sql.includes("RETURNING"), true);
});
