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
    false,
  );
});

Deno.test("isWriteQuery - INSERT is a write", () => {
  assertEquals(
    isWriteQuery(parse("INSERT User { name := 'alice' }")),
    true,
  );
});

Deno.test("isWriteQuery - UPDATE is a write", () => {
  assertEquals(
    isWriteQuery(
      parse("UPDATE User FILTER .id = <uuid>$id SET { name := 'bob' }"),
    ),
    true,
  );
});

Deno.test("isWriteQuery - DELETE is a write", () => {
  assertEquals(
    isWriteQuery(parse("DELETE User FILTER .id = <uuid>$id")),
    true,
  );
});

Deno.test("isWriteQuery - CONFIGURE SESSION is a read (session-local)", () => {
  assertEquals(
    isWriteQuery(parse("CONFIGURE SESSION SET foo := 1")),
    false,
  );
});

Deno.test("isWriteQuery - CONFIGURE DATABASE is a write", () => {
  assertEquals(
    isWriteQuery(parse("CONFIGURE DATABASE SET foo := 1")),
    true,
  );
});

Deno.test("isWriteQuery - CONFIGURE INSTANCE is a write", () => {
  assertEquals(
    isWriteQuery(parse("CONFIGURE INSTANCE SET foo := 1")),
    true,
  );
});

Deno.test("isWriteQuery - DESCRIBE TYPE is a read", () => {
  assertEquals(isWriteQuery(parse("DESCRIBE TYPE User")), false);
});

Deno.test("isWriteQuery - SET GLOBAL is a read (session-scoped)", () => {
  assertEquals(
    isWriteQuery(parse("SET GLOBAL current_user := <uuid>$id")),
    false,
  );
});

Deno.test("isWriteQuery - unknown kind defaults to write (fail closed)", () => {
  // Forge an AST with an unrecognized kind to lock in fail-closed semantics.
  const fakeAst = { kind: "BogusQuery" } as unknown as Query;
  assertEquals(isWriteQuery(fakeAst), true);
});
