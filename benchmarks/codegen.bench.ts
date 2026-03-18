/**
 * SQL Code Generation Benchmarks
 *
 * Benchmarks SQL AST to text generation.
 */

import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { createTestSchema } from "../compiler/context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

const queries: Record<string, string> = {
  "simple": "SELECT User { name }",
  "complex":
    "SELECT User { name, email, posts: { title, body } } FILTER .name = 'Alice' ORDER BY .name LIMIT 10",
  "insert":
    "INSERT User { name := 'Alice', email := 'alice@example.com' }",
  "update":
    "UPDATE User FILTER .name = 'Alice' SET { name := 'Bob' }",
};

// Pre-compile to SQL ASTs
const sqlAsts: Record<string, ReturnType<SQLCodeGenerator["generate"]> extends string ? Parameters<SQLCodeGenerator["generate"]>[0] : never> = {};

for (const [name, query] of Object.entries(queries)) {
  const parser = new EdgeQLParser(query);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (result.ok) {
    sqlAsts[name] = result.value;
  } else {
    throw new Error(
      `Failed to compile query "${name}": ${result.error.message}`,
    );
  }
}

for (const [name, sqlAst] of Object.entries(sqlAsts)) {
  Deno.bench(`codegen: ${name}`, () => {
    codegen.generate(sqlAst);
  });
}
