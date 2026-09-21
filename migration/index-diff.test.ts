/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for index diff detection on existing types.
 *
 * The differ must emit CreateIndex/DropIndex when an `index on (...)` is
 * added to, removed from, or changed on an already-existing type. A changed
 * definition is a drop + create. Unchanged indexes produce no operations.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { Module } from "../schema/converter.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import * as Types from "./types.ts";

/** Build a single-module schema with one `User` type carrying `members`. */
function userSchema(members: unknown[]): Module[] {
  return [
    {
      name: "default",
      items: [
        {
          kind: "TypeDeclaration",
          name: { kind: "Identifier", value: "User" },
          // deno-lint-ignore no-explicit-any
          members: members as any
        }
      ]
    }
  ] as Module[];
}

const emailProp = {
  kind: "PropertyDeclaration",
  name: { kind: "Identifier", value: "email" },
  type: { kind: "TypeRef", name: { kind: "QualifiedName", parts: ["str"] } },
  required: true,
  multi: false
};

const nameProp = {
  kind: "PropertyDeclaration",
  name: { kind: "Identifier", value: "name" },
  type: { kind: "TypeRef", name: { kind: "QualifiedName", parts: ["str"] } },
  required: false,
  multi: false
};

/** `index on (.email)` */
function emailIndex(): unknown {
  return {
    kind: "Index",
    on: { kind: "PathExpression", path: [".email"] }
  };
}

/** `index on ((.email, .name))` */
function compositeIndex(): unknown {
  return {
    kind: "Index",
    on: {
      kind: "TupleExpression",
      elements: [
        { kind: "PathExpression", path: [".email"] },
        { kind: "PathExpression", path: [".name"] }
      ]
    }
  };
}

Deno.test("adding an index to an existing type emits CreateIndex", () => {
  const differ = new SchemaDiffer();
  const oldSchema = userSchema([emailProp, nameProp]);
  const newSchema = userSchema([emailProp, nameProp, emailIndex()]);

  const ops = differ.diff(oldSchema, newSchema);
  const createIndexOps = ops.filter(
    (op): op is Types.CreateIndexOperation => op.kind === "CreateIndex"
  );

  assertEquals(createIndexOps.length, 1);
  const index = createIndexOps[0].index;
  assertEquals(index.table, "user");
  assertEquals(index.columns, ["email"]);
  assertEquals(index.unique, false);
  assertEquals(index.name, "idx_user_email");

  // DDL is a standalone CREATE INDEX targeting the type's table. Only the
  // reserved keyword `user` is quoted; lowercase snake_case identifiers
  // (the index name and column) are emitted bare by `escapeIdentifier`.
  const ddl = new DDLGenerator().generateDDL(ops).join("\n");
  assertStringIncludes(ddl, `CREATE INDEX idx_user_email ON "user" (email);`);
});

Deno.test("removing an index from an existing type emits DropIndex", () => {
  const differ = new SchemaDiffer();
  const oldSchema = userSchema([emailProp, nameProp, emailIndex()]);
  const newSchema = userSchema([emailProp, nameProp]);

  const ops = differ.diff(oldSchema, newSchema);
  const dropIndexOps = ops.filter(
    (op): op is Types.DropIndexOperation => op.kind === "DropIndex"
  );

  assertEquals(dropIndexOps.length, 1);
  assertEquals(dropIndexOps[0].indexName, "idx_user_email");

  const ddl = new DDLGenerator().generateDDL(ops).join("\n");
  assertStringIncludes(ddl, `DROP INDEX IF EXISTS idx_user_email;`);
});

Deno.test("changing an index definition emits drop + create", () => {
  const differ = new SchemaDiffer();
  // Same (unnamed) index slot, but the column set changes from (.email)
  // to the composite (.email, .name). Because the unnamed index name is
  // derived from its columns, the names also differ — so this is a drop
  // of the old single-column index and a create of the new composite one.
  const oldSchema = userSchema([emailProp, nameProp, emailIndex()]);
  const newSchema = userSchema([emailProp, nameProp, compositeIndex()]);

  const ops = differ.diff(oldSchema, newSchema);
  const drops = ops.filter(op => op.kind === "DropIndex");
  const creates = ops.filter(op => op.kind === "CreateIndex");

  assertEquals(drops.length, 1);
  assertEquals(creates.length, 1);
  assertEquals(
    (drops[0] as Types.DropIndexOperation).indexName,
    "idx_user_email"
  );
  const created = (creates[0] as Types.CreateIndexOperation).index;
  assertEquals(created.columns, ["email", "name"]);
  assertEquals(created.name, "idx_user_email_name");

  const ddl = new DDLGenerator().generateDDL(ops).join("\n");
  assertStringIncludes(ddl, `DROP INDEX IF EXISTS idx_user_email;`);
  assertStringIncludes(
    ddl,
    `CREATE INDEX idx_user_email_name ON "user" (email, name);`
  );
});

Deno.test("unchanged index emits no index operations (idempotent diff)", () => {
  const differ = new SchemaDiffer();
  const oldSchema = userSchema([emailProp, nameProp, emailIndex()]);
  const newSchema = userSchema([emailProp, nameProp, emailIndex()]);

  const ops = differ.diff(oldSchema, newSchema);
  const indexOps = ops.filter(
    op => op.kind === "CreateIndex" || op.kind === "DropIndex"
  );

  assertEquals(indexOps.length, 0);
});

Deno.test("named index is keyed and dropped by its declared name", () => {
  const differ = new SchemaDiffer();
  const named = {
    kind: "Index",
    name: { kind: "Identifier", value: "user_email_idx" },
    on: { kind: "PathExpression", path: [".email"] }
  };
  const oldSchema = userSchema([emailProp, nameProp, named]);
  const newSchema = userSchema([emailProp, nameProp]);

  const ops = differ.diff(oldSchema, newSchema);
  const drops = ops.filter(
    (op): op is Types.DropIndexOperation => op.kind === "DropIndex"
  );

  assertEquals(drops.length, 1);
  assertEquals(drops[0].indexName, "user_email_idx");
});

/*** Type-level `constraint exclusive on (…)`, link-aware columns, and indexes on new types (D1, S8) ***/

const strType = { kind: "TypeRef", name: { kind: "QualifiedName", parts: ["str"] } };

function typeDecl(name: string, members: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { kind: "TypeDeclaration", name: { kind: "Identifier", value: name }, members, ...extra };
}

function schemaOf(...items: unknown[]): Module[] {
  return [{ name: "default", items }] as unknown as Module[];
}

function prop(name: string, extra: Record<string, unknown> = {}): unknown {
  return { kind: "PropertyDeclaration", name: { kind: "Identifier", value: name }, type: strType, required: true, multi: false, ...extra };
}

function link(name: string, target: string, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: "LinkDeclaration",
    name: { kind: "Identifier", value: name },
    target: { kind: "TypeRef", name: { kind: "QualifiedName", parts: [target] } },
    required: true,
    ...extra
  };
}

/** The parser's real shape for `.program` is `[".", "program"]`. */
function path(name: string): unknown {
  return { kind: "PathExpression", path: [".", name] };
}

function onExpr(names: string[]): unknown {
  return names.length === 1 ? path(names[0]) : { kind: "TupleExpression", elements: names.map(path) };
}

/** `constraint exclusive on ((.a, .b))` */
function exclusiveOn(...names: string[]): unknown {
  return { kind: "Constraint", name: { kind: "Identifier", value: "exclusive" }, delegated: false, on: onExpr(names) };
}

/** `index on ((.a, .b))` */
function indexOn(...names: string[]): unknown {
  return { kind: "Index", on: onExpr(names) };
}

const program = typeDecl("Program", [prop("name")]);

function gitObject(...extraMembers: unknown[]): unknown {
  return typeDecl("GitObject", [prop("object_id"), link("program", "Program"), ...extraMembers]);
}

function createIndexOps(ops: Types.MigrationOperation[]): Types.IndexDefinition[] {
  return ops.filter((op): op is Types.CreateIndexOperation => op.kind === "CreateIndex").map(op => op.index);
}

/** The physical part of each created index; the first test pins the schema-origin fields. */
function createdIndexes(ops: Types.MigrationOperation[]): Types.IndexDefinition[] {
  return createIndexOps(ops).map(({ columns, name, table, unique }) => ({ columns, name, table, unique }));
}

Deno.test("type-level exclusive on a new type emits a unique index on the FK column", () => {
  const ops = new SchemaDiffer().diff([], schemaOf(program, gitObject(exclusiveOn("program", "object_id"))));

  assertEquals(createIndexOps(ops), [{
    columns: ["program_id", "object_id"],
    declaration: "constraint exclusive on ((.program, .object_id))",
    name: "uk_git_object_program_id_object_id",
    table: "git_object",
    typeName: "GitObject",
    unique: true
  }]);

  const ddl = new DDLGenerator().generateDDL(ops);
  assertStringIncludes(ddl.join("\n"), "CREATE UNIQUE INDEX uk_git_object_program_id_object_id ON git_object (program_id, object_id);");

  /*** The index must come after its table. ***/
  const tableAt = ddl.findIndex(s => s.startsWith("CREATE TABLE git_object"));
  const indexAt = ddl.findIndex(s => s.includes("uk_git_object_program_id_object_id"));
  assertEquals(tableAt >= 0 && indexAt > tableAt, true);
});

Deno.test("type-level exclusive added to an existing type emits a unique index", () => {
  const ops = new SchemaDiffer().diff(
    schemaOf(program, gitObject()),
    schemaOf(program, gitObject(exclusiveOn("program", "object_id")))
  );

  assertEquals(ops.map(op => op.kind), ["CreateIndex"]);
  assertEquals(createIndexOps(ops)[0].unique, true);
  assertEquals(createIndexOps(ops)[0].columns, ["program_id", "object_id"]);
});

Deno.test("column order follows declaration order", () => {
  const ops = new SchemaDiffer().diff([], schemaOf(program, gitObject(exclusiveOn("object_id", "program"))));

  assertEquals(createIndexOps(ops)[0].columns, ["object_id", "program_id"]);
  assertEquals(createIndexOps(ops)[0].name, "uk_git_object_object_id_program_id");
});

Deno.test("removing a type-level exclusive drops its unique index", () => {
  const ops = new SchemaDiffer().diff(
    schemaOf(program, gitObject(exclusiveOn("program", "object_id"))),
    schemaOf(program, gitObject())
  );

  assertEquals(ops, [{ indexName: "uk_git_object_program_id_object_id", kind: "DropIndex" } as Types.DropIndexOperation]);
});

Deno.test("an unchanged type-level exclusive emits nothing", () => {
  const schema = (): Module[] => schemaOf(program, gitObject(exclusiveOn("program", "object_id")));

  assertEquals(new SchemaDiffer().diff(schema(), schema()), []);
});

Deno.test("a composite index with a link emits the FK column, on new and existing types", () => {
  const withIndex = (): Module[] => schemaOf(program, gitObject(indexOn("program", "object_id")));
  const expected = [{ columns: ["program_id", "object_id"], name: "idx_git_object_program_id_object_id", table: "git_object", unique: false }];

  const created = new SchemaDiffer().diff([], withIndex());
  assertEquals(createdIndexes(created), expected);
  assertStringIncludes(
    new DDLGenerator().generateDDL(created).join("\n"),
    "CREATE INDEX idx_git_object_program_id_object_id ON git_object (program_id, object_id);"
  );

  assertEquals(createdIndexes(new SchemaDiffer().diff(schemaOf(program, gitObject()), withIndex())), expected);
});

Deno.test("a plain index on a new type is emitted", () => {
  const ops = new SchemaDiffer().diff([], schemaOf(program, gitObject(indexOn("object_id"))));

  assertEquals(createdIndexes(ops), [{ columns: ["object_id"], name: "idx_git_object_object_id", table: "git_object", unique: false }]);
  assertEquals(createIndexOps(ops)[0].declaration, "index on (.object_id)");
});

Deno.test("index on a single link alone emits nothing: the auto FK index covers it", () => {
  const withIndex = (): Module[] => schemaOf(program, gitObject(indexOn("program")));

  const created = new SchemaDiffer().diff([], withIndex());
  assertEquals(createIndexOps(created), []);

  const ddl = new DDLGenerator().generateDDL(created).filter(s => s.includes("idx_git_object_program_id"));
  assertEquals(ddl, ["CREATE INDEX idx_git_object_program_id ON git_object (program_id);"]);

  assertEquals(new SchemaDiffer().diff(schemaOf(program, gitObject()), withIndex()), []);
});

Deno.test("a unique index on a single link is still emitted", () => {
  const ops = new SchemaDiffer().diff([], schemaOf(program, gitObject(exclusiveOn("program"))));

  assertEquals(createdIndexes(ops), [{ columns: ["program_id"], name: "uk_git_object_program_id", table: "git_object", unique: true }]);
});

Deno.test("single-column type-level exclusive adds nothing when the property is already exclusive", () => {
  const exclusiveProp = prop("object_id", { constraints: [{ kind: "Constraint", name: { kind: "Identifier", value: "exclusive" } }] });
  const schema = schemaOf(typeDecl("GitObject", [exclusiveProp, exclusiveOn("object_id")]));

  const ops = new SchemaDiffer().diff([], schema);
  assertEquals(createIndexOps(ops), []);

  const uniques = new DDLGenerator().generateDDL(ops).filter(s => s.includes("UNIQUE INDEX"));
  assertEquals(uniques, ["CREATE UNIQUE INDEX uk_git_object_object_id ON git_object (object_id);"]);
});

Deno.test("single-column type-level exclusive on a plain property emits a unique index", () => {
  const ops = new SchemaDiffer().diff([], schemaOf(typeDecl("GitObject", [prop("object_id"), exclusiveOn("object_id")])));

  assertEquals(createdIndexes(ops), [{ columns: ["object_id"], name: "uk_git_object_object_id", table: "git_object", unique: true }]);
});

Deno.test("a link inherited from a parent resolves to its FK column", () => {
  const base = typeDecl("Owned", [link("program", "Program")], { abstract: true });
  const child = typeDecl("GitRef", [prop("name"), exclusiveOn("program", "name")], {
    extending: [{ kind: "TypeRef", name: { kind: "QualifiedName", parts: ["Owned"] } }]
  });

  const ops = new SchemaDiffer().diff([], schemaOf(program, base, child));
  assertEquals(createIndexOps(ops).map(i => i.columns), [["program_id", "name"]]);
});

Deno.test("index names over 63 bytes are truncated with a hash; names that fit are untouched", () => {
  const longA = "a_really_long_property_name_for_testing_limits";
  const longB = "another_really_long_property_name_for_testing";
  const longC = "another_really_long_property_name_for_tessing";
  const members = [prop(longA), prop(longB), prop(longC), prop("short")];
  const schema = schemaOf(
    typeDecl("GitObject", [...members, exclusiveOn(longA, longB), exclusiveOn(longA, longC), indexOn(longA, longB), indexOn("short")])
  );

  const indexes = createIndexOps(new SchemaDiffer().diff([], schema));
  const [ukB, ukC, idxB, idxShort] = indexes.map(i => i.name);

  for (const name of [ukB, ukC, idxB]) {
    assertEquals(new TextEncoder().encode(name).length <= 63, true, name);
    assertEquals(/_[0-9a-f]{8}$/.test(name), true, name);
  }

  assertEquals(ukB.startsWith("uk_git_object_a_really_long"), true);
  assertEquals(idxB.startsWith("idx_git_object_a_really_long"), true);
  /*** Two names that only differ past the cut stay distinct, and the result is stable. ***/
  assertEquals(ukB === ukC, false);
  assertEquals(createIndexOps(new SchemaDiffer().diff([], schema)).map(i => i.name), [ukB, ukC, idxB, idxShort]);
  assertEquals(idxShort, "idx_git_object_short");
});

Deno.test("type-level exclusive over a multi link is a validation error", () => {
  const schema = schemaOf(program, typeDecl("Repo", [prop("name"), link("programs", "Program", { multi: true }), exclusiveOn("programs", "name")]));

  assertThrows(() => new SchemaDiffer().diff([], schema), Error, "multi link 'programs'");
});

Deno.test("index over a computed member is a validation error", () => {
  const computed = prop("slug", { computed: { kind: "PathExpression", path: [".", "name"] }, required: false });
  const schema = schemaOf(typeDecl("Repo", [prop("name"), computed, indexOn("slug", "name")]));

  assertThrows(() => new SchemaDiffer().diff([], schema), Error, "computed 'slug'");
});

Deno.test("type-level exclusive or index on a type that has subtypes is a validation error", () => {
  const extending = [{ kind: "TypeRef", name: { kind: "QualifiedName", parts: ["Content"] } }];
  const post = typeDecl("Post", [prop("body")], { extending });

  for (const member of [exclusiveOn("title"), indexOn("title")]) {
    const schema = schemaOf(typeDecl("Content", [prop("title"), member], { abstract: true }), post);
    assertThrows(() => new SchemaDiffer().diff([], schema), Error, "'Content' has subtypes");
  }
});

Deno.test("an invalid index in the stored baseline does not block the migration that removes it", () => {
  const extending = [{ kind: "TypeRef", name: { kind: "QualifiedName", parts: ["Content"] } }];
  const post = typeDecl("Post", [prop("body")], { extending });
  const oldSchema = schemaOf(typeDecl("Content", [prop("title"), indexOn("title")]), post);
  const newSchema = schemaOf(typeDecl("Content", [prop("title")]), post);

  assertEquals(new SchemaDiffer().diff(oldSchema, newSchema), [{ indexName: "idx_content_title", kind: "DropIndex" } as Types.DropIndexOperation]);
});
