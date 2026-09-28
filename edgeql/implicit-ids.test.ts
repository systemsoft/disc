/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import type * as AST from "./ast.ts";
import { withImplicitIds } from "./implicit-ids.ts";
import { EdgeQLParser } from "./parser.ts";

/*** The names a query's shapes select, outermost first (`*` a splat, `@p` a link property). ***/
function shapeNames(node: unknown): string[][] {
  const out: string[][] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") {
      return;
    }
    if ((n as { kind?: string; }).kind === "Shape") {
      out.push((n as AST.Shape).elements.map(el => el.splat ? "*" : `${el.linkProperty ? "@" : ""}${el.name?.name ?? (el.expr as AST.Identifier).name}`));
    }
    Object.values(n).forEach(visit);
  };
  visit(node);
  return out;
}

const names = (text: string): string[][] => shapeNames(withImplicitIds(new EdgeQLParser(text).parse()));

Deno.test("withImplicitIds selects id first in each output shape that doesn't", () => {
  assertEquals(names("select Author { name, books: { title, @rank }, fans := .<best[is Author] { name } }"), [
    ["id", "name", "books", "fans"],
    ["id", "title", "@rank"],
    ["id", "name"]
  ]);
  assertEquals(names("group Book { title } by .title"), [["id", "title"]]);
  assertEquals(names("with a := (select Author filter .name = 'x') select a { name }"), [["id", "name"]]);
});

Deno.test("withImplicitIds leaves shapes selecting id, splats, and mutations as they are", () => {
  assertEquals(names("select Author { id, name }"), [["id", "name"]]);
  assertEquals(names("select Book { * }"), [["*"]]);
  assertEquals(names("insert Author { name := 'x', books := (select Book { @rank := 1 }) }"), [["name", "books"], ["@rank"]]);
  assertEquals(names("update Author set { name := 'y' }"), [["name"]]);
});

Deno.test("withImplicitIds leaves the parsed query as it was", () => {
  const query = new EdgeQLParser("select Author { name }").parse();
  withImplicitIds(query);
  assertEquals(shapeNames(query), [["name"]]);
});
