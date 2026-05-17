/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SQL Code Generation Benchmarks
 *
 * Benchmarks SQL AST to text generation.
 */

/*** UTILITY ------------------------------------------ ***/

import { createTestSchema } from "../compiler/context.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";

const codegen = new SQLCodeGenerator();
const schema = createTestSchema();

const queries: Record<string, string> = {
  complex: "SELECT User { name, email, posts: { title, body } } FILTER .name = 'Ada' ORDER BY .name LIMIT 10",
  insert: "INSERT User { name := 'Ada', email := 'ada@example.com' }",
  simple: "SELECT User { name }",
  update: "UPDATE User FILTER .name = 'Ada' SET { name := 'Billie' }"
};

/*** Pre-compile to SQL ASTs ***/
const sqlAsts: Record<
  string,
  ReturnType<SQLCodeGenerator["generate"]> extends string ? Parameters<SQLCodeGenerator["generate"]>[0] :
    never
> = {};

/*** RUNTIME ------------------------------------------ ***/

for (const [name, query] of Object.entries(queries)) {
  const parser = new EdgeQLParser(query);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (result.ok)
    sqlAsts[name] = result.value;
  else
    throw new Error(`Failed to compile query "${name}": ${result.error.message}`);
}

for (const [name, sqlAst] of Object.entries(sqlAsts)) {
  Deno.bench(`codegen: ${name}`, () => {
    codegen.generate(sqlAst);
  });
}
