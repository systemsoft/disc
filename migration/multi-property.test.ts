/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * DDL for `multi` scalar properties. A multi property is a set of values,
 * stored as a PostgreSQL array column (`multi scopes: str` → `TEXT[]`), empty
 * (`'{}'`) rather than NULL when unset. Constraints apply to every element,
 * and `required multi` means "at least one element".
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { normalizeModules, SDLConverter, type Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import type * as Types from "./types.ts";

function prop(name: string, type: string, overrides: Partial<Types.PropertyDefinition> = {}): Types.PropertyDefinition {
  return { annotations: {}, constraints: [], multi: true, name, required: false, type, ...overrides };
}

function createTypeDDL(properties: Types.PropertyDefinition[]): string[] {
  const operation: Types.CreateTypeOperation = { kind: "CreateType", links: [], properties, typeName: "Token" };
  return new DDLGenerator().generateDDL([operation]);
}

function modules(sdl: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(sdl).parse()));
}

function checks(ddl: string[]): string[] {
  return ddl.filter(s => s.includes("CHECK"));
}

Deno.test("multi str property is a TEXT[] column, NOT NULL, empty by default", () => {
  const ddl = createTypeDDL([prop("scopes", "str")]);
  const createTable = ddl.find(s => s.startsWith("CREATE TABLE"))!;

  assertStringIncludes(createTable, "scopes TEXT[] NOT NULL DEFAULT '{}'");
});

Deno.test("multi int64 property is a BIGINT[] column", () => {
  const createTable = createTypeDDL([prop("ports", "int64")]).find(s => s.startsWith("CREATE TABLE"))!;

  assertStringIncludes(createTable, "ports BIGINT[] NOT NULL DEFAULT '{}'");
});

Deno.test("one_of on a multi property checks every element with <@", () => {
  const ddl = createTypeDDL([prop("scopes", "str", { constraints: ["one_of(read,write)"] })]);

  assertEquals(checks(ddl), [
    "ALTER TABLE token ADD CONSTRAINT chk_token_scopes_one_of_read_write_ CHECK (scopes <@ ARRAY['read', 'write']::TEXT[]);"
  ]);
});

Deno.test("value bounds on a multi property compare against ALL elements", () => {
  const ddl = createTypeDDL([prop("ports", "int64", { constraints: ["min_value(1)", "max_ex_value(65536)"] })]);

  assertEquals(checks(ddl), [
    "ALTER TABLE token ADD CONSTRAINT chk_token_ports_min_value_1_ CHECK (1 <= ALL(ports));",
    "ALTER TABLE token ADD CONSTRAINT chk_token_ports_max_ex_value_65536_ CHECK (65536 > ALL(ports));"
  ]);
});

Deno.test("length and regexp constraints on a multi property use the element helpers", () => {
  const ddl = createTypeDDL([prop("tags", "str", { constraints: ["max_len_value(10)", "min_len_value(2)", "regexp(^[a-z]+$)"] })]);

  assertEquals(checks(ddl), [
    "ALTER TABLE token ADD CONSTRAINT chk_token_tags_max_len_value_10_ CHECK (disc_array_max_len(tags) <= 10);",
    "ALTER TABLE token ADD CONSTRAINT chk_token_tags_min_len_value_2_ CHECK (disc_array_min_len(tags) >= 2);",
    "ALTER TABLE token ADD CONSTRAINT chk_token_tags_regexp___a_z____ CHECK (disc_array_all_match(tags, '^[a-z]+$'));"
  ]);
});

Deno.test("required multi requires at least one element", () => {
  const ddl = createTypeDDL([prop("roles", "str", { required: true })]);

  assertEquals(checks(ddl), ["ALTER TABLE token ADD CONSTRAINT chk_token_roles_required CHECK (cardinality(roles) > 0);"]);
});

Deno.test("adding a multi property to an existing type adds an empty array column", () => {
  const addProperty: Types.AddPropertyOperation = {
    kind: "AddProperty",
    property: prop("scopes", "str", { constraints: ["one_of(read)"] })
  };
  const ddl = new DDLGenerator().generateDDL([{ kind: "AlterType", operations: [addProperty], typeName: "Token" } as Types.AlterTypeOperation]);

  assertEquals(ddl, [
    "ALTER TABLE token ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{}';",
    "ALTER TABLE token ADD CONSTRAINT chk_token_scopes_one_of_read_ CHECK (scopes <@ ARRAY['read']::TEXT[]);"
  ]);
});

Deno.test("single → multi converts the column in place, keeping the value as a one-element set", () => {
  const differ = new SchemaDiffer();
  const before = modules(`module default { type Token { scope: str { constraint one_of("read", "write"); }; }; };`);
  const after = modules(`module default { type Token { multi scope: str { constraint one_of("read", "write"); }; }; };`);
  const plan = differ.diff(before, after);
  const ddl = new DDLGenerator().generateDDL(plan);

  assertEquals(ddl, [
    "ALTER TABLE token DROP CONSTRAINT IF EXISTS chk_token_scope_one_of_read_write_;",
    "ALTER TABLE token ALTER COLUMN scope DROP DEFAULT;",
    "ALTER TABLE token ALTER COLUMN scope TYPE TEXT[] USING CASE WHEN scope IS NULL THEN '{}' ELSE ARRAY[scope] END;",
    "ALTER TABLE token ALTER COLUMN scope SET DEFAULT '{}';",
    "ALTER TABLE token ALTER COLUMN scope SET NOT NULL;",
    "ALTER TABLE token ADD CONSTRAINT chk_token_scope_one_of_read_write_ CHECK (scope <@ ARRAY['read', 'write']::TEXT[]);"
  ]);
});

Deno.test("multi → single is rejected with a clear error", () => {
  const differ = new SchemaDiffer();
  const before = modules(`module default { type Token { multi scope: str; }; };`);
  const after = modules(`module default { type Token { scope: str; }; };`);
  const plan = differ.diff(before, after);
  let message = "";
  try {
    new DDLGenerator().generateDDL(plan);
  } catch (error) {
    message = (error as Error).message;
  }

  assertStringIncludes(message, "multi → single");
});

Deno.test("exclusive on a multi property is rejected at validation", () => {
  const doc = new SDLParser(`module default { type Token { multi scopes: str { constraint exclusive; }; }; };`).parse();
  const result = new SchemaValidator().validate(doc);

  assert(!result.ok);
  assertStringIncludes(result.errors!.map(e => e.message).join("\n"), "exclusive");
});

Deno.test("arrow-form multi scalar (`multi tags -> str`) is the same TEXT[] column", () => {
  const plan = new SchemaDiffer().diff([], modules(`module default { type Token { multi tags -> str; }; };`));
  const createTable = new DDLGenerator().generateDDL(plan).find(s => s.startsWith("CREATE TABLE"))!;

  assertStringIncludes(createTable, "tags TEXT[] NOT NULL DEFAULT '{}'");
});
