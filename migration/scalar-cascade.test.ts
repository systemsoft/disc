/**
 * Tests for #8517 full impl: column wiring to `disc_enum_<name>` PG
 * types + cascade-aware operation ordering.
 *
 * The diffing layer (CreateScalar / DropScalar / AddEnumValue /
 * RecreateScalar ops) is pinned in `gel-issues.test.ts`. This file
 * covers the two pieces that make the feature usable end-to-end:
 *
 *   1. **Column wiring** — properties typed as a user-declared enum
 *      scalar emit columns of the corresponding PG enum type instead
 *      of the historical `TEXT` fallback.
 *   2. **Cascade ordering** — `CreateScalar` runs before any column
 *      referencing it; `DropScalar` / `RecreateScalar` runs after any
 *      column dependency has already been removed in the same plan.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

function parseModules(src: string) {
  const conv = new SDLConverter();
  return conv.convertToModules(new SDLParser(src).parse());
}

function diff(beforeSrc: string, afterSrc: string): Types.MigrationOperation[] {
  return new SchemaDiffer().diff(parseModules(beforeSrc), parseModules(afterSrc));
}

// ---------------------------------------------------------------------
// Piece 1 — column wiring via DDLGenerator.setEnumScalars()
// ---------------------------------------------------------------------

Deno.test("DDLGenerator without setEnumScalars: enum-typed property falls back to TEXT", () => {
  // The historical behavior — preserved for backward compat. Direct
  // callers that haven't been schema-aware get TEXT for unknown types.
  const ops = diff(
    `module default {
      scalar type Status extending enum<draft, published>;
    }`,
    `module default {
      scalar type Status extending enum<draft, published>;
      type Item { status: Status; }
    }`,
  );
  const ddl = new DDLGenerator().generateDDL(ops).join("\n");
  // The diff is just CreateType(Item) — the scalar already existed.
  // Without a registry, the status column type falls back to TEXT.
  assert(ddl.includes("status TEXT"), `expected TEXT fallback without registry; got: ${ddl}`);
  // No CREATE TYPE statement in this diff (scalar pre-existed) and
  // no column references the PG enum type.
  assert(!ddl.includes("disc_enum_status"), "no enum reference expected without registry");
});

Deno.test("DDLGenerator with setEnumScalars: enum-typed property resolves to disc_enum_<name>", () => {
  const ops = diff(
    `module default {
      scalar type Status extending enum<draft, published>;
    }`,
    `module default {
      scalar type Status extending enum<draft, published>;
      type Item { status: Status; }
    }`,
  );
  const gen = new DDLGenerator();
  gen.setEnumScalars(["Status"]);
  const ddl = gen.generateDDL(ops).join("\n");
  // `disc_enum_status` matches `^[a-z][a-z0-9_]*$` so it appears
  // unquoted. The column DDL is `<col> <type>` with whitespace
  // separator — assert the substring rather than an exact format.
  assert(
    ddl.includes("status disc_enum_status"),
    `expected column to use disc_enum_status; got: ${ddl}`,
  );
  // TEXT fallback should NOT appear for the status column.
  assertEquals(ddl.includes("status TEXT"), false);
});

Deno.test("DDLGenerator: non-enum scalar names in registry are still subject to the fallback chain", () => {
  // The registry is specifically for enum scalars (the only kind that
  // gets a PG type). Built-in names like `str` shouldn't be remapped
  // — the existing typeMap handles them first.
  const gen = new DDLGenerator();
  gen.setEnumScalars(["str"]); // misuse: built-in name in the registry
  // Trigger a column-emission path via a CreateType op.
  const ops = diff(
    "module default {}",
    "module default { type Item { name: str; } }",
  );
  const ddl = gen.generateDDL(ops).join("\n");
  // Built-in `str` still resolves to TEXT — registry is checked AFTER
  // the built-in typeMap, so the registry can't shadow real types.
  assert(ddl.includes("name TEXT"), `expected str → TEXT; got: ${ddl}`);
});

// ---------------------------------------------------------------------
// Piece 1.5 — engine-level wiring: MigrationEngine primes the registry
// from the post-state schema during planMigration.
// ---------------------------------------------------------------------

Deno.test("MigrationEngine: planMigration sets enum scalars so generated DDL uses disc_enum_<name>", () => {
  const engine = new MigrationEngine({
    migrationsDir: "",
    schemaFile: "",
    databaseUrl: "",
    dryRun: true,
    autoApprove: true,
    backupBeforeMigration: false,
    rollbackOnError: false,
  } as Types.MigrationConfig);

  const newSchema = parseModules(
    `module default {
      scalar type Status extending enum<draft, published>;
      type Article { required title: str; status: Status; }
    }`,
  );

  const planResult = engine.planMigration(null, newSchema);
  assert(planResult.ok, "expected plan to succeed");

  const ddlResult = engine.generateDDL(planResult.value);
  assert(ddlResult.ok, "expected DDL generation to succeed");
  const ddl = ddlResult.value.join("\n");

  // The enum type is created (escapeIdentifier leaves all-lowercase
  // alphanumeric+underscore identifiers unquoted)…
  assert(ddl.includes("CREATE TYPE disc_enum_status"));
  // …and the article table's column references it instead of TEXT.
  assert(
    ddl.includes("status disc_enum_status"),
    `expected disc_enum_status column type; got: ${ddl}`,
  );
});

// ---------------------------------------------------------------------
// Piece 2 — cascade-aware operation ordering
// ---------------------------------------------------------------------

Deno.test("reorderForCascade: CreateScalar comes before CreateType referencing it", () => {
  // A diff that adds both a new enum and a new type using it. Without
  // the reorder pass, the differ emits CreateType first (object types
  // are processed before scalars), which would trip PG since
  // `ADD COLUMN status disc_enum_status` requires the type to exist.
  const ops = diff(
    "module default {}",
    `module default {
      scalar type Status extending enum<draft, published>;
      type Item { status: Status; }
    }`,
  );
  const createScalarIdx = ops.findIndex((o) => o.kind === "CreateScalar");
  const createTypeIdx = ops.findIndex((o) => o.kind === "CreateType");
  assert(createScalarIdx >= 0, "expected a CreateScalar op");
  assert(createTypeIdx >= 0, "expected a CreateType op");
  assert(
    createScalarIdx < createTypeIdx,
    `expected CreateScalar (${createScalarIdx}) to come before CreateType (${createTypeIdx})`,
  );
});

Deno.test("reorderForCascade: DropScalar comes after AlterType operations referencing it", () => {
  // A diff that removes both the property and the enum it referenced.
  // The DROP COLUMN must fire before DROP TYPE so PG doesn't refuse.
  const ops = diff(
    `module default {
      scalar type Status extending enum<draft, published>;
      type Item { status: Status; }
    }`,
    "module default { type Item { } }",
  );
  const alterIdx = ops.findIndex((o) => o.kind === "AlterType");
  const dropScalarIdx = ops.findIndex((o) => o.kind === "DropScalar");
  assert(alterIdx >= 0, "expected an AlterType op (DropProperty)");
  assert(dropScalarIdx >= 0, "expected a DropScalar op");
  assert(
    alterIdx < dropScalarIdx,
    `expected AlterType (${alterIdx}) to come before DropScalar (${dropScalarIdx})`,
  );
});

Deno.test("reorderForCascade: RecreateScalar comes after object-type changes in the same migration", () => {
  // Removing an enum value (RecreateScalar reason='removed-values')
  // is destructive; the DO-block guard refuses if columns still
  // reference the type. Operators must drop/migrate dependents first
  // — we encode that ordering in the plan.
  const ops = diff(
    `module default {
      scalar type Status extending enum<draft, published, archived>;
      type Item { status: Status; }
    }`,
    `module default {
      scalar type Status extending enum<draft, published>;
      type Item { }
    }`,
  );
  const alterIdx = ops.findIndex((o) => o.kind === "AlterType");
  const recreateIdx = ops.findIndex((o) => o.kind === "RecreateScalar");
  assert(alterIdx >= 0, "expected an AlterType op");
  assert(recreateIdx >= 0, "expected a RecreateScalar op");
  assert(
    alterIdx < recreateIdx,
    `expected AlterType (${alterIdx}) to come before RecreateScalar (${recreateIdx})`,
  );
});

Deno.test("reorderForCascade: AddEnumValue groups with creates (runs before middle ops)", () => {
  // AddEnumValue is non-destructive but conceptually a "growth" op —
  // grouping with creates keeps the rule simple and avoids edge cases
  // where a future migration adds a value AND a property using the
  // already-existing enum (the property emit is in middle, value-add
  // is in creates → values are guaranteed available before the
  // column emits).
  const ops = diff(
    `module default {
      scalar type Status extending enum<draft, published>;
      type Item { name: str; }
    }`,
    `module default {
      scalar type Status extending enum<draft, published, archived>;
      type Item { name: str; status: Status; }
    }`,
  );
  const addValueIdx = ops.findIndex((o) => o.kind === "AddEnumValue");
  const alterIdx = ops.findIndex((o) => o.kind === "AlterType");
  assert(addValueIdx >= 0, "expected an AddEnumValue op");
  assert(alterIdx >= 0, "expected an AlterType op");
  assert(
    addValueIdx < alterIdx,
    `expected AddEnumValue (${addValueIdx}) to come before AlterType (${alterIdx})`,
  );
});

// ---------------------------------------------------------------------
// SchemaDiffer.enumScalarNames — used by MigrationEngine to prime
// the DDL generator's registry.
// ---------------------------------------------------------------------

Deno.test("SchemaDiffer.enumScalarNames: returns only enum-typed scalars", () => {
  const schema = parseModules(
    `module default {
      scalar type Status extending enum<draft, published>;
      scalar type Email extending str;
      type User { email: Email; status: Status; }
    }`,
  );
  const names = new SchemaDiffer().enumScalarNames(schema);
  // Both unqualified and qualified forms are present so column
  // emission resolves either property type style.
  assertEquals(names.has("Status"), true, "unqualified enum scalar should be included");
  assertEquals(names.has("default::Status"), true, "qualified enum scalar should be included");
  assertEquals(names.has("Email"), false, "non-enum scalar (extends str) should be excluded");
  assertEquals(names.has("default::Email"), false, "qualified non-enum scalar should be excluded");
});

Deno.test("SchemaDiffer.enumScalarNames: empty schema returns empty set", () => {
  const schema = parseModules("module default {}");
  const names = new SchemaDiffer().enumScalarNames(schema);
  assertEquals(names.size, 0);
});
