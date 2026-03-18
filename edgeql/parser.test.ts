/**
 * Tests for EdgeQL Parser
 */

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "./parser.ts";
import { EdgeQLAnalyzer } from "./analyzer.ts";
import { SyntaxError } from "../lib/errors.ts";

Deno.test("EdgeQL Parser - Simple SELECT", () => {
  const source = `SELECT User`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.expr.kind, "TypeName");
    if (ast.expr.kind === "TypeName") {
      assertEquals(ast.expr.name.parts[0], "User");
    }
  }
});

Deno.test("EdgeQL Parser - SELECT with Shape", () => {
  const source = `
    SELECT User {
      name,
      email,
      createdAt
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.shape?.elements.length, 3);
    assertEquals(ast.shape?.elements[0].expr.kind, "Identifier");
  }
});

Deno.test("EdgeQL Parser - SELECT with Nested Shape", () => {
  const source = `
    SELECT User {
      name,
      posts: {
        title,
        body
      }
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.shape?.elements.length, 2);
    const postsElement = ast.shape?.elements[1];
    assertEquals(postsElement?.shape?.elements.length, 2);
  }
});

Deno.test("EdgeQL Parser - SELECT with FILTER", () => {
  const source = `
    SELECT User {
      name,
      email
    }
    FILTER .active = true
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.filter?.kind, "BinaryOp");
    if (ast.filter?.kind === "BinaryOp") {
      assertEquals(ast.filter.op, "=");
    }
  }
});

Deno.test("EdgeQL Parser - SELECT with ORDER BY and LIMIT", () => {
  const source = `
    SELECT User {
      name
    }
    ORDER BY .createdAt DESC
    LIMIT 10
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.orderBy?.length, 1);
    assertEquals(ast.orderBy?.[0].direction, "DESC");
    assertEquals(ast.limit?.kind, "Literal");
  }
});

Deno.test("EdgeQL Parser - Computed Properties", () => {
  const source = `
    SELECT User {
      name,
      full_name := .first_name ++ ' ' ++ .last_name,
      post_count := count(.posts)
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const fullNameElement = ast.shape?.elements[1];
    assertEquals(fullNameElement?.computable, true);
    assertEquals(fullNameElement?.name?.name, "full_name");
  }
});

Deno.test("EdgeQL Parser - INSERT Query", () => {
  const source = `
    INSERT User {
      name := "Alice",
      email := "alice@example.com"
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "InsertQuery");
  if (ast.kind === "InsertQuery") {
    assertEquals(ast.type.name.parts[0], "User");
    assertEquals(ast.shape.elements.length, 2);
  }
});

Deno.test("EdgeQL Parser - INSERT with UNLESS CONFLICT", () => {
  const source = `
    INSERT User {
      name := "Bob",
      email := "bob@example.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (
      UPDATE User SET { name := "Bob" }
    )
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "InsertQuery");
  if (ast.kind === "InsertQuery") {
    assertEquals(ast.unless?.kind, "ConflictClause");
    assertEquals(ast.unless?.on?.kind, "Path");
  }
});

Deno.test("EdgeQL Parser - UPDATE Query", () => {
  const source = `
    UPDATE User
    FILTER .id = <uuid>$userId
    SET {
      name := $new_name,
      updatedAt := datetime_current()
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "UpdateQuery");
  if (ast.kind === "UpdateQuery") {
    assertEquals(ast.type.name.parts[0], "User");
    assertEquals(ast.filter?.kind, "BinaryOp");
    assertEquals(ast.shape.elements.length, 2);
  }
});

Deno.test("EdgeQL Parser - DELETE Query", () => {
  const source = `
    DELETE User
    FILTER .email = "old@example.com"
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "DeleteQuery");
  if (ast.kind === "DeleteQuery") {
    assertEquals(ast.type.name.parts[0], "User");
    assertEquals(ast.filter?.kind, "BinaryOp");
  }
});

Deno.test("EdgeQL Parser - FOR Query", () => {
  const source = `
    FOR name IN {"Alice", "Bob", "Charlie"}
    UNION (
      INSERT User { name := name }
    )
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "ForQuery");
  if (ast.kind === "ForQuery") {
    assertEquals(ast.variable.name, "name");
    assertEquals(ast.iterator.kind, "SetExpr");
    assertEquals(ast.body.kind, "InsertQuery");
  }
});

Deno.test("EdgeQL Parser - WITH Block", () => {
  const source = `
    WITH 
      active_users := (SELECT User FILTER .active = true),
      total := count(active_users)
    SELECT active_users { name }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "WithBlock");
  if (ast.kind === "WithBlock") {
    assertEquals(ast.bindings.length, 2);
    assertEquals(ast.bindings[0].name.name, "active_users");
    assertEquals(ast.body.kind, "SelectQuery");
  }
});

Deno.test("EdgeQL Parser - Path Expressions", () => {
  const source = `
    SELECT User.posts.title
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.expr.kind === "Path") {
    assertEquals(ast.expr.steps.length, 3);
    assertEquals(ast.expr.steps[0].name, "User");
    assertEquals(ast.expr.steps[1].name, "posts");
    assertEquals(ast.expr.steps[2].name, "title");
  }
});

Deno.test("EdgeQL Parser - Backward Links", () => {
  const source = `
    SELECT Issue {
      title,
      owner := .<owner[IS User] { name }
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const ownerElement = ast.shape?.elements[1];
    if (ownerElement?.expr.kind === "Path") {
      assertEquals(ownerElement.expr.steps[0].type, "backlink");
    }
  }
});

Deno.test("EdgeQL Parser - Type Cast", () => {
  const source = `
    SELECT <str>42
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.expr.kind === "TypeCast") {
    assertEquals(ast.expr.type.name.parts[0], "str");
    assertEquals(ast.expr.expr.kind, "Literal");
  }
});

Deno.test("EdgeQL Parser - Function Calls", () => {
  const source = `
    SELECT count(User)
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.expr.kind === "FunctionCall") {
    assertEquals(ast.expr.name.parts[0], "count");
    assertEquals(ast.expr.args.length, 1);
  }
});

Deno.test("EdgeQL Parser - Set Operations", () => {
  const source = `
    SELECT User FILTER .role = "admin"
    UNION
    SELECT User FILTER .role = "moderator"
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    // The UNION becomes part of the expression
    assertEquals(ast.expr.kind, "BinaryOp");
    if (ast.expr.kind === "BinaryOp") {
      assertEquals(ast.expr.op, "UNION");
    }
  }
});

Deno.test("EdgeQL Parser - Conditional Expression", () => {
  const source = `
    SELECT User {
      name,
      status := "active" IF .active ELSE "inactive"
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const statusElement = ast.shape?.elements[1];
    if (statusElement?.expr.kind === "IfElse") {
      assertEquals(statusElement.expr.condition.kind, "Path");
    }
  }
});

Deno.test("EdgeQL Parser - Complex Filter", () => {
  const source = `
    SELECT User
    FILTER .age >= 18 AND .email LIKE "%@example.com"
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.filter?.kind === "BinaryOp") {
    assertEquals(ast.filter.op, "AND");
    if (ast.filter.left.kind === "BinaryOp") {
      assertEquals(ast.filter.left.op, ">=");
    }
    if (ast.filter.right.kind === "BinaryOp") {
      assertEquals(ast.filter.right.op, "LIKE");
    }
  }
});

Deno.test("EdgeQL Parser - Array and Set Literals", () => {
  const source = `
    SELECT {1, 2, 3}
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.expr.kind === "SetExpr") {
    assertEquals(ast.expr.elements.length, 3);
  }
});

Deno.test("EdgeQL Parser - Tuple Expression", () => {
  const source = `
    SELECT ("Alice", 25, true)
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.expr.kind === "TupleExpr") {
    assertEquals(ast.expr.elements.length, 3);
  }
});

Deno.test("EdgeQL Parser - Named Tuple", () => {
  const source = `
    SELECT (name := "Alice", age := 25)
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.expr.kind === "NamedTuple") {
    assertEquals(ast.expr.elements.length, 2);
    assertEquals(ast.expr.elements[0].name, "name");
  }
});

Deno.test("EdgeQL Parser - DISTINCT", () => {
  const source = `
    SELECT DISTINCT User.name
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.distinct, true);
  }
});

Deno.test("EdgeQL Parser - EXISTS", () => {
  const source = `
    SELECT User
    FILTER EXISTS .posts
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery" && ast.filter?.kind === "UnaryOp") {
    assertEquals(ast.filter.op, "EXISTS");
  }
});

Deno.test("EdgeQL Parser - Syntax Error", () => {
  const source = `
    SELECT User {
      name
      email  // Missing comma
    }
  `;

  assertThrows(
    () => {
      const parser = new EdgeQLParser(source);
      parser.parse();
    },
    SyntaxError,
    "Expected ',' or '}'",
  );
});

Deno.test("EdgeQL Parser - GROUP BY simple property", () => {
  const source = `GROUP User BY .active`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "GroupQuery");
  if (ast.kind === "GroupQuery") {
    assertEquals(ast.expr.kind, "TypeName");
    assertEquals(ast.using.length, 0);
    assertEquals(ast.by.elements.length, 1);
  }
});

Deno.test("EdgeQL Parser - GROUP BY multiple expressions", () => {
  const source = `GROUP User BY .active, .age`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "GroupQuery");
  if (ast.kind === "GroupQuery") {
    assertEquals(ast.by.elements.length, 2);
  }
});

Deno.test("EdgeQL Parser - GROUP with USING binding", () => {
  const source = `GROUP User USING dept := .department BY dept`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "GroupQuery");
  if (ast.kind === "GroupQuery") {
    assertEquals(ast.using.length, 1);
    assertEquals(ast.using[0].name.name, "dept");
    assertEquals(ast.using[0].value.kind, "Path");
    assertEquals(ast.by.elements.length, 1);
  }
});

Deno.test("EdgeQL Parser - GROUP BY with FILTER (HAVING)", () => {
  const source = `GROUP User BY .department FILTER count(User) > 2`;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "GroupQuery");
  if (ast.kind === "GroupQuery") {
    assertEquals(ast.expr.kind, "TypeName");
    assertEquals(ast.by.elements.length, 1);
    // Verify the filter field exists and is a BinaryOp (count(User) > 2)
    assertEquals(ast.filter?.kind, "BinaryOp");
    if (ast.filter?.kind === "BinaryOp") {
      assertEquals(ast.filter.op, ">");
      assertEquals(ast.filter.left.kind, "FunctionCall");
      if (ast.filter.left.kind === "FunctionCall") {
        assertEquals(ast.filter.left.name.parts[0], "count");
      }
      assertEquals(ast.filter.right.kind, "Literal");
      if (ast.filter.right.kind === "Literal") {
        assertEquals(ast.filter.right.value, 2);
      }
    }
  }
});

// =========================================================================
// Window Function Parsing
// =========================================================================

Deno.test("EdgeQL Parser - Window function: row_number() OVER (PARTITION BY ... ORDER BY ...)", () => {
  const source = `
    SELECT User {
      name,
      rank := row_number() OVER (PARTITION BY .department ORDER BY .salary DESC)
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    assertEquals(ast.shape?.elements.length, 2);
    const rankElement = ast.shape?.elements[1];
    assertEquals(rankElement?.name?.name, "rank");
    assertEquals(rankElement?.computable, true);
    assertEquals(rankElement?.expr.kind, "WindowFunctionCall");

    if (rankElement?.expr.kind === "WindowFunctionCall") {
      assertEquals(rankElement.expr.name.parts[0], "row_number");
      assertEquals(rankElement.expr.args.length, 0);
      assertEquals(rankElement.expr.over.kind, "WindowOverClause");
      assertEquals(rankElement.expr.over.partitionBy?.length, 1);
      assertEquals(rankElement.expr.over.orderBy?.length, 1);
      assertEquals(rankElement.expr.over.orderBy?.[0].direction, "DESC");
    }
  }
});

Deno.test("EdgeQL Parser - Aggregate as window: sum(.salary) OVER (PARTITION BY .department)", () => {
  const source = `
    SELECT User {
      name,
      dept_total := sum(.salary) OVER (PARTITION BY .department)
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const deptTotalElement = ast.shape?.elements[1];
    assertEquals(deptTotalElement?.expr.kind, "WindowFunctionCall");

    if (deptTotalElement?.expr.kind === "WindowFunctionCall") {
      assertEquals(deptTotalElement.expr.name.parts[0], "sum");
      assertEquals(deptTotalElement.expr.args.length, 1);
      assertEquals(deptTotalElement.expr.over.partitionBy?.length, 1);
      assertEquals(deptTotalElement.expr.over.orderBy, undefined);
      assertEquals(deptTotalElement.expr.over.frame, undefined);
    }
  }
});

Deno.test("EdgeQL Parser - Window function with frame spec", () => {
  const source = `
    SELECT User {
      name,
      rn := row_number() OVER (ORDER BY .id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    }
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  assertEquals(ast.kind, "SelectQuery");
  if (ast.kind === "SelectQuery") {
    const rnElement = ast.shape?.elements[1];
    assertEquals(rnElement?.expr.kind, "WindowFunctionCall");

    if (rnElement?.expr.kind === "WindowFunctionCall") {
      assertEquals(rnElement.expr.name.parts[0], "row_number");
      assertEquals(rnElement.expr.over.partitionBy, undefined);
      assertEquals(rnElement.expr.over.orderBy?.length, 1);
      assertEquals(rnElement.expr.over.frame?.kind, "WindowFrameClause");
      assertEquals(rnElement.expr.over.frame?.mode, "ROWS");
      assertEquals(
        rnElement.expr.over.frame?.start.type,
        "UNBOUNDED PRECEDING",
      );
      assertEquals(rnElement.expr.over.frame?.end?.type, "CURRENT ROW");
    }
  }
});

Deno.test("EdgeQL Analyzer - Type Checking", () => {
  const source = `
    SELECT User {
      name,
      email
    }
    FILTER .age > 18
  `;

  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const analyzer = new EdgeQLAnalyzer();
  const errors = analyzer.analyze(ast);

  // Without schema, analyzer should still run without crashing
  assertEquals(Array.isArray(errors), true);
});
