/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for index diff detection on existing types.
 *
 * The differ must emit CreateIndex/DropIndex when an `index on (...)` is
 * added to, removed from, or changed on an already-existing type. A changed
 * definition is a drop + create. Unchanged indexes produce no operations.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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
