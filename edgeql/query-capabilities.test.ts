/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for `isWriteQuery` AST classifier.
 * Ports geldata/gel#5543 (gh/geldata#5524).
 */

import { assertEquals } from "@std/assert";
import type { Query } from "./ast.ts";
import { EdgeQLParser } from "./parser.ts";
import { isWriteQuery } from "./query-capabilities.ts";

function parse(q: string): Query {
  return new EdgeQLParser(q).parse();
}

Deno.test("isWriteQuery - SELECT is a read", () => {
  assertEquals(isWriteQuery(parse("SELECT 1")), false);
});

Deno.test("isWriteQuery - SELECT with shape is a read", () => {
  assertEquals(
    isWriteQuery(parse("SELECT User { name, email }")),
    false
  );
});

Deno.test("isWriteQuery - INSERT is a write", () => {
  assertEquals(
    isWriteQuery(parse("INSERT User { name := 'alice' }")),
    true
  );
});

Deno.test("isWriteQuery - UPDATE is a write", () => {
  assertEquals(
    isWriteQuery(
      parse("UPDATE User FILTER .id = <uuid>$id SET { name := 'bob' }")
    ),
    true
  );
});

Deno.test("isWriteQuery - DELETE is a write", () => {
  assertEquals(
    isWriteQuery(parse("DELETE User FILTER .id = <uuid>$id")),
    true
  );
});

Deno.test("isWriteQuery - CONFIGURE SESSION is a read (session-local)", () => {
  assertEquals(
    isWriteQuery(parse("CONFIGURE SESSION SET foo := 1")),
    false
  );
});

Deno.test("isWriteQuery - CONFIGURE DATABASE is a write", () => {
  assertEquals(
    isWriteQuery(parse("CONFIGURE DATABASE SET foo := 1")),
    true
  );
});

Deno.test("isWriteQuery - CONFIGURE INSTANCE is a write", () => {
  assertEquals(
    isWriteQuery(parse("CONFIGURE INSTANCE SET foo := 1")),
    true
  );
});

Deno.test("isWriteQuery - DESCRIBE TYPE is a read", () => {
  assertEquals(isWriteQuery(parse("DESCRIBE TYPE User")), false);
});

Deno.test("isWriteQuery - SET GLOBAL is a read (session-scoped)", () => {
  assertEquals(
    isWriteQuery(parse("SET GLOBAL current_user := <uuid>$id")),
    false
  );
});

// Nested mutations: a write anywhere in the AST makes the query a write.

Deno.test("isWriteQuery - with-bound UPDATE selected in the body is a write", () => {
  assertEquals(
    isWriteQuery(parse("WITH u := (UPDATE User SET { name := 'bob' }) SELECT u")),
    true
  );
});

Deno.test("isWriteQuery - with-bound DELETE and INSERT are writes", () => {
  assertEquals(isWriteQuery(parse("WITH d := (DELETE User) SELECT d")), true);
  assertEquals(
    isWriteQuery(parse("WITH i := (INSERT User { name := 'alice' }) SELECT i { id }")),
    true
  );
});

Deno.test("isWriteQuery - SELECT over a mutation operand is a write", () => {
  assertEquals(
    isWriteQuery(parse("SELECT (UPDATE User SET { name := 'bob' }) { id }")),
    true
  );
  assertEquals(isWriteQuery(parse("SELECT (DELETE User) { id }")), true);
  assertEquals(
    isWriteQuery(parse("SELECT (INSERT User { name := 'alice' }) { id }")),
    true
  );
});

Deno.test("isWriteQuery - FOR with a mutation body is a write", () => {
  assertEquals(
    isWriteQuery(parse("FOR n IN {'a', 'b'} UNION (INSERT User { name := n })")),
    true
  );
});

Deno.test("isWriteQuery - mutation nested in a with block inside a FOR body is a write", () => {
  assertEquals(
    isWriteQuery(
      parse("FOR n IN {'a'} UNION (WITH i := (INSERT User { name := n }) SELECT i)")
    ),
    true
  );
});

Deno.test("isWriteQuery - with-bound SELECT stays a read", () => {
  assertEquals(
    isWriteQuery(parse("WITH u := (SELECT User FILTER .name = 'bob') SELECT u")),
    false
  );
});

Deno.test("isWriteQuery - FOR with a SELECT body stays a read", () => {
  assertEquals(
    isWriteQuery(parse("FOR n IN {'a', 'b'} UNION (SELECT User FILTER .name = n)")),
    false
  );
});

Deno.test("isWriteQuery - EXPLAIN ANALYZE of a mutation executes it, so it is a write", () => {
  assertEquals(
    isWriteQuery(parse("EXPLAIN ANALYZE UPDATE User SET { name := 'bob' }")),
    true
  );
});

Deno.test("isWriteQuery - plain EXPLAIN of a mutation only plans it, so it is a read", () => {
  assertEquals(
    isWriteQuery(parse("EXPLAIN UPDATE User SET { name := 'bob' }")),
    false
  );
  assertEquals(isWriteQuery(parse("EXPLAIN ANALYZE SELECT User { name }")), false);
});

Deno.test("isWriteQuery - unknown kind defaults to write (fail closed)", () => {
  // Forge an AST with an unrecognized kind to lock in fail-closed semantics.
  const fakeAst = { kind: "BogusQuery" } as unknown as Query;
  assertEquals(isWriteQuery(fakeAst), true);
});
