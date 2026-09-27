/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * User scalars in the codegen IR.
 *
 * - A property of a user scalar extending a built-in (`scalar type Count
 *   extending int64`) has that built-in's type; it used to come out as an
 *   object reference named `Count`.
 * - A property of a sequence scalar (`scalar type TicketNo extending
 *   sequence`) is an int64 the database assigns, so it is optional on insert
 *   even when required.
 * - `std::`-qualified property types read as the bare built-ins.
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { ObjectType, ShapeField } from "./ir.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `module default {
  scalar type Count extending int64;
  scalar type TicketNo extending sequence;
  type Ticket {
    required title: std::str;
    required number: TicketNo;
    count: Count;
    tags: array<Count>;
  };
};`;

function ticket(): ObjectType {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL);

  if (!parsed.ok)
    throw parsed.error;

  const ir = schemaToIR(mgr.modulesToSchema(parsed.value));
  return ir.modules.flatMap(module => module.objects).find(object => object.name.name === "Ticket")!;
}

function insertField(name: string): ShapeField {
  return ticket().shapes.insert.fields.find(field => field.name === name)!;
}

Deno.test("codegen scalars - a user scalar has the type of the built-in it extends", () => {
  const fields = new Map(ticket().fields.map(field => [field.name, field.type]));

  assertEquals(fields.get("title"), { kind: "scalar", scalar: "str" });
  assertEquals(fields.get("count"), { kind: "scalar", scalar: "int64" });
  assertEquals(fields.get("tags"), { element: { kind: "scalar", scalar: "int64" }, kind: "array" });
  assertEquals(fields.get("number"), { kind: "scalar", scalar: "int64" });
});

Deno.test("codegen scalars - a required sequence property is optional on insert", () => {
  assertEquals(insertField("number").optional, true);
  assertEquals(insertField("title").optional, false);
});
