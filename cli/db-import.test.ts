/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stage 1 tests for `disc db import` — filename parsing + schema-aware
 * classification. Uses a hardcoded fixture Schema modelling a synthetic
 * "library" domain export (object files, junction files, abstract types, and
 * computed links across three modules); no DB connection or disk access (the
 * empty-checker is stubbed).
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertThrows } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { DbImport, extractTupleFields, type ObjectPlan } from "./db-import.ts";
import { typeNameToTableName } from "../lib/identifiers.ts";

import type { CLIArgs } from "./commands.ts";
import type { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";

interface LinkSpec {
  computed?: boolean;
  multi?: boolean;
  name: string;
}

/*** The synthetic library export listing. ***/
const FILE_NAMES: string[] = [
  "api_ApiKey.csv",
  "logger_Event.csv",
  "public_Author.csv",
  "public_Author.followers.csv",
  "public_Author.friends.csv",
  "public_Author.shelves.csv",
  "public_Base.csv",
  "public_Book.csv",
  "public_Book.labels.csv",
  "public_Document.csv",
  "public_Label.csv",
  "public_Note.csv",
  "public_Note.mentions.csv",
  "public_Note.replies.csv",
  "public_Shelf.books.csv",
  "public_Shelf.csv",
  "public_Shelf.curators.csv",
  "public_Shelf.tags.csv"
];

/*** RUNTIME ------------------------------------------ ***/

Deno.test("parseFileName splits module / type / link", () => {
  const importer = makeImporter();

  assertEquals(importer.parseFileName("public_Author.csv"), {
    linkName: null,
    module: "public",
    typeName: "Author"
  });

  assertEquals(importer.parseFileName("public_Shelf.books.csv"), {
    linkName: "books",
    module: "public",
    typeName: "Shelf"
  });

  assertEquals(importer.parseFileName("api_ApiKey.csv"), {
    linkName: null,
    module: "api",
    typeName: "ApiKey"
  });
});

Deno.test("resolveType matches across modules by unqualified name", () => {
  const importer = makeImporter();

  assertEquals(importer.resolveType("Author")?.tableName, "author");
  assertEquals(importer.resolveType("ApiKey")?.tableName, "api_key");
  assertEquals(importer.resolveType("Event")?.tableName, "event");
  assertEquals(importer.resolveType("Nonexistent"), undefined);
});

Deno.test("classify buckets the full library export with zero errors", async () => {
  const importer = makeImporter();
  /*** Stub the empty-checker: only Note.mentions is treated as empty. ***/
  const manifest = await importer.classify(FILE_NAMES, name => name === "public_Note.mentions.csv");

  assertEquals(manifest.errors, []);

  /*** Abstract types skipped. ***/
  const abstractSkips = manifest
    .skipped
    .filter(s => s.reason.startsWith("abstract:"))
    .map(s => s.fileName)
    .sort();

  assertEquals(abstractSkips, ["public_Base.csv", "public_Document.csv"]);

  /*** Computed links skipped (Author.followers, Note.replies, Shelf.curators). ***/
  const computedSkips = manifest
    .skipped
    .filter(s => s.reason.startsWith("computed link:"))
    .map(s => s.fileName)
    .sort();

  assertEquals(computedSkips, [
    "public_Author.followers.csv",
    "public_Note.replies.csv",
    "public_Shelf.curators.csv"
  ]);

  /*** Object file → table mapping (spot checks). ***/
  const objByName = new Map(manifest.objectFiles.map(o => [o.fileName, o]));
  assertEquals(objByName.get("public_Author.csv")?.tableName, "author");
  assertEquals(objByName.get("public_Book.csv")?.tableName, "book");
  assertEquals(objByName.get("public_Label.csv")?.tableName, "label");
  assertEquals(objByName.get("api_ApiKey.csv")?.tableName, typeNameToTableName("ApiKey"));
  assertEquals(objByName.get("logger_Event.csv")?.tableName, "event");

  /*** Link file → junction-table mapping (spot checks). ***/
  const linkByName = new Map(manifest.linkFiles.map(l => [l.fileName, l]));
  assertEquals(linkByName.get("public_Shelf.books.csv")?.junctionTable, "shelf_books");
  assertEquals(linkByName.get("public_Book.labels.csv")?.junctionTable, "book_labels");
  assertEquals(linkByName.get("public_Author.friends.csv")?.junctionTable, "author_friends");
  assertEquals(linkByName.get("public_Shelf.books.csv")?.junctionSourceColumn, "source_id");

  /*** Empty link file flagged. ***/
  assertEquals(linkByName.get("public_Note.mentions.csv")?.empty, true);
  assertEquals(linkByName.get("public_Shelf.books.csv")?.empty, false);

  /*** Counts: 7 object files (5 default + 2 other modules), 6 link files
       (Author 2, Book 1, Note 1, Shelf 2), 5 skips (2 abstract + 3 computed).
       7 + 6 + 5 = 18. ***/
  assertEquals(manifest.objectFiles.length, 7);
  assertEquals(manifest.linkFiles.length, 6);
  assertEquals(manifest.skipped.length, 5);
});

Deno.test("classify reports unknown type as error", async () => {
  const importer = makeImporter();
  const manifest = await importer.classify(["public_Ghost.csv"], () => false);

  assertEquals(manifest.errors.length, 1);
  assertEquals(manifest.errors[0].reason, "unknown type \"Ghost\"");
});

Deno.test("classify reports unknown link as error", async () => {
  const importer = makeImporter();
  const manifest = await importer.classify(["public_Author.ghostlink.csv"], () => false);

  assertEquals(manifest.errors.length, 1);
  assertEquals(manifest.errors[0].reason, "unknown link \"Author.ghostlink\"");
});

/*** STAGE 3/4 — column plan, topo sort, tuple fields ----------- ***/

Deno.test("buildColumnPlan drops __type__, maps author_id FK, builds tupleFields", () => {
  const importer = fkImporter();
  const book = importer.resolveType("Book")!;
  const header = ["id", "__type__", "title", "rating", "source", "author_id", "shelf_id", "bogus"];

  const plan = importer.buildColumnPlan(book, header, "public_Book.csv");

  const byColumn = new Map(plan.map(c => [c.columnName, c]));

  /*** __type__ and unmatched `bogus` are dropped. ***/
  assertEquals(plan.some(c => c.columnName === "bogus"), false);
  assertEquals(plan.length, 5);

  /*** id matches no property in this fixture → dropped (warned). The
       remaining columns are the matched ones. ***/
  assertEquals(byColumn.has("title"), true);
  assertEquals(byColumn.get("rating")?.typeInfo.type, "float64");

  /*** Single-link header `author_id` → FK column `author_id`, uuid. ***/
  assertEquals(byColumn.get("author_id")?.typeInfo.type, "uuid");
  assertEquals(byColumn.get("shelf_id")?.typeInfo.type, "uuid");

  /*** Tuple property carries ordered field names. ***/
  assertEquals(byColumn.get("source")?.typeInfo.type, "tuple<name: str, url: str>");
  assertEquals(byColumn.get("source")?.typeInfo.tupleFields, ["name", "url"]);
});

Deno.test("topoSortObjectTables orders FK targets before sources", () => {
  const importer = fkImporter();

  const makePlan = (typeName: string, tableName: string): ObjectPlan => ({
    columns: [],
    dataRows: [],
    fileName: `public_${typeName}.csv`,
    tableName,
    typeName
  });

  const plans = new Map<string, ObjectPlan>([
    ["book", makePlan("Book", "book")],
    ["author", makePlan("Author", "author")],
    ["shelf", makePlan("Shelf", "shelf")]
  ]);

  const order = importer.topoSortObjectTables(plans);

  /*** author and shelf (FK targets) must precede book. ***/
  assertEquals(order.indexOf("author") < order.indexOf("book"), true);
  assertEquals(order.indexOf("shelf") < order.indexOf("book"), true);
  assertEquals(order.length, 3);
});

Deno.test("topoSortObjectTables throws on a single-link FK cycle", () => {
  /*** A --x--> B, B --y--> A (both single links). ***/
  const types = new Map<string, TypeDef>();

  types.set("A", {
    kind: "object",
    links: new Map([["x", singleLink("x", "B")]]),
    name: "A",
    properties: new Map(),
    tableName: "a"
  });

  types.set("B", {
    kind: "object",
    links: new Map([["y", singleLink("y", "A")]]),
    name: "B",
    properties: new Map(),
    tableName: "b"
  });

  const args = { _: [] } as CLIArgs;
  const importer = new DbImport({ types, functions: new Map() }, {} as never, "/fake", args);

  const makePlan = (typeName: string, tableName: string): ObjectPlan => ({
    columns: [],
    dataRows: [],
    fileName: `public_${typeName}.csv`,
    tableName,
    typeName
  });

  const plans = new Map<string, ObjectPlan>([
    ["a", makePlan("A", "a")],
    ["b", makePlan("B", "b")]
  ]);

  assertThrows(() => importer.topoSortObjectTables(plans), Error, "cycle detected");
});

Deno.test("topoSortObjectTables tolerates a self-referential single link", () => {
  /*** Node --parent--> Node: intra-table, must NOT be treated as a cycle. ***/
  const types = new Map<string, TypeDef>();

  types.set("Node", {
    kind: "object",
    links: new Map([["parent", singleLink("parent", "Node")]]),
    name: "Node",
    properties: new Map(),
    tableName: "node"
  });

  const args = { _: [] } as CLIArgs;
  const importer = new DbImport({ types, functions: new Map() }, {} as never, "/fake", args);

  const plans = new Map<string, ObjectPlan>([
    ["node", {
      columns: [],
      dataRows: [],
      fileName: "public_Node.csv",
      tableName: "node",
      typeName: "Node"
    }]
  ]);

  assertEquals(importer.topoSortObjectTables(plans), ["node"]);
});

Deno.test("extractTupleFields parses named and array-wrapped tuples", () => {
  assertEquals(extractTupleFields("tuple<name: str, url: str>"), ["name", "url"]);
  assertEquals(extractTupleFields("array<tuple<name: str, url: str>>"), ["name", "url"]);
  /*** Unnamed tuple falls back to positional field names. ***/
  assertEquals(extractTupleFields("tuple<str, str>"), ["f0", "f1"]);
  /*** Nested generic inside a field type does not break the split. ***/
  assertEquals(extractTupleFields("tuple<id: uuid, tags: array<str>>"), ["id", "tags"]);
});

/*** HELPER ------------------------------------------- ***/

function fkImporter(): DbImport {
  const args = { _: [] } as CLIArgs;
  return new DbImport(makeFkSchema(), {} as never, "/fake/dir", args);
}

/** Schema: Book --author--> Author, Book --shelf--> Shelf. */
function makeFkSchema(): Schema {
  const types = new Map<string, TypeDef>();

  types.set("Author", {
    kind: "object",
    links: new Map(),
    name: "Author",
    properties: new Map([["handle", prop("handle", "str", { required: true })]]),
    tableName: "author"
  });

  types.set("Shelf", {
    kind: "object",
    links: new Map(),
    name: "Shelf",
    properties: new Map(),
    tableName: "shelf"
  });

  types.set("Book", {
    kind: "object",
    links: new Map<string, LinkDef>([
      ["author", singleLink("author", "Author")],
      ["shelf", singleLink("shelf", "Shelf")]
    ]),
    name: "Book",
    properties: new Map<string, PropertyDef>([
      ["title", prop("title", "str")],
      ["rating", prop("rating", "float64")],
      ["source", prop("source", "tuple<name: str, url: str>")]
    ]),
    tableName: "book"
  });

  return { functions: new Map(), types };
}

function makeImporter(): DbImport {
  /*** pool is never touched during classification; cast a stub. ***/
  const args = { _: [] } as CLIArgs;
  return new DbImport(makeSchema(), {} as never, "/fake/dir", args);
}

/*** Fixture schema: every type referenced by the export listing. The module
     prefix in filenames (public/api/logger) is a disambiguator only — keys here
     mirror modulesToSchema: bare name for `default`, `module::Name` otherwise. ***/
function makeSchema(): Schema {
  const types = new Map<string, TypeDef>();

  const add = (key: string, def: TypeDef): void => {
    types.set(key, def);
  };

  add("Base", makeType("Base", { abstract: true }));
  add("Document", makeType("Document", { abstract: true }));

  add(
    "Author",
    makeType("Author", {
      links: [
        { name: "followers", multi: true, computed: true },
        { name: "friends", multi: true },
        { name: "shelves", multi: true }
      ]
    })
  );

  add(
    "Book",
    makeType("Book", {
      links: [{ name: "labels", multi: true }]
    })
  );

  add("Label", makeType("Label"));

  add(
    "Note",
    makeType("Note", {
      links: [
        { name: "mentions", multi: true },
        { name: "replies", multi: true, computed: true }
      ]
    })
  );

  add(
    "Shelf",
    makeType("Shelf", {
      links: [
        { name: "books", multi: true },
        { name: "curators", multi: true, computed: true },
        { name: "tags", multi: true }
      ]
    })
  );

  /*** Non-default modules: keyed `module::Name`. ***/
  add("api::ApiKey", makeType("ApiKey"));
  add("logger::Event", makeType("Event"));

  return {
    functions: new Map(),
    types
  };
}

function makeType(
  name: string,
  opts: { abstract?: boolean; links?: LinkSpec[]; } = {}
): TypeDef {
  const links = new Map<string, LinkDef>();

  for (const spec of opts.links ?? []) {
    links.set(spec.name, {
      computed: spec.computed ?? false,
      junctionTable: spec.multi && !spec.computed ?
        `${table(name)}_${table(spec.name)}` :
        undefined,
      multi: spec.multi ?? false,
      name: spec.name,
      required: false,
      target: "Unknown"
    });
  }

  return {
    abstract: opts.abstract ?? false,
    kind: "object",
    links,
    name,
    properties: new Map<string, PropertyDef>(),
    tableName: table(name)
  };
}

function prop(
  name: string,
  type: string,
  opts: { columnName?: string; hasDefault?: boolean; required?: boolean; } = {}
): PropertyDef {
  return {
    columnName: opts.columnName ?? table(name),
    edgeqlType: type,
    hasDefault: opts.hasDefault ?? false,
    multi: false,
    name,
    required: opts.required ?? false,
    type
  };
}

function singleLink(name: string, target: string): LinkDef {
  return {
    columnName: `${table(name)}_id`,
    multi: false,
    name,
    required: false,
    target
  };
}

function table(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
