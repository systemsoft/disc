/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema -> IR frontend tests. Golden assertions over a
 * known schema, covering the acceptance gate: cardinalities (One/AtMostOne/
 * AtLeastOne/Many), links, enums, exclusive/default/readonly/computed flags,
 * the gnarly scalars (decimal/bigint/uuid/datetime), collections (array/tuple/
 * range), and the denormalized insert/update/filter/filterVars shapes.
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import type { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";
import { createMultiModuleTestSchema } from "../compiler/context.ts";
import type { Field, FilterField, Module, ObjectType, ShapeField } from "./ir.ts";

/*** RUNTIME ------------------------------------------ ***/

import { IR_VERSION, schemaToIR } from "./schema-to-ir.ts";

// --- helpers ---------------------------------------------------------------

function mod(modules: Module[], name: string): Module {
  const m = modules.find((x) => x.name === name);
  if (!m) throw new Error(`module ${name} not found`);
  return m;
}

function obj(m: Module, name: string): ObjectType {
  const o = m.objects.find((x) => x.name.name === name);
  if (!o) throw new Error(`object ${name} not found in module ${m.name}`);
  return o;
}

function field<T extends { name: string }>(fields: T[], name: string): T {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`field ${name} not found`);
  return f;
}

// --- multi-module fixture --------------------------------------------------

Deno.test("schemaToIR - module grouping and ordering", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  assertEquals(ir.version, IR_VERSION);
  assertEquals(ir.modules.map((m) => m.name), ["default", "api", "payment"]);
  assertEquals(ir.multiModule, true);
});

Deno.test("schemaToIR - multiModule is false when no type declares a module", () => {
  const schema: Schema = {
    types: new Map<string, TypeDef>([
      ["Thing", { name: "Thing", kind: "object", tableName: "things", properties: new Map(), links: new Map() }],
    ]),
    functions: new Map(),
  };
  assertEquals(schemaToIR(schema).multiModule, false);
});

Deno.test("schemaToIR - enums land in their module with members", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  assertEquals(mod(ir.modules, "default").enums.map((e) => e.name.name), ["MerchantStatus"]);
  assertEquals(mod(ir.modules, "default").enums[0].members, ["active", "suspended", "pending"]);
  const payment = mod(ir.modules, "payment");
  assertEquals(payment.enums[0].name, { module: "payment", name: "PaymentStatus" });
  assertEquals(payment.enums[0].members, ["pending", "completed", "failed", "refunded"]);
});

Deno.test("schemaToIR - base fields carry cardinality and flags", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const merchant = obj(mod(ir.modules, "default"), "Merchant");

  const id = field<Field>(merchant.fields, "id");
  assertEquals(id.type, { kind: "scalar", scalar: "uuid" });
  assertEquals(id.cardinality, "One");
  assertEquals(id.hasDefault, true);
  assertEquals(id.isLink, false);

  // optional single -> AtMostOne
  assertEquals(field<Field>(merchant.fields, "status").cardinality, "AtMostOne");
  // required single -> One
  assertEquals(field<Field>(merchant.fields, "name").cardinality, "One");

  // optional multi link -> Many, typed by target object, qualified
  const apiKeys = field<Field>(merchant.fields, "apiKeys");
  assertEquals(apiKeys.isLink, true);
  assertEquals(apiKeys.cardinality, "Many");
  assertEquals(apiKeys.type, { kind: "object", name: { module: "api", name: "ApiKey" } });
});

Deno.test("schemaToIR - exclusive constraint and required single link", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const apiKey = obj(mod(ir.modules, "api"), "ApiKey");

  assertEquals(field<Field>(apiKey.fields, "key").isExclusive, true);
  assertEquals(field<Field>(apiKey.fields, "active").hasDefault, true);

  // required single link -> One, points at default::Merchant
  const merchantLink = field<Field>(apiKey.fields, "merchant");
  assertEquals(merchantLink.cardinality, "One");
  assertEquals(merchantLink.type, { kind: "object", name: { module: "default", name: "Merchant" } });
});

Deno.test("schemaToIR - object carries tableName and full constraints", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const merchant = obj(mod(ir.modules, "default"), "Merchant");
  assertEquals(merchant.tableName, "merchants");
  assertEquals(merchant.parentTypes, []);

  const apiKey = obj(mod(ir.modules, "api"), "ApiKey");
  assertEquals(apiKey.tableName, "api_keys");
  assertEquals(field<Field>(apiKey.fields, "key").constraints, [{ name: "exclusive", args: [] }]);
});

Deno.test("schemaToIR - decimal scalar preserved", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const payment = obj(mod(ir.modules, "payment"), "Payment");
  assertEquals(field<Field>(payment.fields, "amount").type, { kind: "scalar", scalar: "decimal" });
});

Deno.test("schemaToIR - insert shape excludes id, links become uuid FKs", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const apiKey = obj(mod(ir.modules, "api"), "ApiKey");
  const insert = apiKey.shapes.insert;

  // id excluded
  assertEquals(insert.fields.some((f) => f.name === "id"), false);
  // required, no default -> not optional
  assertEquals(field<ShapeField>(insert.fields, "key").optional, false);
  // required but defaulted -> optional
  assertEquals(field<ShapeField>(insert.fields, "active").optional, true);
  // link -> uuid FK, required link is not optional
  const merchant = field<ShapeField>(insert.fields, "merchant");
  assertEquals(merchant.isLink, true);
  assertEquals(merchant.type, { kind: "scalar", scalar: "uuid" });
  assertEquals(merchant.optional, false);
});

Deno.test("schemaToIR - update shape: all optional, id excluded", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const merchant = obj(mod(ir.modules, "default"), "Merchant");
  const update = merchant.shapes.update;
  assertEquals(update.fields.some((f) => f.name === "id"), false);
  assertEquals(update.fields.every((f) => f.optional), true);
  // multi link still represented as uuid FK with Many cardinality
  const apiKeys = field<ShapeField>(update.fields, "apiKeys");
  assertEquals(apiKeys.isLink, true);
  assertEquals(apiKeys.cardinality, "Many");
});

Deno.test("schemaToIR - filter shape: scalar operands + nested-object link operands", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const merchant = obj(mod(ir.modules, "default"), "Merchant");
  const filter = merchant.shapes.filter;

  const name = field<FilterField>(filter.fields, "name");
  assertEquals(name.isLink, false);
  assertEquals(name.operand, { kind: "scalar", scalar: "str" });

  const payments = field<FilterField>(filter.fields, "payments");
  assertEquals(payments.isLink, true);
  assertEquals(payments.operand, { kind: "object", name: { module: "payment", name: "Payment" } });
});

Deno.test("schemaToIR - filterVars: every property, no links", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const merchant = obj(mod(ir.modules, "default"), "Merchant");
  const names = merchant.shapes.filterVars.fields.map((f) => f.name);
  assertEquals(names, ["id", "name", "status"]);
});

Deno.test("schemaToIR - standard CRUD operations with cardinalities", () => {
  const ir = schemaToIR(createMultiModuleTestSchema());
  const merchant = obj(mod(ir.modules, "default"), "Merchant");
  const byKind = Object.fromEntries(merchant.operations.map((o) => [o.kind, o]));

  assertEquals(Object.keys(byKind).sort(), [
    "count",
    "delete",
    "filter",
    "insert",
    "select",
    "selectById",
    "update",
  ]);
  assertEquals(byKind.select.output.cardinality, "Many");
  assertEquals(byKind.selectById.output.cardinality, "AtMostOne");
  assertEquals(byKind.insert.output.cardinality, "One");
  assertEquals(byKind.insert.params[0].type, { kind: "shape", object: merchant.name, variant: "insert" });
  assertEquals(byKind.count.output.type, { kind: "scalar", scalar: "int64" });
});

// --- hand-built fixture: collections, computed, readonly, gnarly scalars ----

function gnarlySchema(): Schema {
  const prop = (over: Partial<PropertyDef> & { name: string; edgeqlType: string }): PropertyDef => ({
    type: over.edgeqlType,
    required: true,
    multi: false,
    columnName: over.name,
    ...over,
  });

  const widget: TypeDef = {
    name: "Widget",
    kind: "object",
    tableName: "widgets",
    module: "default",
    properties: new Map<string, PropertyDef>([
      ["id", prop({ name: "id", edgeqlType: "uuid", hasDefault: true })],
      ["created", prop({ name: "created", edgeqlType: "datetime", readonly: true, hasDefault: true })],
      ["count", prop({ name: "count", edgeqlType: "int64" })],
      ["tags", prop({ name: "tags", edgeqlType: "array<str>", required: false })],
      ["span", prop({ name: "span", edgeqlType: "range<int32>", required: false })],
      ["pair", prop({ name: "pair", edgeqlType: "tuple<lat: float64, lng: float64>", required: false })],
      ["slug", prop({ name: "slug", edgeqlType: "auto", computed: true, required: false })],
    ]),
    links: new Map<string, LinkDef>(),
  };

  return {
    types: new Map<string, TypeDef>([["Widget", widget]]),
    functions: new Map(),
  };
}

Deno.test("schemaToIR - collection type refs (array/range/named tuple)", () => {
  const widget = obj(mod(schemaToIR(gnarlySchema()).modules, "default"), "Widget");
  assertEquals(field<Field>(widget.fields, "tags").type, {
    kind: "array",
    element: { kind: "scalar", scalar: "str" },
  });
  assertEquals(field<Field>(widget.fields, "span").type, {
    kind: "range",
    element: { kind: "scalar", scalar: "int32" },
  });
  assertEquals(field<Field>(widget.fields, "pair").type, {
    kind: "named_tuple",
    elements: [
      { name: "lat", type: { kind: "scalar", scalar: "float64" } },
      { name: "lng", type: { kind: "scalar", scalar: "float64" } },
    ],
  });
});

Deno.test("schemaToIR - int64/datetime scalars preserved", () => {
  const widget = obj(mod(schemaToIR(gnarlySchema()).modules, "default"), "Widget");
  assertEquals(field<Field>(widget.fields, "count").type, { kind: "scalar", scalar: "int64" });
  assertEquals(field<Field>(widget.fields, "created").type, { kind: "scalar", scalar: "datetime" });
});

Deno.test("schemaToIR - computed and readonly exclusion rules", () => {
  const widget = obj(mod(schemaToIR(gnarlySchema()).modules, "default"), "Widget");

  // computed: present in base fields and filterVars, absent from insert/update/filter
  assertEquals(field<Field>(widget.fields, "slug").isComputed, true);
  assertEquals(widget.shapes.filterVars.fields.some((f) => f.name === "slug"), true);
  assertEquals(widget.shapes.insert.fields.some((f) => f.name === "slug"), false);
  assertEquals(widget.shapes.update.fields.some((f) => f.name === "slug"), false);
  assertEquals(widget.shapes.filter.fields.some((f) => f.name === "slug"), false);

  // created is readonly+hasDefault: excluded from insert; readonly: excluded from update
  assertEquals(widget.shapes.insert.fields.some((f) => f.name === "created"), false);
  assertEquals(widget.shapes.update.fields.some((f) => f.name === "created"), false);
});
