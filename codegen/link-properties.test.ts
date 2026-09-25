/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Codegen for link properties. The IR carries a link's link properties on its
 * field (`Field.linkProperties`), and the TypeScript emitter types each linked
 * object with them as optional `"@name"` keys — present when a query selects
 * `{ @name }`. The typed client's insert/update API does not take link
 * properties; writing them is raw EdgeQL (`(select T …) { @role := … }`).
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import type { Schema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `
module default {
  type User {
    required name: str;
  }
  type Program {
    required name: str;
    multi members: User {
      role: str;
      required weight: int64;
    };
    multi viewers: User;
  }
}
`;

function schema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function config(): CodegenConfig {
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
  } as CodegenConfig;
}

function programFields() {
  const program = schemaToIR(schema()).modules[0].objects.find(o => o.name.name === "Program");
  assert(program);
  return program.fields;
}

Deno.test("codegen link properties - the IR carries them on the link field", () => {
  const members = programFields().find(f => f.name === "members")!;

  assertEquals(members.linkProperties?.map(p => [p.name, p.type, p.cardinality]), [
    ["role", { kind: "scalar", scalar: "str" }, "AtMostOne"],
    ["weight", { kind: "scalar", scalar: "int64" }, "One"]
  ]);
});

Deno.test("codegen link properties - a link without link properties has none in the IR", () => {
  assertEquals(programFields().find(f => f.name === "viewers")!.linkProperties, undefined);
});

Deno.test("codegen link properties - the TS type adds optional `@name` keys to the linked object", () => {
  const files = emitTypeScript(schemaToIR(schema()), config());
  const types = (files.find(f => f.path.endsWith("types.ts")) ?? files.find(f => f.path.endsWith("interfaces.ts")))!.content;

  assertStringIncludes(types, `members?: (User & { "@role"?: string | null; "@weight"?: bigint; })[] | null;`);
  assertStringIncludes(types, "viewers?: User[] | null;");
});
