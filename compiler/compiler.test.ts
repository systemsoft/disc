/**
 * Tests for EdgeQL to SQL Compiler
 */

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";
import { CompilationError } from "../lib/errors.ts";

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
      name := "Ada",
      email := "ada@example.com"
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("users"), true);
  assertEquals(sql.includes("name, email"), true);
  assertEquals(sql.includes("'Ada'"), true);
  assertEquals(sql.includes("'ada@example.com'"), true);
  assertEquals(sql.includes("RETURNING"), true);
});

Deno.test("SQL Compiler - INSERT with UNLESS CONFLICT", () => {
  const source = `
    INSERT User {
      name := "Billie",
      email := "billie@example.com"
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
    FILTER .email = "ada@example.com"
    SET {
      name := "Ada Smith"
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("UPDATE"), true);
  assertEquals(sql.includes("users"), true);
  assertEquals(sql.includes("SET"), true);
  assertEquals(sql.includes("name = 'Ada Smith'"), true);
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("email = 'ada@example.com'"), true);
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

// GROUP BY tests

Deno.test("SQL Compiler - GROUP BY single property", () => {
  const source = `GROUP User BY .active`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("GROUP BY"), true);
  assertEquals(sql.includes("users"), true);
  assertEquals(sql.includes("jsonb_build_object"), true);
  assertEquals(sql.includes("'key'"), true);
  assertEquals(sql.includes("'elements'"), true);
  assertEquals(sql.includes("jsonb_agg"), true);
  assertEquals(sql.includes("active"), true);
});

Deno.test("SQL Compiler - GROUP BY multiple expressions", () => {
  const source = `GROUP User BY .active, .age`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("GROUP BY"), true);
  assertEquals(sql.includes("active"), true);
  assertEquals(sql.includes("age"), true);
});

Deno.test("SQL Compiler - GROUP BY unknown type error", () => {
  const source = `GROUP Unknown BY .foo`;

  let threw = false;
  try {
    compileEdgeQL(source);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("SQL Compiler - GROUP BY with FILTER produces HAVING", () => {
  const source = `GROUP User BY .active FILTER count(User) > 2`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("GROUP BY"), true);
  assertEquals(sql.includes("HAVING"), true);
  assertEquals(sql.includes("COUNT"), true);
  assertEquals(sql.includes("> 2"), true);
});

// FOR query tests

Deno.test("SQL Compiler - FOR with set literal multi-element", () => {
  const source = `
    FOR name IN {"Ada", "Billie"}
    UNION (
      INSERT User {
        name := name,
        email := "test@test.com"
      }
    )
  `;
  const sql = compileEdgeQL(source);

  // Multi-element FOR INSERTs merge into a single multi-row INSERT
  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("'Ada'"), true);
  assertEquals(sql.includes("'Billie'"), true);
  // Should NOT use UNION ALL (invalid for INSERT statements)
  assertEquals(sql.includes("UNION ALL"), false);
});

Deno.test("SQL Compiler - FOR with single-element set", () => {
  const source = `
    FOR name IN {"Ada"}
    UNION (
      INSERT User {
        name := name,
        email := "test@test.com"
      }
    )
  `;
  const sql = compileEdgeQL(source);

  // Single element should not produce UNION ALL
  assertEquals(sql.includes("UNION ALL"), false);
  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("'Ada'"), true);
});

Deno.test("SQL Compiler - FOR with subquery iterator produces LATERAL", () => {
  const source = `
    FOR user IN (SELECT User)
    UNION (
      DELETE User
      FILTER .email = "test"
    )
  `;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("LATERAL"), true);
  assertEquals(sql.includes("for_iter"), true);
  assertEquals(sql.includes("for_sub"), true);
});

Deno.test("SQL Compiler - FOR with subquery LATERAL structure", () => {
  const source = `
    FOR x IN (SELECT User)
    UNION (
      INSERT User {
        name := x,
        email := "copied@test.com"
      }
    )
  `;
  const sql = compileEdgeQL(source);

  // Should produce FROM (iterator) AS for_iter(val), LATERAL (body) AS for_sub
  assertEquals(sql.includes("LATERAL"), true);
  assertEquals(sql.includes("for_iter"), true);
  assertEquals(sql.includes("for_sub"), true);
  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("for_iter"), true);
});

// contains() and find() compilation tests

Deno.test("SQL Compiler - contains() compiles to STRPOS > 0", () => {
  const source = `SELECT contains("hello world", "world")`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("STRPOS"), true);
  assertEquals(sql.includes("> 0"), true);
  assertEquals(sql.includes("'hello world'"), true);
  assertEquals(sql.includes("'world'"), true);
});

Deno.test("SQL Compiler - find() compiles to STRPOS - 1", () => {
  const source = `SELECT find("hello world", "world")`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("STRPOS"), true);
  assertEquals(sql.includes("- 1"), true);
  assertEquals(sql.includes("'hello world'"), true);
  assertEquals(sql.includes("'world'"), true);
});

// Type cast function compilation tests

Deno.test("SQL Compiler - to_str() compiles to CAST AS text", () => {
  const source = `SELECT to_str(42)`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("CAST"), true);
  assertEquals(sql.includes("AS text"), true);
  assertEquals(sql.includes("42"), true);
});

Deno.test("SQL Compiler - to_int64() compiles to CAST AS bigint", () => {
  const source = `SELECT to_int64("42")`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("CAST"), true);
  assertEquals(sql.includes("AS bigint"), true);
  assertEquals(sql.includes("'42'"), true);
});

Deno.test("SQL Compiler - to_float64() compiles to CAST AS double precision", () => {
  const source = `SELECT to_float64("3.14")`;
  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("CAST"), true);
  assertEquals(sql.includes("AS double precision"), true);
  assertEquals(sql.includes("'3.14'"), true);
});

// CastExpression codegen test

Deno.test("SQL Code Generator - CastExpression", () => {
  const codegen2 = new SQLCodeGenerator();
  const sql = codegen2.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "CastExpression",
          expression: { kind: "LiteralExpression", type: "number", value: 42 },
          targetType: "text",
        },
      }],
    },
  });

  assertEquals(sql.includes("CAST(42 AS text)"), true);
});

// UnionAllStatement codegen test

Deno.test("SQL Code Generator - UnionAllStatement", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "UnionAllStatement",
    queries: [
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 1 },
          }],
        },
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 },
          }],
        },
      },
    ],
  });

  assertEquals(sql.includes("UNION ALL"), true);
  assertEquals(sql.includes("1"), true);
  assertEquals(sql.includes("2"), true);
});

// Subquery in expression position tests

Deno.test("SQL Compiler - Subquery in FILTER with IN operator", () => {
  const source = `
    SELECT User { name }
    FILTER .name IN (SELECT User.name FILTER .active = true)
  `;
  const sql = compileEdgeQL(source);

  // Should contain IN with a subquery
  assertEquals(sql.includes("IN"), true);
  assertEquals(sql.includes("WHERE"), true);
  // The subquery should produce a nested SELECT
  assertEquals(sql.includes("name"), true);
});

Deno.test("SQL Compiler - Subquery in expression position compiles to SubqueryExpression", () => {
  const source = `
    SELECT User { name }
    FILTER .active = (SELECT true)
  `;
  const sql = compileEdgeQL(source);

  // The RHS of = should be a subquery wrapped in parens
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("TRUE"), true);
});

Deno.test("SQL Compiler - EXISTS with subquery", () => {
  const source = `
    SELECT User { name }
    FILTER EXISTS (SELECT User FILTER .active = true)
  `;
  const sql = compileEdgeQL(source);

  // Should generate EXISTS with a subquery
  assertEquals(sql.includes("EXISTS"), true);
  assertEquals(sql.includes("WHERE"), true);
});

// OFFSET tests

Deno.test("SQL Compiler - SELECT with OFFSET and LIMIT", () => {
  const source = `
    SELECT User {
      name
    }
    ORDER BY .name
    OFFSET 5
    LIMIT 10
  `;

  const sql = compileEdgeQL(source);

  // Should generate ORDER BY, OFFSET, and LIMIT
  assertEquals(sql.includes("ORDER BY"), true);
  assertEquals(sql.includes("OFFSET 5"), true);
  assertEquals(sql.includes("LIMIT 10"), true);
});

Deno.test("SQL Code Generator - OFFSET Clause", () => {
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
    offset: {
      kind: "OffsetClause",
      count: {
        kind: "LiteralExpression",
        type: "number",
        value: 5,
      },
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
  assertEquals(sql.includes("OFFSET 5"), true);
  assertEquals(sql.includes("LIMIT 10"), true);
});

// WITH / CTE name resolution tests

Deno.test("SQL Compiler - WITH CTE body references CTE name with shape", () => {
  const source = `
    WITH active := (SELECT User FILTER .active = true)
    SELECT active { name }
  `;

  const sql = compileEdgeQL(source);

  // Should produce a WITH clause containing the CTE
  assertEquals(sql.includes("WITH"), true, "SQL should contain WITH");
  // The CTE name should appear as the source table in the body
  assertEquals(
    sql.includes("FROM"),
    true,
    "Body query should have a FROM clause",
  );
  // The shape should resolve the 'name' property
  assertEquals(
    sql.includes("'name'"),
    true,
    "Shape should resolve the 'name' property",
  );
  // The CTE name should be used in FROM
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference the CTE alias 'active'",
  );
});

Deno.test("SQL Compiler - WITH multiple CTEs, body references second CTE", () => {
  const source = `
    WITH
      seniors := (SELECT User FILTER .age > 60),
      youngsters := (SELECT User FILTER .age < 25)
    SELECT youngsters { name, email }
  `;

  const sql = compileEdgeQL(source);

  // Should have both CTEs in the WITH clause
  assertEquals(sql.includes("WITH"), true, "SQL should contain WITH");
  assertEquals(
    sql.includes("seniors"),
    true,
    "SQL should contain 'seniors' CTE",
  );
  assertEquals(
    sql.includes("youngsters"),
    true,
    "SQL should contain 'youngsters' CTE",
  );
  // The body should reference youngsters as a table
  assertEquals(sql.includes("FROM"), true, "Body should have FROM clause");
  // Shape fields should be resolved
  assertEquals(sql.includes("'name'"), true, "Shape should resolve 'name'");
  assertEquals(sql.includes("'email'"), true, "Shape should resolve 'email'");
});

Deno.test("SQL Compiler - WITH CTE without shape selects all columns", () => {
  const source = `
    WITH active := (SELECT User FILTER .active = true)
    SELECT active
  `;

  const sql = compileEdgeQL(source);

  // Should produce WITH and FROM referencing the CTE
  assertEquals(sql.includes("WITH"), true, "SQL should contain WITH");
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference the CTE alias",
  );
  // Should use implicit shape (jsonb_build_object with all columns)
  assertEquals(
    sql.includes("jsonb_build_object"),
    true,
    "Implicit shape should produce jsonb_build_object",
  );
});

// INTERSECT / EXCEPT set operation tests

Deno.test("SQL Compiler - INTERSECT produces SQL INTERSECT", () => {
  const source = `
    SELECT User { name } FILTER .active = true
    INTERSECT
    SELECT User { name } FILTER .age > 30
  `;

  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("INTERSECT"),
    true,
    "SQL should contain INTERSECT",
  );
  // Should NOT contain UNION ALL
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL for INTERSECT",
  );
});

Deno.test("SQL Compiler - EXCEPT produces SQL EXCEPT", () => {
  const source = `
    SELECT User { name } FILTER .active = true
    EXCEPT
    SELECT User { name } FILTER .age > 30
  `;

  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("EXCEPT"),
    true,
    "SQL should contain EXCEPT",
  );
  // Should NOT contain UNION ALL
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL for EXCEPT",
  );
});

Deno.test("SQL Compiler - UNION produces SQL UNION ALL", () => {
  const source = `
    SELECT User { name } FILTER .active = true
    UNION
    SELECT User { name } FILTER .age > 30
  `;

  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("UNION ALL"),
    true,
    "EdgeQL UNION should produce SQL UNION ALL",
  );
});

Deno.test("SQL Code Generator - UnionAllStatement with INTERSECT operator", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "UnionAllStatement",
    queries: [
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 1 },
          }],
        },
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 },
          }],
        },
      },
    ],
    operator: "INTERSECT",
  });

  assertEquals(sql.includes("INTERSECT"), true, "SQL should contain INTERSECT");
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL",
  );
});

Deno.test("SQL Code Generator - UnionAllStatement with EXCEPT operator", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "UnionAllStatement",
    queries: [
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 1 },
          }],
        },
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 },
          }],
        },
      },
    ],
    operator: "EXCEPT",
  });

  assertEquals(sql.includes("EXCEPT"), true, "SQL should contain EXCEPT");
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL",
  );
});

Deno.test("SQL Code Generator - UnionAllStatement defaults to UNION ALL when no operator", () => {
  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate({
    kind: "UnionAllStatement",
    queries: [
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 1 },
          }],
        },
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 },
          }],
        },
      },
    ],
    // No operator field — should default to UNION ALL
  });

  assertEquals(sql.includes("UNION ALL"), true, "Should default to UNION ALL");
});

// =========================================================================
// Window Function Compilation Tests
// =========================================================================

Deno.test("SQL Compiler - Window function: row_number() OVER (PARTITION BY ... ORDER BY ...)", () => {
  const source = `
    SELECT User {
      name,
      rank := row_number() OVER (PARTITION BY .department ORDER BY .salary DESC)
    }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ROW_NUMBER()"),
    true,
    "SQL should contain ROW_NUMBER()",
  );
  assertEquals(
    sql.includes("OVER"),
    true,
    "SQL should contain OVER clause",
  );
  assertEquals(
    sql.includes("PARTITION BY"),
    true,
    "SQL should contain PARTITION BY",
  );
  assertEquals(
    sql.includes("ORDER BY"),
    true,
    "SQL should contain ORDER BY in OVER clause",
  );
  assertEquals(
    sql.includes("DESC"),
    true,
    "SQL should contain DESC direction",
  );
});

Deno.test("SQL Compiler - Aggregate as window: sum(.salary) OVER (ORDER BY .name)", () => {
  const source = `
    SELECT User {
      name,
      running_total := sum(.salary) OVER (ORDER BY .name)
    }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("SUM("),
    true,
    "SQL should contain SUM(",
  );
  assertEquals(
    sql.includes("OVER"),
    true,
    "SQL should contain OVER clause",
  );
  assertEquals(
    sql.includes("ORDER BY"),
    true,
    "SQL should contain ORDER BY in OVER clause",
  );
});

Deno.test("SQL Code Generator - WindowFunctionExpression with frame", () => {
  const codegen2 = new SQLCodeGenerator();
  const sql = codegen2.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "WindowFunctionExpression",
          function: "ROW_NUMBER",
          args: [],
          over: {
            kind: "WindowClause",
            orderBy: [{
              kind: "OrderByItem",
              expression: { kind: "ColumnReference", column: "id" },
              direction: "ASC",
            }],
            frame: {
              kind: "WindowFrame",
              mode: "ROWS",
              start: "UNBOUNDED PRECEDING",
              end: "CURRENT ROW",
            },
          },
        },
      }],
    },
  });

  assertEquals(
    sql.includes("ROW_NUMBER() OVER"),
    true,
    "SQL should contain ROW_NUMBER() OVER",
  );
  assertEquals(
    sql.includes("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"),
    true,
    "SQL should contain frame spec",
  );
});

// =========================================================================
// OVER Enforcement Tests
// =========================================================================

Deno.test("OVER enforcement - window-only function without OVER throws error", () => {
  const source = `SELECT row_number()`;

  assertThrows(
    () => {
      compileEdgeQL(source);
    },
    CompilationError,
    "requires an OVER clause",
  );
});

Deno.test("OVER enforcement - non-window function with OVER throws error", () => {
  // Construct a WindowFunctionCall AST node with name "len" (a scalar function)
  // and compile it directly, since the parser would not produce this combination
  const testSchema = createTestSchema();
  const testCompiler = new EdgeQLCompiler(testSchema);

  const ast: import("../edgeql/ast.ts").SelectQuery = {
    kind: "SelectQuery",
    expr: {
      kind: "WindowFunctionCall",
      name: { kind: "QualifiedName", parts: ["len"] },
      args: [{
        kind: "FunctionArg",
        name: undefined,
        value: { kind: "Literal", type: "string", value: "hello" },
      }],
      over: {
        kind: "WindowOverClause",
        orderBy: [{
          kind: "OrderByClause",
          expr: {
            kind: "Path",
            steps: [{ kind: "PathStep", type: "property", name: "name" }],
          },
          direction: "ASC",
        }],
      },
    },
  };

  const result = testCompiler.compile(ast);
  assertEquals(result.ok, false, "Should fail compilation");
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("cannot be used with an OVER clause"),
      true,
      "Error should mention OVER clause restriction",
    );
  }
});

Deno.test("OVER enforcement - aggregate function with OVER succeeds", () => {
  const source = `
    SELECT User {
      name,
      running_count := count(.name) OVER (PARTITION BY .active)
    }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("COUNT("),
    true,
    "SQL should contain COUNT(",
  );
  assertEquals(
    sql.includes("OVER"),
    true,
    "SQL should contain OVER clause",
  );
  assertEquals(
    sql.includes("PARTITION BY"),
    true,
    "SQL should contain PARTITION BY",
  );
});

Deno.test("Frame exclusion compiles to correct SQL", () => {
  const source = `
    SELECT User {
      name,
      rn := row_number() OVER (ORDER BY .name ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW)
    }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("EXCLUDE CURRENT ROW"),
    true,
    "SQL should contain EXCLUDE CURRENT ROW",
  );
  assertEquals(
    sql.includes("ROWS BETWEEN"),
    true,
    "SQL should contain frame spec",
  );
});

// =========================================================================
// Recursive CTE Compilation Tests
// =========================================================================

Deno.test("SQL Compiler - WITH RECURSIVE generates SQL WITH RECURSIVE", () => {
  const source = `
    WITH RECURSIVE nums := (
      SELECT User FILTER .active = true
      UNION
      SELECT User FILTER .name = 'admin'
    )
    SELECT nums { name }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("WITH RECURSIVE"),
    true,
    "SQL should contain WITH RECURSIVE",
  );
  assertEquals(
    sql.includes("nums"),
    true,
    "SQL should contain the CTE name 'nums'",
  );
});

Deno.test("SQL Compiler - WITH without RECURSIVE does not produce WITH RECURSIVE", () => {
  const source = `
    WITH active := (SELECT User FILTER .active = true)
    SELECT active { name }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("WITH"),
    true,
    "SQL should contain WITH",
  );
  assertEquals(
    sql.includes("WITH RECURSIVE"),
    false,
    "SQL should NOT contain WITH RECURSIVE",
  );
});

Deno.test("SQL Compiler - recursive CTE requires UNION ALL", () => {
  const source = `
    WITH RECURSIVE nums := (SELECT User FILTER .active = true)
    SELECT nums
  `;

  assertThrows(
    () => compileEdgeQL(source),
    CompilationError,
    "must contain a UNION ALL between base case and recursive case",
  );
});

Deno.test("SQL Compiler - recursive CTE rejects INTERSECT", () => {
  const source = `
    WITH RECURSIVE nums := (
      SELECT User FILTER .active = true
      INTERSECT
      SELECT User FILTER .name = 'admin'
    )
    SELECT nums
  `;

  assertThrows(
    () => compileEdgeQL(source),
    CompilationError,
    "must contain a UNION ALL between base case and recursive case",
  );
});

Deno.test("SQL Compiler - valid recursive CTE with UNION compiles", () => {
  const source = `
    WITH RECURSIVE nums := (
      SELECT User FILTER .active = true
      UNION
      SELECT User FILTER .name = 'admin'
    )
    SELECT nums { name }
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("WITH RECURSIVE"),
    true,
    "SQL should contain WITH RECURSIVE",
  );
  assertEquals(
    sql.includes("UNION ALL"),
    true,
    "SQL should contain UNION ALL",
  );
});

// =========================================================================
// CTE Multiple References Tests (Stage 4)
// =========================================================================

Deno.test("SQL Compiler - WITH CTE referenced once generates valid SQL with CTE alias", () => {
  const source = `
    WITH active := (SELECT User FILTER .active = true)
    SELECT active { name, email }
  `;

  const sql = compileEdgeQL(source);

  // The SQL should contain a WITH clause defining the CTE
  assertEquals(sql.includes("WITH"), true, "SQL should contain WITH");
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference CTE alias 'active'",
  );
  // The body query should produce a FROM clause referencing the CTE
  assertEquals(sql.includes("FROM"), true, "Body should have FROM clause");
  // The shape should resolve both 'name' and 'email'
  assertEquals(sql.includes("'name'"), true, "Shape should resolve 'name'");
  assertEquals(sql.includes("'email'"), true, "Shape should resolve 'email'");
});
