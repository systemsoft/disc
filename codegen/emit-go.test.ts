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

import { assert } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { createMultiModuleTestSchema } from "../compiler/context.ts";
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
    .find(f => f.path.endsWith("queries.go"))!.content;
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
