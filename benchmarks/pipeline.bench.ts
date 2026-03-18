/**
 * Full Pipeline Benchmarks
 *
 * Benchmarks the complete parse -> compile -> codegen pipeline.
 */

import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { createTestSchema } from "../compiler/context.ts";

const schema = createTestSchema();

const queries: Record<string, string> = {
  "simple select": "SELECT User { name }",
  "filtered select": "SELECT User { name } FILTER .name = 'Alice'",
  "nested shape": "SELECT User { name, posts: { title } }",
  "insert": "INSERT User { name := 'Alice', email := 'alice@example.com' }",
  "update": "UPDATE User FILTER .name = 'Alice' SET { name := 'Bob' }",
  "delete": "DELETE User FILTER .name = 'Alice'",
  "complex":
    "SELECT User { name, email, posts: { title, body } } FILTER .name = 'Alice' ORDER BY .name LIMIT 10",
};

for (const [name, query] of Object.entries(queries)) {
  Deno.bench(`pipeline: ${name}`, () => {
    const parser = new EdgeQLParser(query);
    const ast = parser.parse();
    const compiler = new EdgeQLCompiler(schema);
    const result = compiler.compile(ast);

    if (result.ok) {
      const codegen = new SQLCodeGenerator();
      codegen.generate(result.value);
    }
  });
}
