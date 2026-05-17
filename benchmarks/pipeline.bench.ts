/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Full Pipeline Benchmarks
 *
 * Benchmarks the complete parse -> compile -> codegen pipeline.
 */

/*** UTILITY ------------------------------------------ ***/

import { createTestSchema } from "../compiler/context.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";

const schema = createTestSchema();

const queries: Record<string, string> = {
  "simple select": "SELECT User { name }",
  "filtered select": "SELECT User { name } FILTER .name = 'Ada'",
  "nested shape": "SELECT User { name, posts: { title } }",
  insert: "INSERT User { name := 'Ada', email := 'ada@example.com' }",
  update: "UPDATE User FILTER .name = 'Ada' SET { name := 'Billie' }",
  delete: "DELETE User FILTER .name = 'Ada'",
  complex: "SELECT User { name, email, posts: { title, body } } FILTER .name = 'Ada' ORDER BY .name LIMIT 10"
};

/*** RUNTIME ------------------------------------------ ***/

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
