/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Type references and Gel's path scoping:
 *
 * - The subject of a select, update or delete is bound in its filter, order
 *   by and shape (Gel docs, "Path scoping": "if the subject is a path,
 *   optionally with shapes applied to it, the path will be bound in FILTER
 *   and ORDER BY clauses"; "When applying a shape to a path … the path will
 *   be bound inside computed pointers in that shape"). `Item` of
 *   `select Item.name filter Item.id in …` is the current item, and so is
 *   `Item` in `select Item { n := count(Item) }` (1). `detached Item` is
 *   every item again.
 * - A select of a path through links (`select Cart.items`) binds the path.
 *   Its start (`Cart.code`) or a step between named in the filter, order by
 *   or shape is Gel's InvalidReferenceError, "reference to 'Cart.code'
 *   changes the interpretation of 'Cart' elsewhere in the query" (Gel 7.1,
 *   with and without `future simple_scoping`); `detached Cart` and a
 *   backlink (`.<items[is Cart]`) are how Gel names them.
 * - Any other type is the set of its objects: `count(Item)` counts every
 *   item (not the outer rows), `x in Item` reads the ids of every item, and
 *   a computed `x := (select Item { name })` is an array.
 * - `in` a path to several objects or values from a `with` binding, a `for`
 *   variable or a mutation's result (`n in o.items.name`) reads the path's
 *   set.
 *
 * Real-PG coverage: `compiler/pg-type-reference-scope.test.ts`.
 */

import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError, InvalidReferenceError } from "../lib/errors.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Item {
    required name: str;
    price: int64;
  }
  type Cart {
    required code: str;
    best: Item;
    multi items: Item;
  }
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

  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

/*** The line and column of the compile error `edgeql` fails with. ***/
function errorLocation(edgeql: string): [number | undefined, number | undefined] {
  const error = assertThrows(() => compile(edgeql), CompilationError);
  return [error.context?.location?.line, error.context?.location?.column];
}

// ── another type in a shape or a filter is all of its objects ────────────

Deno.test("an aggregate of another type in a shape counts all of its objects, not the outer rows", () => {
  const sql = compile("select Cart { code, n := count(Item) }");

  assertMatch(sql, /'n', \(SELECT COUNT\(\*\) FROM \(SELECT jsonb_build_object\('id', item_\d+\.id\) FROM item AS item_\d+\) AS __set\)/);
  assertEquals(/'n', COUNT\(\*\)/.test(sql), false);
  assertStringIncludes(compile("select Cart { s := sum(Item.price) }"), "COALESCE(SUM(__set.value), 0)");
  assertMatch(compile("select Cart { e := exists Item }"), /'e', EXISTS \(SELECT jsonb_build_object\('id', item_\d+\.id\) FROM item AS item_\d+\)/);
});

Deno.test("an aggregate of another type in a filter is a subquery, not an aggregate over the filtered rows", () => {
  const sql = compile("select Cart { code } filter count(Item) > 2");

  assertMatch(sql, /WHERE \(SELECT COUNT\(\*\) FROM \(SELECT .* FROM item AS item_\d+\) AS __set\) > 2$/);
});

Deno.test("select count of a type counts its objects once, without a FROM of its own", () => {
  assertMatch(
    compile("select count(Item)"),
    /^SELECT \(SELECT COUNT\(\*\) FROM \(SELECT jsonb_build_object\('id', item_\d+\.id\) FROM item AS item_\d+\) AS __set\)$/
  );
});

Deno.test("a computed select of another type's objects is an array, unless it keeps at most one", () => {
  assertMatch(
    compile("select Cart { x := (select Item { name }) }"),
    /'x', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT jsonb_build_object\('name', item_\d+\.name\) FROM item AS item_\d+\) AS __agg\(v\)\)/
  );
  // A bare type is its objects' ids, as a stored multi link is; with a shape, the shape.
  assertStringIncludes(compile("select Cart { x := Item }"), "jsonb_agg(__agg.v -> 'id')");
  assertStringIncludes(compile("select Cart { x := Item { name } }"), "COALESCE(jsonb_agg(__agg.v), '[]'::jsonb)");
  // `limit 1` and a filter on `.id` keep at most one: one object, as a
  // single link is — `[{ … }]` or null, no `[]`.
  for (const one of ["(select Item { name } limit 1)", "(select Item { name } filter .id = <uuid>$id)"]) {
    const sql = compile(`select Cart { x := ${one} }`);
    assertStringIncludes(sql, "'x', (SELECT jsonb_agg(__agg.v) FROM");
    assertEquals(sql.includes("'[]'::jsonb"), false, sql);
  }
});

Deno.test("select of a select is the inner select's rows, not one scalar subquery", () => {
  assertMatch(compile("select (select Item.name)"), /^SELECT __sub_\d+\.\* FROM \(SELECT item_\d+\.name FROM item AS item_\d+\) AS __sub_\d+$/);
});

// ── the subject is bound in its filter, order by and shape ───────────────

Deno.test("select of a type's property: the type named in the filter and order by is the current object", () => {
  const sql = compile("select Item.name filter Item.id in {<uuid>$a, <uuid>$b} order by Item.price");

  assertMatch(sql, /^SELECT item_(\d+)\.name FROM item AS item_\1 WHERE item_\1\.id IN \(CAST\(\$1 AS uuid\), CAST\(\$2 AS uuid\)\) ORDER BY item_\1\.price/);
  assertMatch(compile("select Item.name filter Item.name != 'a'"), /WHERE item_(\d+)\.name != 'a'$/);
  // Parenthesised, the same select.
  assertMatch(compile("select (select Item.name filter Item.price > 1)"), /WHERE item_(\d+)\.price > 1\) AS __sub_\d+$/);
});

Deno.test("select of a type: the type named in the filter, order by and shape is the current object", () => {
  const sql = compile("select Item { name, n := count(Item), up := str_upper(Item.name) } filter Item.price > 1 order by Item.name");

  assertMatch(sql, /'n', \(SELECT COUNT\(\*\) FROM \(SELECT jsonb_build_object\('id', item_(\d+)\.id\)\) AS __set\)/);
  assertMatch(sql, /'up', UPPER\(item_\d+\.name\)/);
  assertMatch(sql, /WHERE item_\d+\.price > 1 ORDER BY item_\d+\.name/);
  // A nested select of the subject is the current object too (Gel's nested-scope factoring).
  assertMatch(compile("select Item { x := (select Item.name) }"), /^SELECT jsonb_build_object\('x', \(SELECT item_(\d+)\.name\)\) FROM item AS item_\1$/);
});

Deno.test("detached: the subject's type is every object again", () => {
  assertMatch(compile("select Item { m := count(detached Item) }"), /'m', \(SELECT COUNT\(\*\) FROM \(SELECT .* FROM item AS item_\d+\) AS __set\)/);
  const sql = compile("select Item { others := (select detached Item { name } filter .name != Item.name) }");
  assertMatch(sql, /FROM item AS item_(\d+) WHERE item_\1\.name != item_1\.name/);
});

Deno.test("update and delete: the type named in the filter and set is the updated or deleted object", () => {
  assertStringIncludes(
    compile("update Item filter Item.name = 'a' set { price := Item.price + 1 }"),
    "UPDATE item SET price = item.price + 1 WHERE item.name = 'a'"
  );
  assertStringIncludes(compile("delete Item filter Item.name = 'a'"), "DELETE FROM item WHERE item.name = 'a'");
});

Deno.test("select of a path through links: the path is bound in the filter, order by and shape", () => {
  assertMatch(
    compile("select Cart.items.name filter Cart.items.price > 1"),
    /^SELECT item_(\d+)\.name FROM item AS item_\1 WHERE .* AND \(item_\1\.price > 1\)$/
  );
  assertMatch(
    compile("select Cart.items { name, n := Cart.items.name } order by Cart.items.name"),
    /'n', item_(\d+)\.name\) .* ORDER BY item_\1\.name ASC NULLS FIRST$/
  );
});

Deno.test("select of a path through links: its start or a step between named in the filter, order by or shape is Gel's error", () => {
  const message = "reference to 'Cart.code' changes the interpretation of 'Cart' elsewhere in the query";
  assertThrows(() => compile("select Cart.items { name } filter Cart.code = 'o1'"), InvalidReferenceError, message);
  assertEquals(errorLocation("select Cart.items { name } filter Cart.code = 'o1'"), [1, 35]);
  assertThrows(() => compile("select Cart.items.name filter Cart.code = 'o1'"), InvalidReferenceError, message);
  assertThrows(() => compile("select Cart.items { name } order by Cart.code"), InvalidReferenceError, message);
  assertEquals(errorLocation("select Cart.items { name } order by Cart.code"), [1, 37]);
  assertThrows(() => compile("select Cart.items { name, c := Cart.code }"), InvalidReferenceError, message);
  assertEquals(errorLocation("select Cart.items { name, c := Cart.code }"), [1, 32]);
  // The start alone, inside a nested select, or from a `with` binding.
  assertThrows(
    () => compile("select Cart.items { name, c := count(Cart) }"),
    InvalidReferenceError,
    "reference to 'Cart' changes the interpretation of 'Cart' elsewhere in the query"
  );
  assertThrows(() => compile("select Cart.items { name, c := (select Cart.code) }"), InvalidReferenceError, message);
  assertThrows(() => compile("select Cart.items { name } filter exists (select Cart filter .code = 'o1')"), InvalidReferenceError, "reference to 'Cart'");
  assertThrows(
    () => compile("with o := Cart select o.items.name filter o.code = 'o1'"),
    InvalidReferenceError,
    "reference to 'o.code' changes the interpretation of 'o' elsewhere in the query"
  );
  // `detached` is every cart again; a backlink reaches the carts of each item.
  assertMatch(
    compile("select Cart.items { name, c := count(detached Cart) }"),
    /'c', \(SELECT COUNT\(\*\) FROM \(SELECT jsonb_build_object\('id', cart_\d+\.id\) FROM cart AS cart_\d+\) AS __set\)/
  );
  assertStringIncludes(compile("select Cart.items { name, c := .<items[is Cart].code }"), "'c', ");
  // A `for` variable is one cart: naming it is not a change of interpretation.
  assertStringIncludes(compile("for o in Cart union (select o.items { name, c := o.code } filter o.code = 'o1')"), "'c', for_iter_");
});

// ── membership in a type or a path's set ─────────────────────────────────

Deno.test("membership in a type reads its objects' ids", () => {
  assertMatch(compile("select Cart { code } filter .best in Item"), /WHERE cart_\d+\.best_id IN \(SELECT item_\d+\.id FROM item AS item_\d+\)$/);
  assertMatch(
    compile("with o := (select Cart filter .code = 'x') select o { code } filter o not in Cart"),
    /NOT IN \(SELECT cart_\d+\.id FROM cart AS cart_\d+\)$/
  );
  // The bound subject is one object: `in` it is `=`.
  assertMatch(compile("select Cart { code } filter Cart not in Cart"), /WHERE cart_(\d+)\.id <> cart_\1\.id$/);
});

Deno.test("membership in a multi path from a with binding, a for variable or a mutation's result reads the path's set", () => {
  assertMatch(
    compile("with o := (select Cart filter .code = 'x') select Item { name } filter .name in o.items.name"),
    /WHERE item_\d+\.name IN \(SELECT item_\d+\.name FROM item AS item_\d+ WHERE item_\d+\.id IN \(SELECT __j_items_\d+\.target_id FROM cart_items AS __j_items_\d+ WHERE __j_items_\d+\.source_id IN \(SELECT o_\d+\.id FROM o AS o_\d+\)\)\)$/
  );
  assertStringIncludes(compile("with o := (select Cart filter .code = 'x') select Item { name } filter Item in o.items"), "IN (SELECT item_");
  assertStringIncludes(compile("for o in Cart union (select Item { name } filter .name in o.items.name)"), "IN (SELECT item_");
  assertStringIncludes(
    compile("with m := (update Cart filter .code = 'x' set { code := 'y' }) select Item { name } filter .name in m.items.name"),
    "IN (SELECT item_"
  );
});

Deno.test("a type as one value elsewhere is a compile error with its location, not `*`", () => {
  assertThrows(() => compile("select Cart { x := Item = Item }"), CompilationError, "'Item' is the set of all its objects");
  assertEquals(errorLocation("select Cart { x := Item = Item }"), [1, 20]);
});
