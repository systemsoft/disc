/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Compiles gate for the IR-driven Go emitter.
 *
 * The proof that the language-neutral IR generalizes to a third language: build
 * the IR from a fixture schema, run `emitGo`, write the result into a temp dir
 * as a Go module, and `go build ./...`. A clean exit (0) means the generated Go
 * — structs, enums, insert/update shapes, query builders, and the stdlib-only
 * HTTP runtime — type-checks against the Go standard library with no further
 * dependencies. The output is a LIBRARY package (no `func main`), so the build
 * compiles without invoking the external linker. Warnings are tolerated; errors
 * are not.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertStringIncludes } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { createMultiModuleTestSchema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitGo } from "./emit-go.ts";
import { loadMultiFileSchema } from "./mod.ts";
import { schemaToIR } from "./schema-to-ir.ts";

import type { Schema } from "../compiler/context.ts";

// --- helpers ---------------------------------------------------------------

function goConfig(): CodegenConfig {
  return {
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    interfaceSuffix: "",
    outputDir: ".",
    schemaSource: "./dbschema/default.disc",
    target: "client",
    typePrefix: ""
  };
}

/** Emit the package into a fresh temp dir and `go build ./...` it (library — no linker). */
async function assertCompiles(schema: Schema, config: CodegenConfig = goConfig()): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "disc_go_" });
  try {
    const files = emitGo(schemaToIR(schema), config);

    for (const file of files) {
      const full = `${dir}/${file.path}`;
      const slash = full.lastIndexOf("/");
      await Deno.mkdir(full.slice(0, slash), { recursive: true });
      await Deno.writeTextFile(full, file.content);
    }

    const cmd = new Deno.Command("go", {
      args: ["build", "./..."],
      cwd: dir,
      stderr: "piped",
      stdout: "piped"
    });
    const out = await cmd.output();

    if (!out.success) {
      const stderr = new TextDecoder().decode(out.stderr);
      throw new Error(`go build failed:\n${stderr}`);
    }

    assert(out.code === 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Whether a `go build` toolchain is available (skip the gate gracefully if not). */
async function goAvailable(): Promise<boolean> {
  try {
    const out = await new Deno.Command("go", { args: ["version"], stdout: "null", stderr: "null" }).output();
    return out.success;
  } catch {
    return false;
  }
}

/** Schema with every exact numeric kind, bare, optional and in arrays. */
function preciseSchema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(`module default {
  type PreciseItem {
    required label: str;
    required big: bigint;
    bigs: array<bigint>;
    dec: decimal;
    i64: int64;
  };
};`);
  if (!parsed.ok)
    throw parsed.error;
  return manager.modulesToSchema(parsed.value);
}

/** Two modules declaring a scalar of the same name, each used bare in its own module and qualified from the other. */
function sharedScalarSchema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(
    `module default {
  scalar type Money extending decimal;
  type Account {
    balance: Money;
    history: array<Money>;
    other: ledger::Money;
  };
};
module ledger {
  scalar type Money extending int64;
  type Entry {
    amount: Money;
    history: array<Money>;
    pair: tuple<Money, default::Money>;
    multi accounts: default::Account {
      fee: Money;
    };
  };
};`,
    { validate: false }
  );
  if (!parsed.ok)
    throw parsed.error;
  return manager.modulesToSchema(parsed.value);
}

// --- tests -----------------------------------------------------------------

Deno.test("emitGo: multi-module fixture compiles", async () => {
  // No go toolchain on this machine: the compile gate can't run — skip rather than fail.
  if (!(await goAvailable()))
    return;
  await assertCompiles(createMultiModuleTestSchema());
});

Deno.test("emitGo: Nickel schema compiles (when present)", async () => {
  if (!(await goAvailable()))
    return;

  const nickelDir = "/Users/netopwibby/Projects/Nickel/api/dbschema";
  const files = ["default.disc", "api.disc", "logger.disc"].map(f => `${nickelDir}/${f}`);

  // Harder fixture is opt-in: only run it when the local Nickel checkout exists.
  let present = true;
  for (const f of files) {
    try {
      await Deno.stat(f);
    } catch {
      present = false;
      break;
    }
  }
  if (!present)
    return;

  const schema = await loadMultiFileSchema(files);
  await assertCompiles(schema);
});

Deno.test("emitGo: produces a Go module skeleton", () => {
  const files = emitGo(schemaToIR(createMultiModuleTestSchema()), goConfig());
  const paths = files.map(f => f.path);
  assert(paths.some(p => p.endsWith("go.mod")), "emits go.mod");
  assert(paths.some(p => p.endsWith("models.go")), "emits models.go");
  assert(paths.some(p => p.endsWith("client.go")), "emits client.go");
  assert(paths.some(p => p.endsWith("queries.go")), "emits queries.go");
});

Deno.test("emitGo: insert/update bind params in deterministic sorted order", () => {
  // The server binds params positionally and Go marshals the variables map with
  // sorted keys, so the assignment order must be sorted too. A non-deterministic
  // `range obj` here silently corrupts inserts (a value lands in the wrong slot).
  const queries = emitGo(schemaToIR(createMultiModuleTestSchema()), goConfig())
    .find(f => f.path.endsWith("queries.go"))!
    .content;
  assert(queries.includes("sort.Strings(keys)"), "sorts the assignment keys");
  assert(queries.includes("for _, key := range keys {"), "builds assignments from sorted keys");
  // The buggy form built assignments straight from non-deterministic map iteration.
  assert(!queries.includes("key, val := range obj"), "no order-dependent map iteration");
});

Deno.test("emitGo: includeQueryBuilders=false drops the query builders (keeps data types)", async () => {
  const config: CodegenConfig = { ...goConfig(), includeQueryBuilders: false };
  const files = emitGo(schemaToIR(createMultiModuleTestSchema()), config);
  const paths = files.map(f => f.path);
  const models = files.find(f => f.path.endsWith("models.go"))!.content;

  assert(!paths.some(p => p.endsWith("queries.go")), "no queries file");
  assert(!models.includes("QueryBuilder"), "no query builder structs/methods");
  // Data types are still emitted regardless of --no-queries.
  assert(models.includes("type Merchant struct {"), "keeps the base struct");
  assert(models.includes("type MerchantInsert struct {"), "keeps the insert shape");

  // And the trimmed package still compiles.
  if (await goAvailable())
    await assertCompiles(createMultiModuleTestSchema(), config);
});

Deno.test("emitGo: includeClient=false yields a types-only package (no runtime, no builders)", async () => {
  const config: CodegenConfig = { ...goConfig(), includeClient: false };
  const files = emitGo(schemaToIR(createMultiModuleTestSchema()), config);
  const paths = files.map(f => f.path);
  const models = files.find(f => f.path.endsWith("models.go"))!.content;

  assert(!paths.some(p => p.endsWith("client.go")), "no runtime file");
  assert(!paths.some(p => p.endsWith("queries.go")), "builders need the client, so none emitted");
  assert(!models.includes("DiscClient"), "no client references in the types-only package");
  // Pure data types remain and must compile on their own.
  assert(models.includes("type Merchant struct {"), "keeps the base struct");
  if (await goAvailable())
    await assertCompiles(createMultiModuleTestSchema(), config);
});

Deno.test("emitGo: includeMutations=false drops write methods, keeps reads", async () => {
  const config: CodegenConfig = { ...goConfig(), includeMutations: false };
  const files = emitGo(schemaToIR(createMultiModuleTestSchema()), config);
  const queries = files.find(f => f.path.endsWith("queries.go"))!.content;

  assert(queries.includes(") Select("), "keeps read methods");
  assert(queries.includes(") Count("), "keeps count");
  assert(!queries.includes(") Insert("), "drops insert method");
  assert(!queries.includes(") Update("), "drops update method");
  assert(!queries.includes(") Delete("), "drops delete method");

  if (await goAvailable())
    await assertCompiles(createMultiModuleTestSchema(), config);
});

Deno.test("emitGo: bigint and decimal are json.Number, int64 is int64", async () => {
  // The server sends these as exact JSON numbers; a Go string cannot decode a
  // JSON number, and json.Number keeps every digit both ways.
  const models = emitGo(schemaToIR(preciseSchema()), goConfig())
    .find(f => f.path.endsWith("models.go"))!
    .content;
  assertStringIncludes(models, "\tBig json.Number `json:\"big\"`");
  assertStringIncludes(models, "\tBigs *[]json.Number `json:\"bigs,omitempty\"`");
  assertStringIncludes(models, "\tDec *json.Number `json:\"dec,omitempty\"`");
  assertStringIncludes(models, "\tI64 *int64 `json:\"i64,omitempty\"`");

  if (await goAvailable())
    await assertCompiles(preciseSchema());
});

/** Schema with float fields, bare, optional, multi and in arrays. */
function floatSchema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(`module default {
  type Reading {
    required label: str;
    required f64: float64;
    f32: float32;
    f64s: array<float64>;
    multi f32s: float32;
  };
};`);
  if (!parsed.ok)
    throw parsed.error;
  return manager.modulesToSchema(parsed.value);
}

Deno.test("emitGo: float fields keep their types and read and write NaN and ±Infinity as strings", async () => {
  // JSON has no number for them; the server sends and reads "NaN",
  // "Infinity" and "-Infinity", which encoding/json can't put in a float64.
  const models = emitGo(schemaToIR(floatSchema()), goConfig())
    .find(f => f.path.endsWith("models.go"))!
    .content;
  assertStringIncludes(models, "\tF64 float64 `json:\"f64\"`");
  assertStringIncludes(models, "\tF32 *float32 `json:\"f32,omitempty\"`");
  assertStringIncludes(models, "\tF64s *[]float64 `json:\"f64s,omitempty\"`");
  assertStringIncludes(models, "\tF32s []float32 `json:\"f32s,omitempty\"`");
  assertStringIncludes(models, "func (v *Reading) UnmarshalJSON(data []byte) error {");
  assertStringIncludes(models, "func (v Reading) MarshalJSON() ([]byte, error) {");
  assertStringIncludes(models, "func (v ReadingInsert) MarshalJSON() ([]byte, error) {");
  assertStringIncludes(models, "\t}{alias: (*alias)(v), F64: (*discFloat64)(&v.F64)}\n");
  assertStringIncludes(models, "\tv.F64s = convertOptionalFloats[float64](aux.F64s)\n");
  assertStringIncludes(models, "type discFloat64 float64");
  assert(!emitGo(schemaToIR(preciseSchema()), goConfig()).some(f => f.content.includes("discFloat")), "no float fields, no float JSON");

  if (await goAvailable())
    await assertCompiles(floatSchema());
});

/**
 * Schema with multi properties of float arrays. Disc's schema validator rejects
 * a stored one (a PG array column can't hold arrays), so this parses without
 * validation, as a programmatic `emitGo(schemaToIR(…))` of such a schema would.
 */
function floatGridSchema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(
    `module default {
  type Grid {
    required label: str;
    multi rows: array<float64>;
    multi cells: array<float32>;
  };
};`,
    { validate: false }
  );
  if (!parsed.ok)
    throw parsed.error;
  return manager.modulesToSchema(parsed.value);
}

Deno.test("emitGo: slices of float slices read and write NaN and ±Infinity as strings too", async () => {
  const models = emitGo(schemaToIR(floatGridSchema()), goConfig())
    .find(f => f.path.endsWith("models.go"))!
    .content;
  assertStringIncludes(models, "\tRows [][]float64 `json:\"rows,omitempty\"`");
  assertStringIncludes(models, "\t\tRows [][]discFloat64 `json:\"rows,omitempty\"`\n");
  assertStringIncludes(models, "\tv.Rows = convertFloatSlices[float64](aux.Rows)\n");
  assertStringIncludes(models, "\tv.Cells = convertFloatSlices[float32](aux.Cells)\n");
  assertStringIncludes(models, "Rows: convertFloatSlices[discFloat64](v.Rows)");
  assertStringIncludes(models, "func (v GridInsert) MarshalJSON() ([]byte, error) {");
  assertStringIncludes(models, "func convertFloatSlices[To, From ~float32 | ~float64](slices [][]From) [][]To {");

  if (await goAvailable())
    await assertCompiles(floatGridSchema());
});

Deno.test("emitGo: a scalar name two modules declare is typed by the property's own module", async () => {
  const files = emitGo(schemaToIR(sharedScalarSchema()), goConfig());
  const all = files.map(f => f.content).join("\n");
  assertStringIncludes(all, "\tBalance *json.Number `json:\"balance,omitempty\"`");
  assertStringIncludes(all, "\tOther *int64 `json:\"other,omitempty\"`");
  assertStringIncludes(all, "\tAmount *int64 `json:\"amount,omitempty\"`");
  assertStringIncludes(all, "\tHistory *[]int64 `json:\"history,omitempty\"`");
  assertStringIncludes(all, "\tHistory *[]json.Number `json:\"history,omitempty\"`");
  assertStringIncludes(all, "return \"<int64>\"");
  assertStringIncludes(all, "return \"<array<decimal>>\"");

  if (await goAvailable())
    await assertCompiles(sharedScalarSchema());
});
