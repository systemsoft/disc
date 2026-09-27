/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Gel accepts every standard scalar under its `std::` name as well as its
 * bare one (`std::int64` is `int64`). Disc rejected the qualified spelling
 * ("Type 'std::int64' is not defined"). The SDL parser now reads a `std::`
 * scalar name as the bare name, so everything downstream (validator, DDL,
 * compiler schema, codegen) sees one spelling.
 *
 * `sequence` is Gel's auto-incrementing int64: only a scalar may extend it
 * (`scalar type TicketNo extending sequence;`), not a property's type.
 */

import { assertEquals } from "@std/assert";
import { SDLConverter, type Module } from "./converter.ts";
import { SDLParser } from "./parser.ts";
import { SchemaValidator } from "./validator.ts";
import type * as AST from "./ast.ts";

function validate(source: string): string[] {
  const result = new SchemaValidator().validate(new SDLParser(source).parse());
  return (result.errors ?? []).map(error => error.message);
}

function modules(source: string): Module[] {
  return new SDLConverter().convertToModules(new SDLParser(source).parse());
}

/*** `type` name → property name → the property's rendered type. ***/
function propertyTypes(source: string, typeName: string): Record<string, string> {
  const render = (ref: AST.TypeRef): string => ref.name.parts.join("::") + (ref.params?.length ? `<${ref.params.map(render).join(", ")}>` : "");
  const decl = modules(source)
    .flatMap(module => module.items)
    .find((item): item is AST.TypeDeclaration => item.kind === "TypeDeclaration" && item.name.value === typeName);
  const out: Record<string, string> = {};

  for (const member of decl?.members ?? []) {
    if (member.kind === "PropertyDeclaration")
      out[member.name.value] = render(member.type);
  }

  return out;
}

const STD_SDL = `module default {
  scalar type Count extending std::int64;
  global limit: std::int64;
  function double(x: std::int64) -> std::int64 using (x * 2);
  type Item {
    required name: std::str;
    big: std::bigint;
    created: std::datetime;
    meta: std::json;
    tags: array<std::str>;
    pair: tuple<std::str, std::int64>;
    span: range<std::int64>;
    day: cal::local_date;
    count: Count;
    ok -> std::bool;
  };
};`;

Deno.test("std:: names: the validator accepts std::-qualified scalar names everywhere a type goes", () => {
  assertEquals(validate(STD_SDL), []);
});

Deno.test("std:: names: the parser reads a std:: scalar as its bare name, including inside collections", () => {
  assertEquals(propertyTypes(STD_SDL, "Item"), {
    big: "bigint",
    count: "Count",
    created: "datetime",
    day: "cal::local_date",
    meta: "json",
    name: "str",
    pair: "tuple<str, int64>",
    span: "range<int64>",
    tags: "array<str>"
  });
});

Deno.test("std:: names: an unknown std:: name is still an error", () => {
  assertEquals(validate(`type Thing { x: std::nope; };`), ["Type 'std::nope' is not defined"]);
});

Deno.test("sequence: a scalar may extend sequence (bare or std::)", () => {
  assertEquals(
    validate(`module default {
      scalar type TicketNo extending sequence;
      scalar type OrderNo extending std::sequence;
      type Ticket { number: TicketNo; order_no: OrderNo; };
    };`),
    []
  );
});

Deno.test("sequence: a property cannot use sequence directly", () => {
  const errors = validate(`type Ticket { number: sequence; };`);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].includes("scalar type"), true, errors[0]);
});
