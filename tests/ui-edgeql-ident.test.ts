/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The UI generates EdgeQL queries from schema field/link names. A field named
 * with a reserved keyword (e.g. a link `for` from `required link \`for\` ->
 * Customer`) must be backtick-quoted, or the data viewer fails with
 * "Expected identifier, got :". `quoteIdent` is a pure helper, importable
 * straight into Deno without DOM/Svelte deps.
 */

import { assertEquals } from "@std/assert";
import {
  quoteIdent,
  RESERVED_KEYWORDS as UI_RESERVED
} from "../ui/src/lib/edgeql-ident.ts";
import { RESERVED_KEYWORDS as CANON } from "../edgeql/tokens.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";

Deno.test("quoteIdent - backtick-quotes reserved keywords, leaves others bare", () => {
  assertEquals(quoteIdent("for"), "`for`");
  assertEquals(quoteIdent("order"), "`order`");
  assertEquals(quoteIdent("name"), "name");
  assertEquals(quoteIdent("created"), "created");
  // `from` is not an EdgeQL reserved word — no quoting needed.
  assertEquals(quoteIdent("from"), "from");
});

Deno.test("quoteIdent - UI keyword set stays in sync with edgeql/tokens.ts", () => {
  assertEquals([...UI_RESERVED].sort(), [...CANON].sort());
});

Deno.test("quoteIdent - a generated shape with a `for` link parses", () => {
  // Mirrors the data viewer's buildSelect for a Session type with a
  // `required link \`for\` -> Customer` link.
  const fields = ["id", "token", `${quoteIdent("for")}: { id }`];
  const query = `select Session { ${fields.join(", ")} }`;
  // Must not throw "Expected identifier, got :".
  new EdgeQLParser(query).parse();

  // Filter and order paths too.
  new EdgeQLParser(`select Session filter .${quoteIdent("for")}.id = <uuid>$x`)
    .parse();
  new EdgeQLParser(`select Session { id } order by .${quoteIdent("for")}`)
    .parse();
});
