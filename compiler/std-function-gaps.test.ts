/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `len()`, set-returning function arguments, and the sequence functions.
 *
 * - `len()` picks the PostgreSQL function by its argument's static type:
 *   `CARDINALITY` for an array (PG `LENGTH` has no array form), `OCTET_LENGTH`
 *   for bytes, and `LENGTH` for str or an unknown type (`LENGTH(text)` counts
 *   characters, like Gel's `len(str)`, and also takes bytea).
 * - A set-returning call (`array_unpack(…)`) aggregated, tested with `exists`
 *   or enumerated is a subquery of its rows: PostgreSQL rejects
 *   `COUNT(UNNEST(…))`, and `UNNEST(…) IS NOT NULL` is not a set test.
 * - `sequence_next(introspect T)` / `sequence_reset(introspect T[, v])` are
 *   `NEXTVAL` / `SETVAL` on the PostgreSQL sequence the migrator creates for
 *   the sequence scalar `T`.
 *
 * Real-PG coverage: `compiler/pg-std-function-gaps.test.ts` and
 * `migration/sequence-scalar-pg.test.ts`.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  scalar type Count extending int64;
  scalar type TicketNo extending sequence;
  scalar type SubTicketNo extending TicketNo;
  type Doc {
    required title: str;
    data: bytes;
    tags: array<str>;
    durs: array<duration>;
    number: TicketNo;
  }
}

module billing {
  scalar type Invoice extending sequence;
  scalar type SubInvoice extending Invoice;
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
  const result = new EdgeQLCompiler(schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());

  if (!result.ok)
    throw result.error;

  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim();
}

// ── len() ────────────────────────────────────────────────────────────────

Deno.test("len: an array argument is CARDINALITY", () => {
  assertEquals(compile("select len(<array<str>>$x)"), "SELECT CARDINALITY(CAST($1 AS text[]))");
  assertEquals(compile("select len([1, 2])"), "SELECT CARDINALITY(ARRAY[1, 2])");
  assertEquals(compile("select len(str_split('a,b', ','))"), "SELECT CARDINALITY(STRING_TO_ARRAY('a,b', ','))");
  assertStringIncludes(compile("with a := <array<int64>>$x select len(a)"), "CARDINALITY(CAST($1 AS bigint[]))");
});

Deno.test("len: array and bytes properties use their own length functions", () => {
  const sql = compile("select Doc { t := len(.tags), d := len(.durs), b := len(.data), s := len(.title) }");

  assertStringIncludes(sql, "'t', CARDINALITY(doc_1.tags)");
  assertStringIncludes(sql, "'d', CARDINALITY(doc_1.durs)");
  assertStringIncludes(sql, "'b', OCTET_LENGTH(doc_1.data)");
  assertStringIncludes(sql, "'s', LENGTH(doc_1.title)");
});

Deno.test("len: a bytes cast is OCTET_LENGTH, a str or unknown argument LENGTH", () => {
  assertEquals(compile("select len(<bytes>$b)"), "SELECT OCTET_LENGTH(CAST($1 AS bytea))");
  assertEquals(compile("select len('abc')"), "SELECT LENGTH('abc')");
  assertEquals(compile("select len(<str>$s)"), "SELECT LENGTH(CAST($1 AS text))");
});

// ── Set-returning function arguments ────────────────────────────────────

Deno.test("set-returning argument: count and sum aggregate the unpacked rows", () => {
  assertEquals(
    compile("select count(array_unpack(<array<int64>>$x))"),
    "SELECT ( SELECT COUNT(*) FROM ( SELECT UNNEST(CAST($1 AS bigint[])) ) AS __set )"
  );
  assertEquals(
    compile("select sum(array_unpack(<array<int64>>$x))"),
    "SELECT ( SELECT COALESCE(SUM(__set.value), 0) FROM ( SELECT UNNEST(CAST($1 AS bigint[])) ) AS __set(value) )"
  );
});

Deno.test("set-returning argument: min, max, avg, array_agg and json_array_unpack never nest the SRF in the aggregate", () => {
  for (
    const query of [
      "select min(array_unpack(<array<int64>>$x))",
      "select max(std::array_unpack(<array<int64>>$x))",
      "select avg(array_unpack(<array<int64>>$x))",
      "select array_agg(array_unpack(<array<str>>$x))",
      "select count(json_array_unpack(<json>$j))",
      "select Doc { n := count(array_unpack(.tags)) }"
    ]
  ) {
    const sql = compile(query);
    assertStringIncludes(sql, "FROM ( SELECT ", query);
    assertEquals(/(MIN|MAX|AVG|ARRAY_AGG|COUNT)\((UNNEST|JSONB_ARRAY_ELEMENTS)/.test(sql), false, `${query}: ${sql}`);
  }
});

Deno.test("set-returning argument: exists tests the rows", () => {
  assertEquals(compile("select exists array_unpack(<array<int64>>$x)"), "SELECT EXISTS ( SELECT UNNEST(CAST($1 AS bigint[])) )");
  assertEquals(compile("select std::exists(array_unpack(<array<int64>>$x))"), "SELECT EXISTS ( SELECT UNNEST(CAST($1 AS bigint[])) )");
  assertStringIncludes(compile("select Doc filter not exists array_unpack(<array<int64>>$x)"), "WHERE NOT EXISTS ( SELECT UNNEST(");
});

Deno.test("set-returning argument: a with binding of an unpacked array or a set literal aggregates its rows", () => {
  assertStringIncludes(
    compile("with a := array_unpack(<array<int64>>$x) select count(a)"),
    "SELECT COUNT(*) FROM ( SELECT UNNEST(CAST($1 AS bigint[])) ) AS __set"
  );
  assertStringIncludes(compile("with a := {1, 2, 3} select count(a)"), "SELECT COUNT(*) FROM (");
  assertStringIncludes(compile("with a := array_unpack(<array<int64>>$x) select exists a"), "EXISTS ( SELECT UNNEST(");
});

Deno.test("set-returning argument: filter and order by over a with-bound unpacked array read the row's value", () => {
  const sql = compile("with a := array_unpack(<array<int64>>$x) select a filter a > 1 order by a desc");

  assertStringIncludes(sql, "WITH a (value) AS ( SELECT UNNEST(CAST($1 AS bigint[])) )");
  assertStringIncludes(sql, "WHERE a_1.value > 1 ORDER BY a_1.value DESC");
});

Deno.test("set-returning argument: enumerate numbers the unpacked rows, not the one row around them", () => {
  const sql = compile("select enumerate(array_unpack(<array<str>>$x))");

  assertEquals(
    sql,
    "SELECT UNNEST(ARRAY ( SELECT jsonb_build_array(ROW_NUMBER() OVER () - 1, __set.value) " +
      "FROM ( SELECT UNNEST(CAST($1 AS text[])) ) AS __set(value) ))"
  );
  assertStringIncludes(compile("select count(enumerate(array_unpack(<array<str>>$x)))"), "SELECT COUNT(*) FROM ( SELECT UNNEST(ARRAY ( SELECT");
});

// ── Sequence functions ──────────────────────────────────────────────────

Deno.test("sequence_next(introspect T) is NEXTVAL on the scalar's sequence", () => {
  assertEquals(compile("select sequence_next(introspect TicketNo)"), "SELECT NEXTVAL('disc_seq_ticketno')");
  assertEquals(compile("select sequence_next(introspect default::TicketNo)"), "SELECT NEXTVAL('disc_seq_ticketno')");
  assertEquals(compile("select sequence_next(introspect billing::Invoice)"), "SELECT NEXTVAL('disc_seq_billing__invoice')");
  assertEquals(compile("select sequence_next(introspect Invoice)"), "SELECT NEXTVAL('disc_seq_billing__invoice')");
  assertEquals(compile("with module billing select sequence_next(introspect Invoice)"), "SELECT NEXTVAL('disc_seq_billing__invoice')");
});

Deno.test("sequence functions: a scalar extending a sequence scalar uses its own sequence", () => {
  assertEquals(compile("select sequence_next(introspect SubTicketNo)"), "SELECT NEXTVAL('disc_seq_subticketno')");
  assertEquals(compile("select sequence_reset(introspect billing::SubInvoice, 5)"), "SELECT SETVAL('disc_seq_billing__subinvoice', 5)");
});

Deno.test("sequence_reset(introspect T, v) sets the value; without v it restarts the sequence", () => {
  assertEquals(compile("select sequence_reset(introspect TicketNo, 10)"), "SELECT SETVAL('disc_seq_ticketno', 10)");
  assertEquals(
    compile("select sequence_reset(introspect TicketNo)"),
    "SELECT SETVAL('disc_seq_ticketno', ( SELECT seqstart FROM pg_catalog.pg_sequence WHERE seqrelid = 'disc_seq_ticketno'::regclass ), FALSE)"
  );
});

Deno.test("sequence functions: a type that is not a sequence scalar is a compile error", () => {
  assertThrows(() => compile("select sequence_next(introspect Count)"), Error, "'Count' is not a sequence scalar type");
  assertThrows(() => compile("select sequence_next(introspect Doc)"), Error, "'Doc' is not a sequence scalar type");
  assertThrows(() => compile("select sequence_reset(introspect Nope, 1)"), Error, "'Nope' is not a sequence scalar type");
  assertThrows(() => compile("select sequence_reset(introspect TicketNo, 1, 2)"), Error, "sequence_reset() takes 1 or 2 arguments");
});
