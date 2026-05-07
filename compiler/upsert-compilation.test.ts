/**
 * Tests for ON CONFLICT DO UPDATE (UPSERT) compilation
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
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
  if (!result.ok) throw result.error;
  return codegen.generate(result.value);
}

Deno.test("UPSERT - simple upsert with single SET column", () => {
  const source = `
    INSERT User {
      name := "Ada",
      email := "ada@test.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (UPDATE User SET { name := "Ada Updated" })
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("INSERT INTO"),
    true,
    "SQL should contain INSERT INTO",
  );
  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT",
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET",
  );
  assertEquals(
    sql.includes("name ="),
    true,
    "SQL should reference the name column in SET clause",
  );
  assertEquals(
    sql.includes("'Ada Updated'"),
    true,
    "SQL should contain the updated value",
  );
  // Should NOT contain DO NOTHING
  assertEquals(
    sql.includes("DO NOTHING"),
    false,
    "SQL should NOT contain DO NOTHING for upsert",
  );
});

Deno.test("UPSERT - multi-column SET", () => {
  const source = `
    INSERT User {
      name := "Billie",
      email := "billie@test.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (UPDATE User SET { name := "Billie Updated", active := true })
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT",
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET",
  );
  // Both SET columns should appear in the SQL
  assertEquals(
    sql.includes("'Billie Updated'"),
    true,
    "SQL should contain the updated name value",
  );
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference the active column",
  );
  // Verify both SET clauses are comma-separated
  const setMatch = sql.match(/DO UPDATE SET (.+)/);
  assertEquals(setMatch !== null, true, "Should match DO UPDATE SET clause");
  if (setMatch) {
    assertEquals(
      setMatch[1].includes(","),
      true,
      "Multiple SET clauses should be comma-separated",
    );
  }
});

Deno.test("UPSERT - with Post type conflict on title", () => {
  const source = `
    INSERT Post {
      title := "Test",
      body := "Content",
      author := <uuid>"550e8400-e29b-41d4-a716-446655440000"
    }
    UNLESS CONFLICT ON .title
    ELSE (UPDATE Post SET { body := "Updated Content" })
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT",
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET",
  );
  assertEquals(
    sql.includes("body"),
    true,
    "SQL should reference the body column",
  );
  assertEquals(
    sql.includes("'Updated Content'"),
    true,
    "SQL should contain the updated body value",
  );
});

Deno.test("UPSERT - DO NOTHING still works (regression)", () => {
  const source = `
    INSERT User {
      name := "Test",
      email := "test@test.com"
    }
    UNLESS CONFLICT ON .email
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("INSERT INTO"),
    true,
    "SQL should contain INSERT INTO",
  );
  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT",
  );
  assertEquals(
    sql.includes("DO NOTHING"),
    true,
    "SQL should contain DO NOTHING",
  );
  assertEquals(
    sql.includes("DO UPDATE"),
    false,
    "SQL should NOT contain DO UPDATE for DO NOTHING case",
  );
});

Deno.test("UPSERT - conflict target column is included", () => {
  const source = `
    INSERT User {
      name := "Cher",
      email := "cher@test.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (UPDATE User SET { name := "Cher Updated" })
  `;
  const sql = compileEdgeQL(source);

  // The ON CONFLICT target should reference the email column
  assertEquals(
    sql.includes("ON CONFLICT (email)"),
    true,
    "SQL should contain ON CONFLICT with email column target",
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET",
  );
});
