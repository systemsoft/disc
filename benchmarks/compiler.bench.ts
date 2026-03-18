/**
 * EdgeQL Compiler Benchmarks
 *
 * Benchmarks EdgeQL AST to SQL AST compilation for various query types.
 */

import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { createTestSchema } from "../compiler/context.ts";

const schema = createTestSchema();

const queries: Record<string, string> = {
  "simple select": "SELECT User { name }",
  "filtered select":
    "SELECT User { name, email } FILTER .name = 'Alice'",
  "nested shape": "SELECT User { name, posts: { title } }",
  "insert":
    "INSERT User { name := 'Alice', email := 'alice@example.com' }",
  "update":
    "UPDATE User FILTER .name = 'Alice' SET { name := 'Bob' }",
  "delete": "DELETE User FILTER .name = 'Alice'",
  "ordered limited":
    "SELECT User { name } ORDER BY .name DESC LIMIT 10",
};

for (const [name, query] of Object.entries(queries)) {
  const parser = new EdgeQLParser(query);
  const ast = parser.parse();

  Deno.bench(`compile: ${name}`, () => {
    const compiler = new EdgeQLCompiler(schema);
    compiler.compile(ast);
  });
}
