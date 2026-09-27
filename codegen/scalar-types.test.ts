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
 * - When two modules declare a scalar of the same name (`default::Money
 *   extending decimal`, `ledger::Money extending int64`), a property has the
 *   base type of the one its own module resolves the name to (its module's
 *   first, as `PropertyDef.baseType`), in every emitted type and cast.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { ObjectType, ShapeField, TypeRef } from "./ir.ts";
import { generateTypeScript } from "./mod.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `module default {
  scalar type Count extending int64;
  scalar type TicketNo extending sequence;
  scalar type SubTicketNo extending TicketNo;
  type Ticket {
    required title: std::str;
    required number: TicketNo;
    required sub: SubTicketNo;
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
  assertEquals(fields.get("sub"), { kind: "scalar", scalar: "int64" });
});

Deno.test("codegen scalars - a required sequence property is optional on insert", () => {
  assertEquals(insertField("number").optional, true);
  // A scalar extending a sequence scalar is a sequence too.
  assertEquals(insertField("sub").optional, true);
  assertEquals(insertField("title").optional, false);
});

const SHARED_SDL = `module default {
  scalar type Money extending decimal;
  scalar type Code extending sequence;
  type Account {
    balance: Money;
    multi amounts: Money;
    history: array<Money>;
    pair: tuple<mine: Money, theirs: ledger::Money>;
    other: ledger::Money;
  };
};
module ledger {
  scalar type Money extending int64;
  scalar type Code extending str;
  type Entry {
    amount: Money;
    history: array<Money>;
    pair: tuple<Money, default::Money>;
    required code: Code;
    multi accounts: default::Account {
      fee: Money;
    };
  };
};`;

function sharedSchema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SHARED_SDL, { validate: false });

  if (!parsed.ok)
    throw parsed.error;

  return mgr.modulesToSchema(parsed.value);
}

function sharedObject(name: string): ObjectType {
  return schemaToIR(sharedSchema()).modules.flatMap(module => module.objects).find(object => object.name.name === name)!;
}

const DECIMAL: TypeRef = { kind: "scalar", scalar: "decimal" };
const INT64: TypeRef = { kind: "scalar", scalar: "int64" };

Deno.test("codegen scalars - a scalar name two modules declare has its own module's base type", () => {
  const account = new Map(sharedObject("Account").fields.map(field => [field.name, field.type]));
  const entry = new Map(sharedObject("Entry").fields.map(field => [field.name, field.type]));

  assertEquals(account.get("balance"), DECIMAL);
  assertEquals(account.get("amounts"), DECIMAL);
  assertEquals(account.get("history"), { element: DECIMAL, kind: "array" });
  assertEquals(account.get("pair"), { elements: [{ name: "mine", type: DECIMAL }, { name: "theirs", type: INT64 }], kind: "named_tuple" });
  assertEquals(account.get("other"), INT64);
  assertEquals(entry.get("amount"), INT64);
  assertEquals(entry.get("history"), { element: INT64, kind: "array" });
  assertEquals(entry.get("pair"), { elements: [INT64, DECIMAL], kind: "tuple" });
  assertEquals(entry.get("code"), { kind: "scalar", scalar: "str" });
});

Deno.test("codegen scalars - link properties and shapes use the property's own module's scalar", () => {
  const entry = sharedObject("Entry");
  const accounts = entry.fields.find(field => field.name === "accounts")!;

  assertEquals(accounts.linkProperties?.map(p => p.type), [INT64]);
  assertEquals(entry.shapes.insert.fields.find(field => field.name === "amount")?.type, INT64);
  assertEquals(entry.shapes.update.fields.find(field => field.name === "amount")?.type, INT64);
  assertEquals(entry.shapes.filter.fields.find(field => field.name === "amount")?.operand, INT64);
  assertEquals(entry.shapes.filterVars.fields.find(field => field.name === "amount")?.type, INT64);
  // `ledger::Code` extends str: only `default::Code` is a sequence.
  assertEquals(entry.shapes.insert.fields.find(field => field.name === "code")?.optional, false);
});

Deno.test("codegen scalars - the TypeScript client types and casts a shared scalar name by its own module", () => {
  const files = generateTypeScript(sharedSchema(), { outputDir: "client" }).files;
  const interfaces = files.find(file => file.type === "interfaces")!.content;
  const queries = files.find(file => file.type === "queries")!.content;

  assertStringIncludes(interfaces, "balance?: string | null;");
  assertStringIncludes(interfaces, "amounts?: string[] | null;");
  assertStringIncludes(interfaces, "pair?: { mine: string; theirs: bigint } | null;");
  assertStringIncludes(interfaces, "other?: bigint | null;");
  assertStringIncludes(interfaces, "amount?: bigint | null;");
  assertStringIncludes(interfaces, "pair?: [bigint, string] | null;");
  assertStringIncludes(interfaces, "\"@fee\"?: bigint | null;");
  assertStringIncludes(interfaces, "amount?: bigint | OrdOp<bigint>;");
  assertStringIncludes(queries, "amount: \"<int64>\"");
  assertStringIncludes(queries, "balance: \"<decimal>\"");
  assertStringIncludes(queries, "amounts: \"<array<decimal>>\"");
  assertStringIncludes(queries, "pair: \"<tuple<mine: decimal, theirs: int64>>\"");
  assertStringIncludes(queries, "pair: \"<tuple<int64, decimal>>\"");
  // `reviveTyped` reads a link property by its built-in type, not the scalar's name.
  assertStringIncludes(queries, "linkProperties: { accounts: { fee: \"<int64>\" } }");
});
