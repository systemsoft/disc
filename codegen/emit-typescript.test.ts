/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Golden-snapshot regression oracle for the IR-driven TypeScript emitter
 *.
 *
 * For each fixture schema we generate the IR-driven output and assert each
 * emitted file's content against a committed snapshot. The snapshots ARE the
 * oracle: they captured the byte-for-byte output of the original
 * direct-from-schema generator (now retired). The ONLY normalization is masking
 * the single non-deterministic `Generated at:` line (the ISO timestamp).
 *
 * Regenerate snapshots with:
 *   deno test --allow-read --allow-write --allow-env -- --update
 */

/*** NATIVE ------------------------------------------- ***/

import { assertSnapshot } from "@std/testing/snapshot";

/*** UTILITY ------------------------------------------ ***/

import type { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";
import { createMultiModuleTestSchema, createTestSchema } from "../compiler/context.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";

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

/** Emit from the IR and snapshot each file (path + timestamp-masked content). */
async function assertEmittedSnapshot(t: Deno.TestContext, schema: Schema, config: CodegenConfig): Promise<void> {
  const files = emitTypeScript(schemaToIR(schema), config);

  for (const file of files) {
    await assertSnapshot(
      t,
      { content: maskTimestamp(file.content), path: file.path },
      { name: file.path }
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

Deno.test("emitTypeScript matches golden snapshot (flat schema)", async (t) => {
  await assertEmittedSnapshot(t, createTestSchema(), clientConfig());
});

Deno.test("emitTypeScript matches golden snapshot (multi-module schema)", async (t) => {
  await assertEmittedSnapshot(t, createMultiModuleTestSchema(), clientConfig());
});

Deno.test("emitTypeScript matches golden snapshot (computed + collection schema)", async (t) => {
  await assertEmittedSnapshot(t, createCollectionTestSchema(), clientConfig());
});

Deno.test("emitTypeScript matches golden snapshot (module-qualified link target)", async (t) => {
  await assertEmittedSnapshot(t, createQualifiedTargetSchema(), clientConfig());
});
