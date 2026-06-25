/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for EdgeQL to SQL Compiler
 */

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
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
          column: "name"
        }
      }]
    }
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
            column: "active"
          },
          right: {
            kind: "LiteralExpression",
            type: "boolean",
            value: true
          }
        }
      }]
    }
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
                column: "name"
              }
            },
            {
              kind: "JsonField",
              key: "email",
              value: {
                kind: "ColumnReference",
                column: "email"
              }
            }
          ]
        }
      }]
    }
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
            value: "*"
          }]
        }
      }]
    }
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
          column: "name"
        }
      }]
    },
    from: {
      kind: "FromClause",
      tables: [{
        kind: "TableReference",
        name: "users",
        alias: "u"
      }]
    },
    where: {
      kind: "WhereClause",
      condition: {
        kind: "BinaryExpression",
        operator: "=",
        left: {
          kind: "ColumnReference",
          table: "u",
          column: "active"
        },
        right: {
          kind: "LiteralExpression",
          type: "boolean",
          value: true
        }
      }
    }
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
          column: "name"
        }
      }]
    },
    orderBy: {
      kind: "OrderByClause",
      items: [{
        kind: "OrderByItem",
        expression: {
          kind: "ColumnReference",
          column: "name"
        },
        direction: "ASC"
      }]
    },
    limit: {
      kind: "LimitClause",
      count: {
        kind: "LiteralExpression",
        type: "number",
        value: 10
      }
    }
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
          column: "order" // Reserved keyword
        }
      }]
    }
  });

  assertEquals(sql.includes("\"order\""), true);
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
          value: "It's a test"
        }
      }]
    }
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

Deno.test("SQL Compiler - INSERT link via select subquery projects target id", () => {
  const source = `
    INSERT Post {
      title := "Hello",
      body := "World",
      author := (SELECT User FILTER .email = "ada@example.com")
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("INSERT INTO"), true);
  assertEquals(sql.includes("author_id"), true);
  // The subquery must yield the target's id for the FK column, not a jsonb
  // shape (alias counter depends on test order, so match any user_N)
  assertEquals(/user_\d+\.id/.test(sql), true);
  assertEquals(sql.includes("jsonb_build_object"), false);
});

Deno.test("SQL Compiler - INSERT link via direct uuid cast still compiles to a plain cast", () => {
  const source = `
    INSERT Post {
      title := "Hello",
      body := "World",
      author := <uuid>$author
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("author_id"), true);
  assertEquals(sql.includes("CAST($1 AS uuid)") || sql.includes("CAST($2 AS uuid)") || sql.includes("CAST($3 AS uuid)"), true);
});

Deno.test("SQL Compiler - UPDATE link via select subquery projects target id", () => {
  const source = `
    UPDATE Post
    FILTER .title = "Hello"
    SET {
      author := (SELECT User FILTER .email = "ada@example.com")
    }
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("author_id ="), true);
  assertEquals(/user_\d+\.id/.test(sql), true);
  assertEquals(sql.includes("jsonb_build_object"), false);
});

Deno.test("SQL Compiler - UPSERT else clause link via select subquery projects target id", () => {
  const source = `
    INSERT Post {
      title := "Hello",
      body := "World",
      author := (SELECT User FILTER .email = "ada@example.com")
    }
    UNLESS CONFLICT ON .title
    ELSE (
      UPDATE Post
      SET {
        author := (SELECT User FILTER .email = "billie@example.com")
      }
    )
  `;

  const sql = compileEdgeQL(source);

  assertEquals(sql.includes("ON CONFLICT"), true);
  assertEquals(sql.includes("DO UPDATE"), true);
  assertEquals(sql.includes("jsonb_build_object"), false);
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
          targetType: "text"
        }
      }]
    }
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
            expression: { kind: "LiteralExpression", type: "number", value: 1 }
          }]
        }
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 }
          }]
        }
      }
    ]
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
          column: "name"
        }
      }]
    },
    orderBy: {
      kind: "OrderByClause",
      items: [{
        kind: "OrderByItem",
        expression: {
          kind: "ColumnReference",
          column: "name"
        },
        direction: "ASC"
      }]
    },
    offset: {
      kind: "OffsetClause",
      count: {
        kind: "LiteralExpression",
        type: "number",
        value: 5
      }
    },
    limit: {
      kind: "LimitClause",
      count: {
        kind: "LiteralExpression",
        type: "number",
        value: 10
      }
    }
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
    "Body query should have a FROM clause"
  );
  // The shape should resolve the 'name' property
  assertEquals(
    sql.includes("'name'"),
    true,
    "Shape should resolve the 'name' property"
  );
  // The CTE name should be used in FROM
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference the CTE alias 'active'"
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
    "SQL should contain 'seniors' CTE"
  );
  assertEquals(
    sql.includes("youngsters"),
    true,
    "SQL should contain 'youngsters' CTE"
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
    "SQL should reference the CTE alias"
  );
  // Should use implicit shape (jsonb_build_object with all columns)
  assertEquals(
    sql.includes("jsonb_build_object"),
    true,
    "Implicit shape should produce jsonb_build_object"
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
    "SQL should contain INTERSECT"
  );
  // Should NOT contain UNION ALL
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL for INTERSECT"
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
    "SQL should contain EXCEPT"
  );
  // Should NOT contain UNION ALL
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL for EXCEPT"
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
    "EdgeQL UNION should produce SQL UNION ALL"
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
            expression: { kind: "LiteralExpression", type: "number", value: 1 }
          }]
        }
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 }
          }]
        }
      }
    ],
    operator: "INTERSECT"
  });

  assertEquals(sql.includes("INTERSECT"), true, "SQL should contain INTERSECT");
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL"
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
            expression: { kind: "LiteralExpression", type: "number", value: 1 }
          }]
        }
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 }
          }]
        }
      }
    ],
    operator: "EXCEPT"
  });

  assertEquals(sql.includes("EXCEPT"), true, "SQL should contain EXCEPT");
  assertEquals(
    sql.includes("UNION ALL"),
    false,
    "SQL should not contain UNION ALL"
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
            expression: { kind: "LiteralExpression", type: "number", value: 1 }
          }]
        }
      },
      {
        kind: "SelectStatement",
        select: {
          kind: "SelectClause",
          columns: [{
            kind: "SelectItem",
            expression: { kind: "LiteralExpression", type: "number", value: 2 }
          }]
        }
      }
    ]
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
    "SQL should contain ROW_NUMBER()"
  );
  assertEquals(
    sql.includes("OVER"),
    true,
    "SQL should contain OVER clause"
  );
  assertEquals(
    sql.includes("PARTITION BY"),
    true,
    "SQL should contain PARTITION BY"
  );
  assertEquals(
    sql.includes("ORDER BY"),
    true,
    "SQL should contain ORDER BY in OVER clause"
  );
  assertEquals(
    sql.includes("DESC"),
    true,
    "SQL should contain DESC direction"
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
    "SQL should contain SUM("
  );
  assertEquals(
    sql.includes("OVER"),
    true,
    "SQL should contain OVER clause"
  );
  assertEquals(
    sql.includes("ORDER BY"),
    true,
    "SQL should contain ORDER BY in OVER clause"
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
              direction: "ASC"
            }],
            frame: {
              kind: "WindowFrame",
              mode: "ROWS",
              start: "UNBOUNDED PRECEDING",
              end: "CURRENT ROW"
            }
          }
        }
      }]
    }
  });

  assertEquals(
    sql.includes("ROW_NUMBER() OVER"),
    true,
    "SQL should contain ROW_NUMBER() OVER"
  );
  assertEquals(
    sql.includes("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"),
    true,
    "SQL should contain frame spec"
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
    "requires an OVER clause"
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
        value: { kind: "Literal", type: "string", value: "hello" }
      }],
      over: {
        kind: "WindowOverClause",
        orderBy: [{
          kind: "OrderByClause",
          expr: {
            kind: "Path",
            steps: [{ kind: "PathStep", type: "property", name: "name" }]
          },
          direction: "ASC"
        }]
      }
    }
  };

  const result = testCompiler.compile(ast);
  assertEquals(result.ok, false, "Should fail compilation");
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("cannot be used with an OVER clause"),
      true,
      "Error should mention OVER clause restriction"
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
    "SQL should contain COUNT("
  );
  assertEquals(
    sql.includes("OVER"),
    true,
    "SQL should contain OVER clause"
  );
  assertEquals(
    sql.includes("PARTITION BY"),
    true,
    "SQL should contain PARTITION BY"
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
    "SQL should contain EXCLUDE CURRENT ROW"
  );
  assertEquals(
    sql.includes("ROWS BETWEEN"),
    true,
    "SQL should contain frame spec"
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
    "SQL should contain WITH RECURSIVE"
  );
  assertEquals(
    sql.includes("nums"),
    true,
    "SQL should contain the CTE name 'nums'"
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
    "SQL should contain WITH"
  );
  assertEquals(
    sql.includes("WITH RECURSIVE"),
    false,
    "SQL should NOT contain WITH RECURSIVE"
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
    "must contain a UNION ALL between base case and recursive case"
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
    "must contain a UNION ALL between base case and recursive case"
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
    "SQL should contain WITH RECURSIVE"
  );
  assertEquals(
    sql.includes("UNION ALL"),
    true,
    "SQL should contain UNION ALL"
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
    "SQL should reference CTE alias 'active'"
  );
  // The body query should produce a FROM clause referencing the CTE
  assertEquals(sql.includes("FROM"), true, "Body should have FROM clause");
  // The shape should resolve both 'name' and 'email'
  assertEquals(sql.includes("'name'"), true, "Shape should resolve 'name'");
  assertEquals(sql.includes("'email'"), true, "Shape should resolve 'email'");
});

// --- Gap #1: { * } splat shape expansion ---

Deno.test("SQL Compiler - SELECT User { * } expands to all scalar properties", () => {
  const sql = compileEdgeQL("SELECT User { * }");
  // Every scalar property of the test schema's User type must appear as a
  // jsonb key. createTestSchema() puts: id, name, email, createdAt, active,
  // age, postCount on User.
  assertEquals(sql.includes("jsonb_build_object"), true);
  for (const key of ["id", "name", "email", "createdAt", "active", "age"]) {
    assertEquals(
      sql.includes(`'${key}'`),
      true,
      `splat should expand to include '${key}' (sql: ${sql})`
    );
  }
});

Deno.test("SQL Compiler - { * } splat excludes computed properties", () => {
  // `postCount` is a computed property on User (columnName "post_count").
  // Splat must NOT emit it — doing so referenced a nonexistent column
  // (e.g. `column user.post_count does not exist`). Computed fields are
  // opt-in via explicit selection.
  const sql = compileEdgeQL("SELECT User { * }");
  assertEquals(sql.includes("post_count"), false, `splat leaked computed col: ${sql}`);
  assertEquals(sql.includes("'postCount'"), false, `splat leaked computed key: ${sql}`);
  // Stored scalars are still present.
  assertEquals(sql.includes("'name'"), true);
});

Deno.test("SQL Compiler - { * } splat coexists with FILTER", () => {
  const sql = compileEdgeQL(
    "SELECT User { * } FILTER .active = true"
  );
  // Both the expansion and the filter clause should be present
  assertEquals(sql.includes("'name'"), true);
  assertEquals(sql.includes("WHERE"), true);
});

// --- Gap #5: multi-step path expressions (link traversal) ---

Deno.test("SQL Compiler - 2-step .link.id uses the foreign-key column directly", () => {
  // Post has `author: User` (single link, columnName "author_id"). Asking
  // for `.author.id` is asking for the FK itself — no JOIN needed.
  const sql = compileEdgeQL(
    "SELECT Post { id } FILTER .author.id = <uuid>$id"
  );
  // The compiled SQL must reference the FK column on posts, not a join
  assertEquals(
    sql.includes("author_id"),
    true,
    `expected 'author_id' in SQL: ${sql}`
  );
  // No JOIN — the optimisation point of this path
  assertEquals(/JOIN/i.test(sql), false, `unexpected JOIN: ${sql}`);
});

Deno.test("SQL Compiler - 2-step .link.<other_field> compiles via correlated subquery", () => {
  // Asking for a non-id field of the linked object requires looking it
  // up in the target table.
  const sql = compileEdgeQL(
    "SELECT Post { id } FILTER .author.email = <str>$e"
  );
  // Subquery must hit the target's table (users) and project the column
  assertEquals(
    sql.includes("users"),
    true,
    `expected 'users' in subquery SQL: ${sql}`
  );
  assertEquals(
    sql.includes("email"),
    true,
    `expected 'email' projected in subquery SQL: ${sql}`
  );
  // FK column on the source side connects the subquery
  assertEquals(
    sql.includes("author_id"),
    true,
    `expected 'author_id' linkage in SQL: ${sql}`
  );
});

// --- Multi-cardinality 2-step path: backlink with EXISTS rewrite ---

Deno.test("SQL Compiler - multi-link .posts.title = X rewrites to EXISTS subquery", () => {
  // User has `multi posts: Post` with backlink "author". `.posts.title`
  // is the SET of all post titles for this user; `... = "X"` matches
  // when any post has title X. SQL: EXISTS subquery on posts table.
  const sql = compileEdgeQL(
    "SELECT User { id } FILTER .posts.title = <str>$t"
  );
  assertEquals(/EXISTS/i.test(sql), true, `expected EXISTS subquery: ${sql}`);
  assertEquals(sql.includes("posts"), true);
  assertEquals(sql.includes("title"), true);
  assertEquals(
    sql.includes("author_id"),
    true,
    `expected backlink FK 'author_id': ${sql}`
  );
});

Deno.test("SQL Compiler - multi-link .posts.title with operator (gte) preserves operator inside EXISTS", () => {
  const sql = compileEdgeQL(
    "SELECT User { id } FILTER .posts.title > <str>$t"
  );
  assertEquals(/EXISTS/i.test(sql), true);
  // The comparison operator must appear inside the subquery body
  assertEquals(sql.includes(">"), true);
});

Deno.test("SQL Compiler - multi-link .posts.id rewrites to EXISTS using FK shortcut inside subquery", () => {
  // .posts.id over a backlink: still EXISTS, but the projected column
  // is the target's id (which is just `id`, not the FK).
  const sql = compileEdgeQL(
    "SELECT User { id } FILTER .posts.id = <uuid>$pid"
  );
  assertEquals(/EXISTS/i.test(sql), true);
  assertEquals(sql.includes("posts"), true);
});

Deno.test("SQL Compiler - multi-link .posts.id IN array_unpack rewrites to EXISTS with = ANY", () => {
  // The SDK filter API emits `.tags.id in array_unpack(<array<uuid>>$p)` for
  // `{ tags: { id: { in: [...] } } }`. Over a multi-link this must become an
  // EXISTS whose inner membership is `= ANY(arr)` (not invalid `IN UNNEST`).
  const sql = compileEdgeQL(
    "SELECT User { id } FILTER .posts.id in array_unpack(<array<uuid>>$ids)"
  );
  assertEquals(/EXISTS/i.test(sql), true, `expected EXISTS: ${sql}`);
  assertEquals(/=\s*ANY\(/i.test(sql), true, `expected = ANY(...): ${sql}`);
  assertEquals(sql.includes("IN UNNEST"), false, `must not emit IN UNNEST: ${sql}`);
});

Deno.test("SQL Compiler - multi-link .posts.title IN array_unpack joins target inside EXISTS", () => {
  const sql = compileEdgeQL(
    "SELECT User { id } FILTER .posts.title in array_unpack(<array<str>>$ts)"
  );
  assertEquals(/EXISTS/i.test(sql), true);
  assertEquals(/=\s*ANY\(/i.test(sql), true, `expected = ANY(...): ${sql}`);
  assertEquals(sql.includes("title"), true);
});

Deno.test("SQL Compiler - multi-link .posts.id NOT IN array_unpack uses <> ALL inside EXISTS", () => {
  const sql = compileEdgeQL(
    "SELECT User { id } FILTER .posts.id not in array_unpack(<array<uuid>>$ids)"
  );
  assertEquals(/EXISTS/i.test(sql), true);
  assertEquals(/<>\s*ALL\(/i.test(sql), true, `expected <> ALL(...): ${sql}`);
});

// --- Showcase #2: 3+ hop path expressions ---

/**
 * Build a focused 3-hop chain schema so we can test deep paths without
 * pulling in unrelated complexity from createTestSchema(). The chain:
 * Payment → merchant → owner → email.
 */
function makeChainSchema() {
  const ownerType = {
    name: "Owner",
    kind: "object" as const,
    tableName: "owners",
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
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };
  const merchantType = {
    name: "Merchant",
    kind: "object" as const,
    tableName: "merchants",
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
    links: new Map([
      ["owner", {
        name: "owner",
        target: "Owner",
        required: true,
        multi: false,
        columnName: "owner_id"
      }]
    ])
  };
  const paymentType = {
    name: "Payment",
    kind: "object" as const,
    tableName: "payments",
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
      ["amount", {
        name: "amount",
        type: "float64",
        required: true,
        multi: false,
        columnName: "amount",
        edgeqlType: "float64"
      }]
    ]),
    links: new Map([
      ["merchant", {
        name: "merchant",
        target: "Merchant",
        required: true,
        multi: false,
        columnName: "merchant_id"
      }]
    ])
  };
  return {
    types: new Map([
      ["Owner", ownerType],
      ["Merchant", merchantType],
      ["Payment", paymentType]
    ]),
    functions: new Map()
  };
}

function compileChain(source: string): string {
  const localCompiler = new EdgeQLCompiler(makeChainSchema() as never);
  const ast = new EdgeQLParser(source).parse();
  const r = localCompiler.compile(ast);
  if (!r.ok) {
    throw r.error;
  }
  return new SQLCodeGenerator().generate(r.value);
}

Deno.test("SQL Compiler - 3-hop .merchant.owner.email composes nested correlated subqueries", () => {
  const sql = compileChain(
    "SELECT Payment { id } FILTER .merchant.owner.email = <str>$e"
  );
  // Outer subquery hits the owners table (final hop's target)
  assertEquals(sql.includes("owners"), true, `expected owners table: ${sql}`);
  // Inner subquery hits the merchants table (middle hop)
  assertEquals(sql.includes("merchants"), true, `expected merchants: ${sql}`);
  // The chain should reference owner_id (merchant's FK to owner)
  assertEquals(sql.includes("owner_id"), true, `expected owner_id: ${sql}`);
  // ...and merchant_id (payment's FK to merchant) at the deepest layer
  assertEquals(
    sql.includes("merchant_id"),
    true,
    `expected merchant_id: ${sql}`
  );
  // Final projected column is email
  assertEquals(sql.includes("email"), true);
});

Deno.test("SQL Compiler - 3-hop .merchant.owner.id collapses inner SELECT (terminal id is just the FK)", () => {
  // When the terminal step is `id`, the outermost SELECT degenerates —
  // the FK column on the previous hop already IS the target's id.
  const sql = compileChain(
    "SELECT Payment { id } FILTER .merchant.owner.id = <uuid>$id"
  );
  assertEquals(sql.includes("merchant_id"), true);
  assertEquals(sql.includes("owner_id"), true);
  // The outermost layer points at the merchants table (since the final
  // projection is owner_id, not a column on owners).
  assertEquals(sql.includes("merchants"), true);
});

// --- Showcase #3: junction-table multi-link traversal ---

/**
 * Schema with a many-to-many link via an explicit junction table:
 * User has `multi tags: Tag` linked through `user_tags(user_id, tag_id)`.
 */
function makeJunctionSchema() {
  const tagType = {
    name: "Tag",
    kind: "object" as const,
    tableName: "tags",
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
  const userType = {
    name: "User",
    kind: "object" as const,
    tableName: "users",
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
    links: new Map([
      ["tags", {
        name: "tags",
        target: "Tag",
        required: false,
        multi: true,
        junctionTable: "user_tags",
        junctionSourceColumn: "user_id",
        junctionTargetColumn: "tag_id"
      }]
    ])
  };
  return {
    types: new Map([
      ["Tag", tagType],
      ["User", userType]
    ]),
    functions: new Map()
  };
}

function compileJunction(source: string): string {
  const localCompiler = new EdgeQLCompiler(makeJunctionSchema() as never);
  const ast = new EdgeQLParser(source).parse();
  const r = localCompiler.compile(ast);
  if (!r.ok) {
    throw r.error;
  }
  return new SQLCodeGenerator().generate(r.value);
}

Deno.test("SQL Compiler - junction multi-link .tags.name rewrites to EXISTS with JOIN", () => {
  const sql = compileJunction(
    "SELECT User { id } FILTER .tags.name = <str>$n"
  );
  assertEquals(/EXISTS/i.test(sql), true, `expected EXISTS: ${sql}`);
  // Junction table appears
  assertEquals(sql.includes("user_tags"), true);
  // Target table appears (joined to project the name column)
  assertEquals(sql.includes("tags"), true);
  // Source-side and target-side junction columns
  assertEquals(sql.includes("user_id"), true);
  assertEquals(sql.includes("tag_id"), true);
  // INNER JOIN binds junction to target
  assertEquals(/JOIN/i.test(sql), true);
});

Deno.test("SQL Compiler - junction multi-link { * } sub-shape expands to target scalar fields", () => {
  // Regression: `link: { * }` on a junction-backed multi-link used to drop
  // the splat and emit `jsonb_build_object()` with no fields, yielding `{}`
  // rows (which non-null consumers like GraphQL reject). The splat must
  // expand to the target type's scalar properties.
  const sql = compileJunction("SELECT User { id, tags: { * } }");
  assertEquals(sql.includes("jsonb_agg"), true, `expected jsonb_agg: ${sql}`);
  // Splat expanded to Tag's scalar fields inside the aggregated object
  assertEquals(sql.includes("'name'"), true, `expected 'name' field: ${sql}`);
  assertEquals(sql.includes("'id'"), true, `expected 'id' field: ${sql}`);
});

Deno.test("SQL Compiler - junction multi-link .tags.id collapses (junction's tag_id IS the tag id)", () => {
  // When asking for .tags.id, no JOIN to `tags` is needed — the
  // junction's target FK column is already the id we're comparing.
  const sql = compileJunction(
    "SELECT User { id } FILTER .tags.id = <uuid>$tid"
  );
  assertEquals(/EXISTS/i.test(sql), true);
  assertEquals(sql.includes("user_tags"), true);
  assertEquals(sql.includes("tag_id"), true);
  // No JOIN needed in the optimised path
  assertEquals(/JOIN/i.test(sql), false, `unexpected JOIN: ${sql}`);
});

Deno.test("SQL Compiler - 'in array_unpack(<array<T>>$p)' lowers to '= ANY(...)'", () => {
  // `<scalar> in array_unpack(<array<uuid>>$ids)` must NOT emit the invalid
  // `IN UNNEST(...)`; the correct Postgres lowering is `= ANY(CAST($1 AS uuid[]))`.
  const sql = compileEdgeQL(
    "select User { name } filter .id in array_unpack(<array<uuid>>$ids)"
  );
  assertEquals(sql.includes("= ANY("), true, `expected = ANY(: ${sql}`);
  assertEquals(
    /IN\s+UNNEST/i.test(sql),
    false,
    `unexpected IN UNNEST: ${sql}`
  );
  assertEquals(
    sql.includes("CAST($1 AS uuid[])"),
    true,
    `expected array cast preserved: ${sql}`
  );
});

Deno.test("SQL Compiler - 'not in array_unpack(<array<T>>$p)' lowers to '<> ALL(...)'", () => {
  const sql = compileEdgeQL(
    "select User { name } filter .id not in array_unpack(<array<uuid>>$ids)"
  );
  assertEquals(sql.includes("<> ALL("), true, `expected <> ALL(: ${sql}`);
  assertEquals(
    /UNNEST/i.test(sql),
    false,
    `unexpected UNNEST: ${sql}`
  );
  assertEquals(
    sql.includes("CAST($1 AS uuid[])"),
    true,
    `expected array cast preserved: ${sql}`
  );
});

Deno.test("SQL Compiler - set-literal 'in {a, b}' membership is unchanged", () => {
  // Regression: the array_unpack fix must not touch set-literal membership,
  // which still compiles to `IN (...)`.
  const sql = compileEdgeQL("select User { name } filter .name in {'a', 'b'}");
  assertEquals(sql.includes("IN ('a', 'b')"), true, `expected IN (...): ${sql}`);
  assertEquals(sql.includes("ANY("), false, `unexpected ANY(: ${sql}`);
});

Deno.test("SQL Compiler - subquery 'in (select ...)' membership is unchanged", () => {
  // Regression: subquery membership still compiles to `IN (subquery)`.
  const sql = compileEdgeQL(
    "select User { name } filter .name in (select User.name)"
  );
  assertEquals(/IN\s*\(\s*SELECT/i.test(sql), true, `expected IN (SELECT: ${sql}`);
  assertEquals(sql.includes("ANY("), false, `unexpected ANY(: ${sql}`);
});

// --- Link sub-shape ordering (jsonb_agg ORDER BY) ---

Deno.test("SQL Compiler - link sub-shape order by emits jsonb_agg ORDER BY", () => {
  const sql = compileEdgeQL(
    "SELECT User { name, posts: { title } order by .title desc }"
  );
  assertEquals(sql.includes("jsonb_agg("), true, `expected jsonb_agg: ${sql}`);
  assertEquals(
    sql.includes("ORDER BY posts.title DESC"),
    true,
    `expected ordered jsonb_agg: ${sql}`
  );
});

Deno.test("SQL Compiler - link sub-shape multi-key order by joins with comma", () => {
  const sql = compileEdgeQL(
    "SELECT User { posts: { title } order by .title then .body }"
  );
  // Two keys inside the same jsonb_agg ORDER BY.
  assertEquals(
    sql.includes("ORDER BY posts.title ASC, posts.body ASC"),
    true,
    `expected two-key ordering: ${sql}`
  );
});

Deno.test("SQL Compiler - link sub-shape without order by is unchanged", () => {
  const sql = compileEdgeQL("SELECT User { posts: { title } }");
  assertEquals(sql.includes("jsonb_agg"), true);
  assertEquals(/ORDER BY/i.test(sql), false, `unexpected ORDER BY: ${sql}`);
});

// --- Showcase #4: two multi-link hops (nested EXISTS) ---

/**
 * A chain mixing backlink-style and junction-table multi links, plus a single
 * forward link, so deep filter paths can be exercised end to end:
 *   Customer --(multi channels)--> Channel --(multi videos)--> Video
 *   Video --(multi tags, junction)--> Tag
 *   Video --(single channel)--> Channel
 * The filter `.channels.videos.isDraft = 0` lowers to a 2-layer nested EXISTS;
 * `.channels.videos.tags.name = X` to a 3-layer one (junction at the deepest).
 */
function makeTwoHopSchema() {
  const tagType = {
    name: "Tag",
    kind: "object" as const,
    tableName: "tags",
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
  const videoType = {
    name: "Video",
    kind: "object" as const,
    tableName: "videos",
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
      ["isDraft", {
        name: "isDraft",
        type: "int64",
        required: true,
        multi: false,
        columnName: "is_draft",
        edgeqlType: "int64"
      }]
    ]),
    links: new Map<string, unknown>([
      ["channel", {
        name: "channel",
        target: "Channel",
        required: true,
        multi: false,
        columnName: "channel_id"
      }],
      ["tags", {
        name: "tags",
        target: "Tag",
        required: false,
        multi: true,
        junctionTable: "video_tags",
        junctionSourceColumn: "video_id",
        junctionTargetColumn: "tag_id"
      }]
    ])
  };
  const channelType = {
    name: "Channel",
    kind: "object" as const,
    tableName: "channels",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }]
    ]),
    links: new Map<string, unknown>([
      ["customer", {
        name: "customer",
        target: "Customer",
        required: true,
        multi: false,
        columnName: "customer_id"
      }],
      ["videos", {
        name: "videos",
        target: "Video",
        required: false,
        multi: true,
        backlink: "channel"
      }]
    ])
  };
  const customerType = {
    name: "Customer",
    kind: "object" as const,
    tableName: "customers",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }]
    ]),
    links: new Map<string, unknown>([
      ["channels", {
        name: "channels",
        target: "Channel",
        required: false,
        multi: true,
        backlink: "customer"
      }]
    ])
  };
  return {
    types: new Map([
      ["Tag", tagType],
      ["Video", videoType],
      ["Channel", channelType],
      ["Customer", customerType]
    ]),
    functions: new Map()
  };
}

function compileTwoHop(source: string): string {
  const localCompiler = new EdgeQLCompiler(makeTwoHopSchema() as never);
  const ast = new EdgeQLParser(source).parse();
  const r = localCompiler.compile(ast);
  if (!r.ok) {
    throw r.error;
  }
  return new SQLCodeGenerator().generate(r.value);
}

Deno.test("SQL Compiler - two multi-link hops .channels.videos.isDraft nests EXISTS", () => {
  const sql = compileTwoHop(
    "SELECT Customer { id } FILTER .channels.videos.isDraft = <int64>$d"
  );
  // Two EXISTS layers, one per multi hop.
  assertEquals(
    (sql.match(/EXISTS/gi) ?? []).length,
    2,
    `expected two EXISTS layers: ${sql}`
  );
  // Outer hop hits channels, correlated to the customer row.
  assertEquals(sql.includes("channels"), true, `expected channels: ${sql}`);
  assertEquals(sql.includes("customer_id"), true, `expected customer_id: ${sql}`);
  // Inner hop hits videos, correlated to the channel row, with the predicate.
  assertEquals(sql.includes("videos"), true, `expected videos: ${sql}`);
  assertEquals(sql.includes("channel_id"), true, `expected channel_id: ${sql}`);
  assertEquals(sql.includes("is_draft"), true, `expected is_draft column: ${sql}`);
});

Deno.test("SQL Compiler - two multi-link hops compose with AND across fields", () => {
  // The shape the SDK filter API emits for
  // `{ channels: { videos: { isDraft: 0, isPrivate: 0 } } }` — two separate
  // comparisons, each its own nested EXISTS, joined by AND.
  const sql = compileTwoHop(
    "SELECT Customer { id } FILTER .channels.videos.isDraft = <int64>$a " +
      "and .channels.videos.id = <uuid>$b"
  );
  assertEquals(
    (sql.match(/EXISTS/gi) ?? []).length,
    4,
    `expected four EXISTS layers (two per comparison): ${sql}`
  );
  assertEquals(/\bAND\b/i.test(sql), true, `expected AND: ${sql}`);
});

Deno.test("SQL Compiler - three multi-link hops .channels.videos.tags.name nests three EXISTS", () => {
  // Backlink → backlink → junction. The deepest hop joins the junction to the
  // tags table to project `name`.
  const sql = compileTwoHop(
    "SELECT Customer { id } FILTER .channels.videos.tags.name = <str>$n"
  );
  assertEquals(
    (sql.match(/EXISTS/gi) ?? []).length,
    3,
    `expected three EXISTS layers: ${sql}`
  );
  // Each hop's table is present, ending at the junction + tags projection.
  assertEquals(sql.includes("channels"), true, `expected channels: ${sql}`);
  assertEquals(sql.includes("videos"), true, `expected videos: ${sql}`);
  assertEquals(sql.includes("video_tags"), true, `expected junction: ${sql}`);
  assertEquals(sql.includes("name"), true, `expected name column: ${sql}`);
});

Deno.test("SQL Compiler - deep chain may end on a single-FK hop", () => {
  // ...videos.channel.id mixes two multi hops with a trailing single forward
  // link; the single hop correlates via the FK on its parent row.
  const sql = compileTwoHop(
    "SELECT Customer { id } FILTER .channels.videos.channel.id = <uuid>$x"
  );
  assertEquals(
    (sql.match(/EXISTS/gi) ?? []).length,
    3,
    `expected three EXISTS layers: ${sql}`
  );
  assertEquals(sql.includes("channel_id"), true, `expected channel_id FK: ${sql}`);
});
