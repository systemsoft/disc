/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL Compiler Benchmarks
 *
 * Benchmarks EdgeQL AST to SQL AST compilation for various query types.
 */

/*** UTILITY ------------------------------------------ ***/

import { createTestSchema } from "../compiler/context.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";

const schema = createTestSchema();

const queries: Record<string, string> = {
  "simple select": "SELECT User { name }",
  "filtered select": "SELECT User { name, email } FILTER .name = 'Ada'",
  "nested shape": "SELECT User { name, posts: { title } }",
  insert: "INSERT User { name := 'Ada', email := 'ada@example.com' }",
  update: "UPDATE User FILTER .name = 'Ada' SET { name := 'Billie' }",
  delete: "DELETE User FILTER .name = 'Ada'",
  "ordered limited": "SELECT User { name } ORDER BY .name DESC LIMIT 10"
};

/*** RUNTIME ------------------------------------------ ***/

for (const [name, query] of Object.entries(queries)) {
  const parser = new EdgeQLParser(query);
  const ast = parser.parse();

  Deno.bench(`compile: ${name}`, () => {
    const compiler = new EdgeQLCompiler(schema);
    compiler.compile(ast);
  });
}
