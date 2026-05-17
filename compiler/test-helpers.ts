/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Shared helpers for compiler test files.
 *
 * Use these from PG-backed `pg-*.test.ts` suites that build a schema at
 * runtime (via `SchemaManager`) and need to compile EdgeQL against it.
 *
 * For non-PG unit tests with a file-local schema constant, define a thin
 * local `compileEdgeQL(source)` that closes over your module-level
 * `compiler`/`codegen` — keeping the test file readable top-to-bottom is
 * worth more than the saved lines.
 */

import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

/**
 * Parse `edgeql`, compile against `schema` (with access control disabled,
 * matching how the integration suites build PG-test schemas), and return the
 * generated SQL string.
 *
 * Throws a plain `Error` with the compiler's message on failure — preserves
 * the existing behaviour of the eight pg-*.test.ts files this replaces. If
 * you need the original `CompilationError` type, call the compiler directly.
 */
export function compileEdgeQL(edgeql: string, schema: Schema): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}
