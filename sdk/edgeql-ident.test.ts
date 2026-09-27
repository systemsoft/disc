/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { escapeEdgeQLIdent } from "./edgeql-ident.ts";
import type { TypeInfo } from "./filter-compiler.ts";
import { compileFilter } from "./filter-compiler.ts";

Deno.test("escapeEdgeQLIdent — backtick-quotes reserved keywords", () => {
  assertEquals(escapeEdgeQLIdent("for"), "`for`");
  assertEquals(escapeEdgeQLIdent("filter"), "`filter`");
  assertEquals(escapeEdgeQLIdent("order"), "`order`");
});

Deno.test("escapeEdgeQLIdent — reserved check is case-insensitive", () => {
  assertEquals(escapeEdgeQLIdent("FOR"), "`FOR`");
});

Deno.test("escapeEdgeQLIdent — leaves ordinary identifiers untouched", () => {
  assertEquals(escapeEdgeQLIdent("token"), "token");
  assertEquals(escapeEdgeQLIdent("created"), "created");
  assertEquals(escapeEdgeQLIdent("forename"), "forename");
});

const loginInfo: TypeInfo = {
  casts: { id: "<uuid>", for: "<uuid>", token: "<str>" },
  links: {}
};

Deno.test("compileFilter — reserved field name is backtick-quoted in clause + shape", () => {
  const result = compileFilter(
    "Login",
    { for: "abc", select: { for: true, token: true } },
    loginInfo
  );
  assertEquals(result.clause, ".`for` = <uuid>$p0");
  assertEquals(result.selectShape, "{ `for`, token }");
  // The whole emitted statement must parse without error.
  const query = `select Login ${result.selectShape} filter ${result.clause}`;
  new EdgeQLParser(query).parse();
});

Deno.test("compileFilter — reserved field in order_by is backtick-quoted", () => {
  const result = compileFilter("Login", { order_by: "-for" }, loginInfo);
  assertEquals(result.orderBy, "order by .`for` desc");
  new EdgeQLParser(`select Login ${result.orderBy}`).parse();
});

// A name is written into the query text as is (field paths, shapes, and the
// generated client's `insert`/`update` assignments and `$<name>` parameters),
// so one that isn't an EdgeQL identifier — a filter object's keys can come
// from a request — must never reach it.
Deno.test("escapeEdgeQLIdent — rejects a name that isn't an identifier", () => {
  for (const name of ["", "name or true", "a.b", "x`y", "1a", "a-b", "näme"]) {
    assertThrows(() => escapeEdgeQLIdent(name), Error, "Invalid field name", name);
  }
});

Deno.test("compileFilter — a filter key that isn't an identifier is an error, not query text", () => {
  assertThrows(() => compileFilter("Login", { "token = 'a' or true": "x" }, loginInfo), Error, "Invalid field name");
  assertThrows(() => compileFilter("Login", { token: { eq: "a", "x or true": 1 } } as never, loginInfo), Error);
});
