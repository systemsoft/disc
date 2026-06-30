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

import type { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";
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

/**
 * A flat single-module schema exercising Nickel's harder feature set: a
 * computed named-tuple property (so `inferComputedTupleFields` yields fields),
 * collection types (`array<str>`, named `tuple<…>`, `array<tuple<…>>`), a
 * `cal::local_datetime`, plus an enum, a single link, and a multi link. This
 * pins the emitter's computed/collection paths against the generator oracle.
 */
function createCollectionTestSchema(): Schema {
  const kindEnum: TypeDef = {
    name: "Kind",
    kind: "enum",
    tableName: "kind",
    properties: new Map(),
    links: new Map(),
    enumValues: ["alpha", "beta", "gamma"]
  };

  const personType: TypeDef = {
    name: "Person",
    kind: "object",
    tableName: "people",
    properties: new Map<string, PropertyDef>([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  const placeType: TypeDef = {
    name: "Place",
    kind: "object",
    tableName: "places",
    properties: new Map<string, PropertyDef>([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
        constraints: [{ name: "max_length", args: ["255"] }]
      }],
      ["kind", {
        name: "kind",
        type: "Kind",
        required: true,
        multi: false,
        columnName: "kind",
        edgeqlType: "Kind"
      }],
      ["visits", {
        name: "visits",
        type: "int32",
        required: false,
        multi: false,
        columnName: "visits",
        edgeqlType: "int32"
      }],
      ["tags", {
        name: "tags",
        type: "array<str>",
        required: false,
        multi: false,
        columnName: "tags",
        edgeqlType: "array<str>"
      }],
      ["point", {
        name: "point",
        type: "tuple<a: float64, b: float64>",
        required: true,
        multi: false,
        columnName: "point",
        edgeqlType: "tuple<a: float64, b: float64>"
      }],
      ["route", {
        name: "route",
        type: "array<tuple<lat: float64, lng: float64>>",
        required: false,
        multi: false,
        columnName: "route",
        edgeqlType: "array<tuple<lat: float64, lng: float64>>"
      }],
      ["openedAt", {
        name: "openedAt",
        type: "cal::local_datetime",
        required: false,
        multi: false,
        columnName: "opened_at",
        edgeqlType: "cal::local_datetime"
      }],
      ["counts", {
        name: "counts",
        type: "auto",
        required: false,
        multi: false,
        columnName: "counts",
        edgeqlType: "auto",
        computed: true,
        computedExpr: "(videos := count(.tags), total := sum(.visits), score := avg(.visits))"
      }]
    ]),
    links: new Map<string, LinkDef>([
      ["owner", {
        name: "owner",
        target: "Person",
        required: true,
        multi: false,
        columnName: "owner_id"
      }],
      ["members", {
        name: "members",
        target: "Person",
        required: false,
        multi: true,
        backlink: "places"
      }]
    ])
  };

  return {
    types: new Map<string, TypeDef>([
      ["Kind", kindEnum],
      ["Person", personType],
      ["Place", placeType]
    ]),
    functions: new Map(),
    aliases: new Map(),
    globals: new Map()
  };
}

/**
 * Regression guard: a link whose target is written module-qualified for the
 * default module (`default::Person`). The generator echoes the raw target in
 * doc comments; the emitter must too (caught a real divergence on the Nickel
 * schema where bare-name reconstruction differed from the raw target).
 */
function createQualifiedTargetSchema(): Schema {
  const idProp = {
    name: "id",
    type: "uuid",
    required: true,
    multi: false,
    columnName: "id",
    edgeqlType: "uuid",
    hasDefault: true,
  };
  const person: TypeDef = {
    name: "Person",
    kind: "object",
    tableName: "persons",
    module: "default",
    properties: new Map([["id", { ...idProp }]]),
    links: new Map(),
  };
  const pet: TypeDef = {
    name: "Pet",
    kind: "object",
    tableName: "pets",
    module: "default",
    properties: new Map([["id", { ...idProp }]]),
    links: new Map<string, LinkDef>([
      ["owner", { name: "owner", target: "default::Person", required: true, multi: false, columnName: "owner_id" }],
      ["friends", { name: "friends", target: "default::Person", required: false, multi: true, backlink: "pets" }],
    ]),
  };
  return {
    types: new Map<string, TypeDef>([["Person", person], ["Pet", pet]]),
    functions: new Map(),
    aliases: new Map(),
    globals: new Map(),
  };
}

// --- tests -----------------------------------------------------------------

Deno.test("emitTypeScript reproduces generator output byte-identical (flat schema)", () => {
  assertByteIdentical(createTestSchema(), clientConfig());
});

Deno.test("emitTypeScript reproduces generator output byte-identical (multi-module schema)", () => {
  assertByteIdentical(createMultiModuleTestSchema(), clientConfig());
});

Deno.test("emitTypeScript reproduces generator output byte-identical (computed + collection schema)", () => {
  assertByteIdentical(createCollectionTestSchema(), clientConfig());
});

Deno.test("emitTypeScript reproduces generator output byte-identical (module-qualified link target)", () => {
  assertByteIdentical(createQualifiedTargetSchema(), clientConfig());
});
