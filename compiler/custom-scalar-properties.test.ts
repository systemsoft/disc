/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A property of a user scalar (`count: Count`, `scalar type Count extending
 * bigint`) is its base type wherever the compiler and the protocol read a
 * property's type: its column's SQL type (`numeric`, as `migration/ddl.ts`
 * lays it down) and the built-in type it extends (`PropertyDef.baseType`),
 * through chains of scalars, across modules (a bare name is the property's
 * own module's scalar first), inside arrays, and for link properties. A
 * sequence scalar is an int64; an enum keeps its own PostgreSQL type.
 *
 * So a write to one is checked like a write to its base type, arithmetic on
 * it follows its base type's rules, and an uncast parameter assigned to it
 * binds as its column type.
 *
 * See server/custom-scalar-pg.test.ts for what PostgreSQL answers.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { inferOutputShape } from "../protocol/binary-server.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { buildParameterTypeMap, EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  scalar type Count extending bigint;
  scalar type Tally extending Count;
  scalar type Money extending str;
  scalar type Blob extending bytes;
  scalar type Ticket extending sequence;
  scalar type Mood extending enum<Happy, Sad>;
  type Reading {
    count: Count;
    tally: Tally;
    ticket: Ticket;
    mood: Mood;
    label: Money;
    blob: Blob;
    multi counts: Count;
    history: array<Count>;
    n: int64;
    multi sensors: Sensor {
      weight: Count;
    };
  }
  type Sensor {
    required name: str;
  }
}
module ledger {
  scalar type Money extending decimal;
  type Account {
    balance: Money;
  }
}
`;

function schema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(SDL, { validate: false });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return manager.modulesToSchema(parsed.value);
}

function compileStatement(edgeql: string) {
  const result = new EdgeQLCompiler(schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function compile(edgeql: string): string {
  return new SQLCodeGenerator().generate(compileStatement(edgeql)).replace(/\s+/g, " ");
}

function property(typeName: string, name: string) {
  return schema().types.get(typeName)!.properties.get(name)!;
}

Deno.test("custom scalar properties - the schema gives a user scalar property its base type", () => {
  const types = (typeName: string, name: string) => {
    const { baseType, edgeqlType, type } = property(typeName, name);
    return { baseType, edgeqlType, type };
  };
  assertEquals(types("Reading", "count"), { baseType: "bigint", edgeqlType: "Count", type: "numeric" });
  assertEquals(types("Reading", "tally"), { baseType: "bigint", edgeqlType: "Tally", type: "numeric" });
  assertEquals(types("Reading", "ticket"), { baseType: "int64", edgeqlType: "Ticket", type: "bigint" });
  assertEquals(types("Reading", "label"), { baseType: "str", edgeqlType: "Money", type: "text" });
  assertEquals(types("Reading", "counts"), { baseType: "bigint", edgeqlType: "Count", type: "numeric[]" });
  assertEquals(types("Reading", "history"), { baseType: "array<bigint>", edgeqlType: "array<Count>", type: "numeric[]" });
  assertEquals(types("ledger::Account", "balance"), { baseType: "decimal", edgeqlType: "Money", type: "numeric" });
  assertEquals(types("Reading", "n"), { baseType: undefined, edgeqlType: "int64", type: "bigint" });
  assertEquals(types("Reading", "mood").baseType, undefined);

  const weight = schema().types.get("Reading")!.links.get("sensors")!.properties!.get("weight")!;
  assertEquals([weight.baseType, weight.type], ["bigint", "numeric"]);
});

Deno.test("custom scalar properties - a write to a scalar extending bigint is checked as a bigint", () => {
  assertStringIncludes(compile("insert Reading { count := 1.5 }"), "disc_finite_numeric(CAST(1.5 AS numeric), 'std::bigint')");
  assertStringIncludes(compile("insert Reading { tally := 'NaN' }"), "'std::bigint')");
  assertStringIncludes(compile("update Reading set { count := $c }"), "disc_finite_numeric(CAST($1 AS numeric), 'std::bigint')");
  assertStringIncludes(compile("update Reading set { counts += $c }"), "'std::bigint')");
  assertStringIncludes(compile("insert Reading { history := $h }"), "disc_finite_numeric(CAST($1 AS numeric[]), 'std::bigint')");
  assertStringIncludes(compile("insert ledger::Account { balance := $b }"), "disc_finite_numeric(CAST($1 AS numeric), 'std::decimal')");
  assertStringIncludes(
    compile("insert Reading { sensors := (select Sensor) { @weight := $w } }"),
    "disc_finite_numeric(CAST($1 AS numeric), 'std::bigint')"
  );
  assertEquals(compile("insert Reading { count := 7 }").includes("disc_finite_numeric"), false);
  assertEquals(compile("insert Reading { count := <int64>$n }").includes("disc_finite_numeric"), false);
});

Deno.test("custom scalar properties - an uncast parameter assigned to one binds as its column type", () => {
  assertEquals(buildParameterTypeMap(compileStatement("insert Reading { count := $c }")).get(1), "numeric");
  assertEquals(buildParameterTypeMap(compileStatement("insert ledger::Account { balance := $b }")).get(1), "numeric");
});

Deno.test("custom scalar properties - arithmetic follows the base type's rules", () => {
  // bigint / int64 is a decimal division; int64 / int64 a float64 one.
  assertEquals(compile("select Reading { x := .count / 2 }").includes("double precision"), false);
  assertEquals(compile("select Reading { x := .tally / 2 }").includes("double precision"), false);
  assertEquals(compile("select ledger::Account { x := .balance / 2 }").includes("double precision"), false);
  assertStringIncludes(compile("select Reading { x := .ticket / 2 }"), "double precision");
  assertStringIncludes(compile("select Reading { x := .count // 2 }"), "FLOOR(reading_1.count / 2)");
  assertEquals(compile("select <Count>7 / 2").includes("double precision"), false);
  assertEquals(compile("select <ledger::Money>7 / 2").includes("double precision"), false);
  assertStringIncludes(compile("select Reading { x := .ticket // 2 }"), "AS bigint)");
});

Deno.test("custom scalar properties - len() is chosen by the base type", () => {
  assertStringIncludes(compile("select Reading { x := len(.blob) }"), "OCTET_LENGTH(");
  assertStringIncludes(compile("select Reading { x := len(.label) }"), "LENGTH(");
});

Deno.test("custom scalar properties - the binary protocol describes one as its base type", () => {
  const shape = inferOutputShape(new EdgeQLParser("select ledger::Account { balance }").parse(), schema());
  assertEquals(shape.fields.find(field => field.name === "balance")?.edgeqlType, "decimal");
  const reading = inferOutputShape(new EdgeQLParser("select Reading { count, ticket }").parse(), schema());
  const typeOf = (name: string) => reading.fields.find(field => field.name === name)?.edgeqlType;
  assertEquals([typeOf("count"), typeOf("ticket")], ["bigint", "int64"]);
});
