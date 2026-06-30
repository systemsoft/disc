/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Diff oracle for the IR-driven TypeScript emitter (RFC 0001, Phase 3).
 *
 * The existing TypeScriptGenerator is the correctness oracle. For each fixture
 * schema we generate today's output and the IR-driven output with the SAME
 * config, then assert file-by-file byte-identical content. The ONLY permitted
 * normalization is masking the single non-deterministic `Generated at:` line
 * (the ISO timestamp), applied identically to both sides.
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import type { Schema } from "../compiler/context.ts";
import { createMultiModuleTestSchema, createTestSchema } from "../compiler/context.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";
import { TypeScriptGenerator } from "./typescript-generator.ts";

// --- helpers ---------------------------------------------------------------

/** Config equivalent to the CLI `codegen` handler: query builders + client + format. */
function clientConfig(): CodegenConfig {
  return {
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    interfaceSuffix: "",
    outputDir: "./generated",
    schemaSource: "./dbschema/default.disc",
    target: "client",
    typePrefix: ""
  };
}

/** Mask the single non-deterministic timestamp line; nothing else. */
function maskTimestamp(content: string): string {
  return content.replace(/^( *\* Generated at: ).*$/m, "$1<MASKED>");
}

function assertByteIdentical(schema: Schema, config: CodegenConfig): void {
  const current = new TypeScriptGenerator(schema, config).generate();
  const fromIR = emitTypeScript(schemaToIR(schema), config);

  assertEquals(
    fromIR.length,
    current.files.length,
    `file count: IR emitted ${fromIR.length}, oracle emitted ${current.files.length}`
  );

  for (let i = 0; i < current.files.length; i++) {
    assertEquals(
      fromIR[i].path,
      current.files[i].path,
      `file[${i}] path mismatch`
    );

    assertEquals(
      maskTimestamp(fromIR[i].content),
      maskTimestamp(current.files[i].content),
      `file[${i}] (${current.files[i].path}) content mismatch`
    );
  }
}

// --- tests -----------------------------------------------------------------

Deno.test("emitTypeScript reproduces generator output byte-identical (flat schema)", () => {
  assertByteIdentical(createTestSchema(), clientConfig());
});

Deno.test("emitTypeScript reproduces generator output byte-identical (multi-module schema)", () => {
  assertByteIdentical(createMultiModuleTestSchema(), clientConfig());
});
