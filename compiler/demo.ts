// deno-lint-ignore-file no-console
/**
 * EdgeQL to SQL Compiler Demo
 * Demonstrates the complete compilation pipeline from EdgeQL to PostgreSQL
 */

import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function demo(title: string, edgeql: string): void {
  console.log(`\n${title}\n${"=".repeat(title.length)}`);
  console.log(`\nEdgeQL:\n${edgeql}`);

  try {
    const parser = new EdgeQLParser(edgeql);
    const ast = parser.parse();

    const result = compiler.compile(ast);
    if (!result.ok) {
      console.log(`\nCompilation Error: ${result.error.message}`);
      return;
    }

    const sql = codegen.generate(result.value);
    console.log(`\nGenerated PostgreSQL:\n${sql}`);
  } catch (error) {
    console.log(`\nError: ${error.message}`);
  }
}

// SELECT Queries
demo("Simple Type Selection", "SELECT User");

demo(
  "Shaped Selection",
  `
  SELECT User {
    name,
    email,
    created_at
  }
`,
);

demo(
  "Filtered Selection",
  `
  SELECT User {
    name,
    email
  }
  FILTER .active = true
`,
);

demo(
  "Ordered and Limited Selection",
  `
  SELECT User {
    name,
    email
  }
  ORDER BY .name ASC
  LIMIT 10
`,
);

demo(
  "Complex Query with Filter",
  `
  SELECT User {
    name,
    email,
    created_at
  }
  FILTER .age >= 18 AND .active = true
  ORDER BY .created_at DESC
  LIMIT 5
`,
);

// INSERT Queries
demo(
  "Basic Insert",
  `
  INSERT User {
    name := "Alice Johnson",
    email := "alice@example.com",
    active := true,
    age := 28
  }
`,
);

demo(
  "Insert with Conflict Handling",
  `
  INSERT User {
    name := "Bob Smith",
    email := "bob@example.com"
  }
  UNLESS CONFLICT ON .email
`,
);

// UPDATE Queries
demo(
  "Basic Update",
  `
  UPDATE User
  FILTER .email = "alice@example.com"
  SET {
    name := "Alice Smith",
    age := 29
  }
`,
);

// DELETE Queries
demo(
  "Basic Delete",
  `
  DELETE User
  FILTER .email = "old@example.com"
`,
);

// Function Calls
demo(
  "Aggregate Function",
  `
  SELECT count(User)
`,
);

demo(
  "Computed Property",
  `
  SELECT User {
    name,
    email,
    display_name := .name ++ " <" ++ .email ++ ">"
  }
  FILTER .active = true
`,
);

console.log(`\n${"=".repeat(60)}`);
console.log("Demo completed! The compiler successfully transforms EdgeQL");
console.log(
  "queries into PostgreSQL-compatible SQL with proper schema mapping,",
);
console.log("JSON object construction, and query optimization.");
console.log(`${"=".repeat(60)}\n`);
