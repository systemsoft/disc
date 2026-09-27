/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A scalar type's constraints (`scalar type Pos extending int64 { constraint
 * min_value(0); }`) are CHECKs on every column holding a value of it.
 *
 * They were parsed and then dropped: no DDL at all, so a schema declaring an
 * `EVMAddress` regexp stored any string. Each now compiles, as Gel defines it
 * (`min_value(m)` is `__subject__ >= m`, …), onto every column of the scalar
 * or of a scalar extending it — properties in subtype tables, multi
 * properties and arrays element by element, link properties in junction
 * tables — with Gel's violation message and details, and migrations add and
 * drop them as scalars and properties change.
 */

import { assert, assertEquals } from "@std/assert";
import { normalizeModules, type Module } from "../schema/converter.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { SchemaManager } from "./schema-manager.ts";
import type * as Types from "./types.ts";

function modules(sdl: string): Module[] {
  const parsed = new SchemaManager({}).parseSDL(sdl);
  if (!parsed.ok)
    throw parsed.error;
  return normalizeModules(parsed.value);
}

function diff(from: string, to: string): Types.MigrationOperation[] {
  return new SchemaDiffer().diff(from === "" ? [] : modules(from), modules(to));
}

function checks(operations: Types.MigrationOperation[]): { kind: string; check: Types.CheckDefinition; }[] {
  return operations
    .filter(op => op.kind === "AddCheck" || op.kind === "DropCheck")
    .map(op => ({ check: (op as Types.AddCheckOperation).check, kind: op.kind }));
}

function declared(sdl: string): Types.CheckDefinition[] {
  return new SchemaDiffer().declaredChecks(modules(sdl), true);
}

const EVM = String.raw`scalar type EVMAddress extending str { constraint regexp(r'^0x[0-9a-fA-F]{40}$'); };`;
const LIGHTNING = String.raw`scalar type LightningAddress extending str {
  constraint regexp(r'^([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}|lnurl1[a-z0-9]+)$');
};`;

Deno.test("scalar constraint: a property of a constrained scalar gets its CHECK, with Gel's message and details", () => {
  const [check] = declared(`module default { scalar type Pos extending int64 { constraint min_value(0); }; type T { p: Pos; }; };`);

  assertEquals(check.table, "t");
  assertEquals(check.expression, "CAST(p AS bigint) >= 0");
  assertEquals(check.message, "Minimum allowed value for Pos is 0.");
  assertEquals(check.detail, "violated constraint 'std::min_value' on scalar type 'default::Pos'");
  assertEquals(check.declaration, "constraint min_value(0)");
  assertEquals(check.subject, "property 'default::T.p' (scalar type 'default::Pos')");
});

Deno.test("scalar constraint: raw-string regexps reach the CHECK exactly, backslashes and all", () => {
  const found = declared(`module default { ${EVM} ${LIGHTNING} type Wallet { evm: EVMAddress; ln: LightningAddress; }; };`);
  const byColumn = new Map(found.map(check => [check.message, check]));

  assertEquals(byColumn.get("invalid EVMAddress")!.expression, "CAST(evm AS text) ~ '^0x[0-9a-fA-F]{40}$'");
  assertEquals(
    byColumn.get("invalid LightningAddress")!.expression,
    String.raw`CAST(ln AS text) ~ '^([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}|lnurl1[a-z0-9]+)$'`
  );
  assertEquals(byColumn.get("invalid LightningAddress")!.detail, "violated constraint 'std::regexp' on scalar type 'default::LightningAddress'");
});

Deno.test("scalar constraint: every kind compiles, with Gel's default messages", () => {
  const found = declared(`module default {
    scalar type Max10 extending int64 { constraint max_value(10); };
    scalar type MinEx extending int64 { constraint min_ex_value(0); };
    scalar type MaxEx extending int64 { constraint max_ex_value(10); };
    scalar type MinLen extending str { constraint min_len_value(3); };
    scalar type MaxLen extending str { constraint max_len_value(5); };
    scalar type AB extending str { constraint one_of('a', 'b'); };
    scalar type NotBad extending str { constraint expression on (__subject__ != 'bad'); };
    type T { a: Max10; b: MinEx; c: MaxEx; d: MinLen; e: MaxLen; f: AB; g: NotBad; };
  };`);
  const summary = found.map(check => `${check.expression} | ${check.message}`).sort();

  assertEquals(
    summary,
    [
      "CAST(a AS bigint) <= 10 | Maximum allowed value for Max10 is 10.",
      "CAST(b AS bigint) > 0 | MinEx must be greater than 0.",
      "CAST(c AS bigint) < 10 | MaxEx must be less than 10.",
      "CAST(g AS text) != 'bad' | invalid NotBad",
      "CAST(f AS text) IN ('a', 'b') | AB must be one of: ['a', 'b'].",
      "LENGTH(CAST(d AS text)) >= 3 | MinLen must be no shorter than 3 characters.",
      "LENGTH(CAST(e AS text)) <= 5 | MaxLen must be no longer than 5 characters."
    ]
      .sort()
  );
});

Deno.test("scalar constraint: errmessage fills in {__subject__} and the parameter", () => {
  const found = declared(`module default {
    scalar type Pos extending int64 { constraint min_value(0) { errmessage := 'custom {__subject__} min={min}'; }; };
    scalar type Hex extending str { constraint regexp(r'^0x[0-9a-f]+$') { errmessage := '{__subject__} pattern={pattern}'; }; };
    scalar type AB extending str { constraint one_of('a', 'b') { errmessage := 'vals={vals} array={array}'; }; };
    type T { p: Pos; h: Hex; ab: AB; };
  };`);

  assertEquals(found.map(check => check.message).sort(), ["Hex pattern='^0x[0-9a-f]+$'", "custom Pos min=0", "vals=['a', 'b'] array={array}"]);
});

Deno.test("scalar constraint: a scalar extending a constrained scalar has both, each reported as its declaring scalar's", () => {
  const found = declared(`module default {
    scalar type Short extending str { constraint max_len_value(5); };
    scalar type Code extending Short { constraint regexp(r'^[A-Z]+$'); };
    type T { c: Code; };
  };`);

  assertEquals(found.map(check => check.detail).sort(), [
    "violated constraint 'std::max_len_value' on scalar type 'default::Short'",
    "violated constraint 'std::regexp' on scalar type 'default::Code'"
  ]);
  assertEquals(found.find(check => check.detail.includes("Short"))!.expression, "LENGTH(CAST(c AS text)) <= 5");
});

Deno.test("scalar constraint: multi properties, arrays and link properties are checked element by element / in the junction", () => {
  const found = declared(`module default {
    scalar type Pos extending int64 { constraint min_value(0); };
    scalar type AB extending str { constraint one_of('a', 'b'); };
    scalar type Hex extending str { constraint regexp(r'^[0-9a-f]+$'); };
    type Tag {};
    type T {
      multi scores: Pos;
      arr: array<Pos>;
      letters: array<AB>;
      multi hashes: Hex;
      multi tags: Tag { weight: Pos; };
    };
  };`);
  const byTable = found.map(check => `${check.table}: ${check.expression}`).sort();

  assertEquals(
    byTable,
    [
      `t: 0 <= ALL("arr")`,
      `t: "letters" <@ ARRAY['a', 'b']::text[]`,
      `t: 0 <= ALL("scores")`,
      `t: disc_array_all_match("hashes", '^[0-9a-f]+$')`,
      "t_tags: CAST(weight AS bigint) >= 0"
    ]
      .sort()
  );
  assertEquals(found.find(check => check.table === "t_tags")!.subject, "link property 'default::T.tags@weight' (scalar type 'default::Pos')");
});

Deno.test("scalar constraint: subtypes' tables get it, abstract tables and enums don't", () => {
  const found = declared(`module default {
    scalar type Pos extending int64 { constraint min_value(0); };
    scalar type Mood extending enum<Happy, Sad>;
    abstract type Base { p: Pos; mood: Mood; };
    type Child extending Base {};
  };`);

  assertEquals(found.map(check => check.table), ["child"]);
});

Deno.test("scalar constraint: a scalar expression on a multi or array property checks each element", () => {
  const found = declared(
    `module default { scalar type NotBad extending str { constraint expression on (__subject__ != 'bad'); }; type T { multi words: NotBad; list: array<NotBad>; }; };`
  );

  assertEquals(found.map(check => check.expression).sort(), [
    "disc_each_holds(\"list\", E'CAST($1 AS text) != ''bad''')",
    "disc_each_holds(\"words\", E'CAST($1 AS text) != ''bad''')"
  ]);
  assertEquals(found[0].message, "invalid NotBad");
});

// ============================================================
// Migrations
// ============================================================

const BASE = (scalar: string, props: string): string => `module default { scalar type Pos extending int64 ${scalar}; type T { a: int64; ${props} }; };`;

Deno.test("scalar constraint: adding one to a scalar adds a CHECK to each of its columns; removing drops them", () => {
  const plain = BASE("", "p: Pos; q: Pos;");
  const constrained = BASE("{ constraint min_value(0); }", "p: Pos; q: Pos;");

  assertEquals(checks(diff(plain, constrained)).map(op => `${op.kind} ${op.check.expression}`).sort(), [
    "AddCheck CAST(p AS bigint) >= 0",
    "AddCheck CAST(q AS bigint) >= 0"
  ]);
  assertEquals(checks(diff(constrained, plain)).map(op => op.kind), ["DropCheck", "DropCheck"]);
  assertEquals(diff(constrained, constrained), []);
});

Deno.test("scalar constraint: changing it replaces each CHECK; adding or removing a property of the scalar adds or drops one", () => {
  const zero = BASE("{ constraint min_value(0); }", "p: Pos;");
  const one = BASE("{ constraint min_value(1); }", "p: Pos;");

  assertEquals(checks(diff(zero, one)).map(op => op.kind), ["DropCheck", "AddCheck"]);

  const added = diff(zero, BASE("{ constraint min_value(0); }", "p: Pos; q: Pos;"));
  assertEquals(checks(added).map(op => `${op.kind} ${op.check.expression}`), ["AddCheck CAST(q AS bigint) >= 0"]);
  assertEquals(added.at(-1)!.kind, "AddCheck", "after the column is added");

  const removed = diff(zero, BASE("{ constraint min_value(0); }", ""));
  assertEquals(removed[0].kind, "DropCheck", "before the column is dropped");

  const retyped = diff(BASE("{ constraint min_value(0); }", "p: int64;"), zero);
  assertEquals(checks(retyped).map(op => op.kind), ["AddCheck"], "a property changed to the scalar gets its CHECK");
});

Deno.test("scalar constraint: rolling back a removed property restores its column before its CHECK", () => {
  const withP = BASE("{ constraint min_value(0); }", "p: Pos;");
  const withoutP = BASE("{ constraint min_value(0); }", "");
  const statements = new DDLGenerator().generateRollbackDDL(diff(withP, withoutP), diff(withoutP, withP));
  const column = statements.findIndex(s => s.includes("ADD COLUMN p "));
  const check = statements.findIndex(s => s.includes("CHECK (disc_check_constraint(CAST(p AS bigint) >= 0"));

  assert(column >= 0 && check > column, statements.join("\n"));
});
