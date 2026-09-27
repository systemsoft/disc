/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Casts compile to the PostgreSQL type the column of that type has.
 *
 * - `<std::int64>$x` is `<int64>$x`: Gel accepts both spellings.
 * - `<array<duration>>`, `<array<cal::relative_duration>>`,
 *   `<array<cal::date_duration>>`, `<range<float32>>` and
 *   `<multirange<float32>>` were missing from the cast map and reached
 *   PostgreSQL verbatim (`CAST($1 AS array<duration>)`, a syntax error).
 * - A user scalar extending a built-in (`scalar type Count extending int64`)
 *   casts to that built-in's type, and a sequence scalar to bigint.
 *
 * The cast map and the DDL's column-type map must agree on every type, or a
 * parameter cast to a property's type is not the column's type.
 *
 * Real-PG coverage lives in `migration/sequence-scalar-pg.test.ts`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type * as MigrationTypes from "../migration/types.ts";
import { edgeqlTypeToPgType } from "./compiler-base.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  scalar type Count extending int64;
  scalar type Money extending decimal;
  scalar type Cents extending Money;
  scalar type TicketNo extending sequence;
  type Ticket {
    number: TicketNo;
    count: Count;
  }
}

module billing {
  scalar type Weight extending float64;
}
`;

function schema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });

  if (!parsed.ok)
    throw parsed.error;

  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema()).compile(new EdgeQLParser(edgeql).parse());

  if (!result.ok)
    throw result.error;

  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

const CASTS: [string, string][] = [
  ["std::int64", "bigint"],
  ["std::str", "text"],
  ["std::bigint", "numeric"],
  ["std::datetime", "timestamptz"],
  ["std::json", "jsonb"],
  ["array<std::str>", "text[]"],
  ["array<std::int64>", "bigint[]"],
  ["range<std::int64>", "int8range"],
  ["array<duration>", "interval[]"],
  ["array<cal::relative_duration>", "interval[]"],
  ["array<cal::date_duration>", "interval[]"],
  ["range<float32>", "numrange"],
  ["multirange<float32>", "nummultirange"],
  ["Count", "bigint"],
  ["default::Count", "bigint"],
  ["array<Count>", "bigint[]"],
  ["Cents", "numeric"],
  ["array<Cents>", "numeric[]"],
  ["billing::Weight", "double precision"],
  ["TicketNo", "bigint"],
  ["array<TicketNo>", "bigint[]"]
];

for (const [edgeqlType, pgType] of CASTS) {
  Deno.test(`cast types - <${edgeqlType}>$x casts to ${pgType}`, () => {
    assertStringIncludes(compile(`select <${edgeqlType}>$x`), `CAST($1 AS ${pgType})`);
  });
}

Deno.test("cast types - a std:: cast inside an expression", () => {
  assertStringIncludes(compile("select <std::str><std::int64>$x"), "CAST(CAST($1 AS bigint) AS text)");
});

/*** Spell a DDL column type the way the compiler does. ***/
function canonical(pgType: string): string {
  return pgType
    .toLowerCase()
    .replace(/\btimestamp with time zone\b/, "timestamptz")
    .replace(/^decimal\b/, "numeric");
}

const GEL_TYPES = [
  "str",
  "bool",
  "int16",
  "int32",
  "int64",
  "float32",
  "float64",
  "decimal",
  "bigint",
  "json",
  "uuid",
  "bytes",
  "datetime",
  "duration",
  "cal::local_datetime",
  "cal::local_date",
  "cal::local_time",
  "cal::relative_duration",
  "cal::date_duration"
];

const RANGE_ELEMENTS = ["int32", "int64", "float32", "float64", "decimal", "datetime", "cal::local_date", "cal::local_datetime"];

Deno.test("cast types - every built-in type, array and range casts to its DDL column type", () => {
  const ddl = new DDLGenerator();
  const types = [
    ...GEL_TYPES,
    ...GEL_TYPES.map(type => `array<${type}>`),
    ...RANGE_ELEMENTS.flatMap(type => [`range<${type}>`, `multirange<${type}>`])
  ];

  for (const type of types) {
    const column = ddl.propertyColumnType({ type, multi: false } as MigrationTypes.PropertyDefinition);
    assertEquals(edgeqlTypeToPgType(type), canonical(column), type);
  }
});
