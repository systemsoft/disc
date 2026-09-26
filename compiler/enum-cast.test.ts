/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Casts to enum types compile to the enum's PostgreSQL type.
 *
 * - `<array<Enum>>$x` is what the generated client emits for a `multi` enum
 *   property. It used to reach PostgreSQL verbatim (`CAST($1 AS
 *   array<Priority>)`, a syntax error).
 * - `default::Status` and `agents::Status` used to share `disc_enum_status`.
 *   An enum outside the default module whose name another enum shares now has
 *   its own module-qualified type; every other enum keeps `disc_enum_<name>`.
 *
 * Real-PG coverage lives in `server/enum-array-params-pg.test.ts`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  scalar type Priority extending enum<Low, High>;
  scalar type Status extending enum<Open, Closed>;
  type Task {
    required title: str;
    status: Status;
    multi tags: Priority;
  }
}

module agents {
  scalar type Mood extending enum<Calm, Busy>;
  scalar type Status extending enum<Idle, Working>;
  type Agent {
    required name: str;
    mood: Mood;
    status: Status;
    multi states: Status;
  }
}
`;

function schema(sdl = SDL): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(sdl, { validate: false });

  if (!parsed.ok)
    throw parsed.error;

  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string, sdl = SDL): string {
  const result = new EdgeQLCompiler(schema(sdl)).compile(new EdgeQLParser(edgeql).parse());

  if (!result.ok)
    throw result.error;

  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("enum cast - <array<Enum>> casts to the enum array type", () => {
  assertStringIncludes(compile("select <array<Priority>>$p"), "CAST($1 AS disc_enum_priority[])");
  assertStringIncludes(compile("select <array<default::Priority>>$p"), "CAST($1 AS disc_enum_priority[])");
});

Deno.test("enum cast - a multi enum property is assigned from array_unpack(<array<Enum>>$x)", () => {
  assertStringIncludes(
    compile("insert Task { title := <str>$title, tags := array_unpack(<array<Priority>>$tags) }"),
    "CAST($2 AS disc_enum_priority[])"
  );
  assertStringIncludes(
    compile("update Task filter .id = <uuid>$id set { tags := array_unpack(<array<Priority>>$tags) }"),
    "tags = CAST($2 AS disc_enum_priority[])"
  );
});

Deno.test("enum cast - filter by an enum array parameter", () => {
  assertStringIncludes(
    compile("select Task { title } filter .status in array_unpack(<array<Status>>$s)"),
    "CAST($1 AS disc_enum_status[])"
  );
});

Deno.test("enum cast - same-named enums: the non-default one gets a module-qualified type", () => {
  assertStringIncludes(compile("select <Status>$s"), "CAST($1 AS disc_enum_status)");
  assertStringIncludes(compile("select <default::Status>$s"), "CAST($1 AS disc_enum_status)");
  assertStringIncludes(compile("select <agents::Status>$s"), "CAST($1 AS disc_enum_agents__status)");
  assertStringIncludes(compile("select <array<agents::Status>>$s"), "CAST($1 AS disc_enum_agents__status[])");
  assertStringIncludes(compile("select agents::Status"), "enum_range(NULL::disc_enum_agents__status)");
  assertStringIncludes(compile("select Status"), "enum_range(NULL::disc_enum_status)");
});

Deno.test("enum cast - `with module` resolves a bare enum name in that module first", () => {
  assertStringIncludes(compile("with module agents select <Status>$s"), "CAST($1 AS disc_enum_agents__status)");
});

Deno.test("enum cast - a property's bare enum type resolves in its own module", () => {
  const agent = schema().types.get("agents::Agent")!;
  assertEquals(agent.properties.get("status")!.edgeqlType, "agents::Status");
  assertEquals(agent.properties.get("states")!.edgeqlType, "agents::Status");
  assertEquals(agent.properties.get("mood")!.edgeqlType, "Mood");
  assertEquals(schema().types.get("Task")!.properties.get("status")!.edgeqlType, "Status");
  assertEquals(schema().types.get("Status")!.module, "default");

  assertStringIncludes(
    compile("insert agents::Agent { name := <str>$n, states := {\"Idle\"} }"),
    "CAST(ARRAY['Idle'] AS disc_enum_agents__status[])"
  );
  assertStringIncludes(
    compile("insert agents::Agent { name := <str>$n, states := array_unpack(<array<agents::Status>>$s) }"),
    "CAST($2 AS disc_enum_agents__status[])"
  );
});

Deno.test("enum cast - an enum whose name no other enum shares keeps disc_enum_<name>", () => {
  assertStringIncludes(compile("select <agents::Mood>$m"), "CAST($1 AS disc_enum_mood)");
  assertStringIncludes(compile("select <array<Mood>>$m"), "CAST($1 AS disc_enum_mood[])");
});
