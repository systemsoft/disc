/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Compiles gate for the IR-driven Rust emitter.
 *
 * The proof that the language-neutral IR generalizes beyond TypeScript: build
 * the IR from a fixture schema, run `emitRust`, write the result into a temp dir
 * as a Cargo crate, and `cargo build --offline`. A clean exit (0) means the
 * generated Rust — structs, enums, insert/update shapes, query builders, and the
 * std-only HTTP runtime — type-checks against serde + serde_json with no further
 * dependencies. Warnings are tolerated; errors are not.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { createMultiModuleTestSchema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitRust } from "./emit-rust.ts";
import { loadMultiFileSchema } from "./mod.ts";
import { schemaToIR } from "./schema-to-ir.ts";

import type { Schema } from "../compiler/context.ts";

// --- helpers ---------------------------------------------------------------

function rustConfig(): CodegenConfig {
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

/** Emit the crate into a fresh temp dir and `cargo build --offline` it. */
async function assertCompiles(schema: Schema, config: CodegenConfig = rustConfig()): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "disc_rust_" });
  try {
    const files = emitRust(schemaToIR(schema), config);

    for (const file of files) {
      const full = `${dir}/${file.path}`;
      const slash = full.lastIndexOf("/");
      await Deno.mkdir(full.slice(0, slash), { recursive: true });
      await Deno.writeTextFile(full, file.content);
    }

    const cmd = new Deno.Command("cargo", {
      args: ["build", "--offline"],
      cwd: dir,
      stderr: "piped",
      stdout: "piped"
    });
    const out = await cmd.output();

    if (!out.success) {
      const stderr = new TextDecoder().decode(out.stderr);
      throw new Error(`cargo build failed:\n${stderr}`);
    }

    assertEquals(out.code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Whether a `cargo` binary is available (skip the gate gracefully if not). */
async function cargoAvailable(): Promise<boolean> {
  try {
    const out = await new Deno.Command("cargo", { args: ["--version"], stdout: "null", stderr: "null" }).output();
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

// --- tests -----------------------------------------------------------------

Deno.test("emitRust: multi-module fixture compiles offline", async () => {
  // No cargo on this machine: the compile gate can't run — skip rather than fail.
  if (!(await cargoAvailable()))
    return;
  await assertCompiles(createMultiModuleTestSchema());
});

Deno.test("emitRust: Nickel schema compiles offline (when present)", async () => {
  if (!(await cargoAvailable()))
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

Deno.test("emitRust: produces a Cargo crate skeleton", () => {
  const files = emitRust(schemaToIR(createMultiModuleTestSchema()), rustConfig());
  const paths = files.map(f => f.path);
  assert(paths.some(p => p.endsWith("Cargo.toml")), "emits Cargo.toml");
  assert(paths.some(p => p.endsWith("src/lib.rs")), "emits src/lib.rs");
  assert(paths.some(p => p.endsWith("src/disc_runtime.rs")), "emits src/disc_runtime.rs");
});

Deno.test("emitRust: includeQueryBuilders=false drops the query builders (keeps data types)", async () => {
  const config: CodegenConfig = { ...rustConfig(), includeQueryBuilders: false };
  const files = emitRust(schemaToIR(createMultiModuleTestSchema()), config);
  const lib = files.find(f => f.path.endsWith("src/lib.rs"))!.content;

  assert(!lib.includes("QueryBuilder"), "no query builder structs/impls");
  // Data types are still emitted regardless of --no-queries.
  assert(lib.includes("pub struct Merchant {"), "keeps the base struct");
  assert(lib.includes("pub struct MerchantInsert {"), "keeps the insert shape");

  // And the trimmed crate still compiles.
  if (await cargoAvailable())
    await assertCompiles(createMultiModuleTestSchema(), config);
});

Deno.test("emitRust: includeClient=false yields a types-only crate (no runtime, no builders)", async () => {
  const config: CodegenConfig = { ...rustConfig(), includeClient: false };
  const files = emitRust(schemaToIR(createMultiModuleTestSchema()), config);
  const paths = files.map(f => f.path);
  const lib = files.find(f => f.path.endsWith("src/lib.rs"))!.content;

  assert(!paths.some(p => p.endsWith("disc_runtime.rs")), "no runtime file");
  assert(!lib.includes("pub mod disc_runtime"), "no runtime module declaration");
  assert(!lib.includes("QueryBuilder"), "builders need the client, so none emitted");
  // Pure data types remain and must compile on their own.
  assert(lib.includes("pub struct Merchant {"), "keeps the base struct");
  if (await cargoAvailable())
    await assertCompiles(createMultiModuleTestSchema(), config);
});

Deno.test("emitRust: includeMutations=false drops write methods, keeps reads", async () => {
  const config: CodegenConfig = { ...rustConfig(), includeMutations: false };
  const files = emitRust(schemaToIR(createMultiModuleTestSchema()), config);
  const lib = files.find(f => f.path.endsWith("src/lib.rs"))!.content;

  assert(lib.includes("pub fn select("), "keeps read methods");
  assert(lib.includes("pub fn count("), "keeps count");
  assert(!lib.includes("pub fn insert("), "drops insert method");
  assert(!lib.includes("pub fn update("), "drops update method");
  assert(!lib.includes("pub fn delete("), "drops delete method");

  if (await cargoAvailable())
    await assertCompiles(createMultiModuleTestSchema(), config);
});

Deno.test("emitRust: bigint and decimal are ExactNumber (serde_json arbitrary_precision), int64 is i64", async () => {
  // The server sends these as exact JSON numbers. Without arbitrary_precision
  // serde_json reads a number past u64/i64 as an f64 and loses digits; with
  // it, the serde_json::Number inside ExactNumber keeps the source text both ways.
  const files = emitRust(schemaToIR(preciseSchema()), rustConfig());
  const lib = files.find(f => f.path.endsWith("src/lib.rs"))!.content;
  const cargo = files.find(f => f.path.endsWith("Cargo.toml"))!.content;

  assertStringIncludes(cargo, "serde_json = { version = \"1\", features = [\"arbitrary_precision\"] }");
  assertStringIncludes(lib, "pub big: crate::ExactNumber,");
  assertStringIncludes(lib, "pub bigs: Option<Vec<crate::ExactNumber>>,");
  assertStringIncludes(lib, "pub dec: Option<crate::ExactNumber>,");
  assertStringIncludes(lib, "pub i64: Option<i64>,");

  if (await cargoAvailable())
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

Deno.test("emitRust: float fields keep their types and read and write NaN and ±Infinity as strings", async () => {
  // JSON has no number for them; the server sends and reads "NaN",
  // "Infinity" and "-Infinity", which serde_json can't put in an f64.
  const lib = emitRust(schemaToIR(floatSchema()), rustConfig()).find(f => f.path.endsWith("src/lib.rs"))!.content;

  assertStringIncludes(lib, "    #[serde(default, deserialize_with = \"crate::disc_float::deserialize\")]\n    pub f64: f64,");
  assertStringIncludes(lib, "    #[serde(default, deserialize_with = \"crate::disc_float::deserialize\")]\n    pub f32: Option<f32>,");
  assertStringIncludes(lib, "    #[serde(default, deserialize_with = \"crate::disc_float::deserialize\")]\n    pub f64s: Option<Vec<f64>>,");
  assertStringIncludes(lib, "    #[serde(default, deserialize_with = \"crate::disc_float::deserialize\")]\n    pub f32s: Vec<f32>,");
  assertStringIncludes(
    lib,
    "    #[serde(serialize_with = \"crate::disc_float::serialize\", skip_serializing_if = \"Option::is_none\")]\n    pub f64s: Option<Vec<f64>>,"
  );
  assertStringIncludes(lib, "pub mod disc_float {");
  assert(
    !emitRust(schemaToIR(preciseSchema()), rustConfig()).some(f => f.content.includes("disc_float")),
    "no float fields, no float helpers"
  );

  if (await cargoAvailable())
    await assertCompiles(floatSchema());
});

Deno.test("emitRust: a Vec of float Vecs goes through disc_float too", async () => {
  // A multi property of float arrays; Disc's schema validator rejects a stored
  // one, so this parses without validation. disc_float's FloatField for Vec<T>
  // covers any nesting.
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL("module default { type Grid { required label: str; multi rows: array<float64>; } }", { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  const schema = manager.modulesToSchema(parsed.value);
  const lib = emitRust(schemaToIR(schema), rustConfig()).find(f => f.path.endsWith("src/lib.rs"))!.content;
  assertStringIncludes(lib, "    #[serde(default, deserialize_with = \"crate::disc_float::deserialize\")]\n    pub rows: Vec<Vec<f64>>,");
  assertStringIncludes(lib, "serialize_with = \"crate::disc_float::serialize\"");

  if (await cargoAvailable())
    await assertCompiles(schema);
});
