/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Column types of Gel's scalar types.
 *
 * `big: bigint;` got a TEXT column — the type map had `array<bigint>` but no
 * `bigint` — so `.big / 2` failed with "operator does not exist: text /
 * integer". Every Gel scalar, every array of one and every range Gel
 * supports now has its PostgreSQL type, and so does a user scalar extending
 * one (`scalar type Count extending int64`), which fell back to TEXT too. Databases
 * migrated before keep the TEXT column while the stored schema already
 * declares the type, so the diff sees no change; `reconcileTextColumns`
 * finds those columns and a `ConvertTextColumn` operation converts them.
 *
 * Real-PG coverage lives in `migration/scalar-column-types-pg.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationEngine } from "./engine.ts";
import { reconcileColumnTypes, reconcileTextColumns } from "./reconcile.ts";
import * as Types from "./types.ts";

function parseModules(src: string) {
  return new SDLConverter().convertToModules(new SDLParser(src).parse());
}

function engine(): MigrationEngine {
  return new MigrationEngine({
    autoApprove: true,
    backupBeforeMigration: false,
    databaseUrl: "",
    dryRun: true,
    migrationsDir: "",
    rollbackOnError: false,
    schemaFile: ""
  } as Types.MigrationConfig);
}

const SCALARS = `scalar type Count extending int64;
  scalar type Money extending decimal;
  scalar type Cents extending Money;
  scalar type Email extending str;
  scalar type Status extending enum<Open, Closed>;`;

/*** The column definitions of `type Item { value: <edgeqlType>; }`'s CREATE TABLE. ***/
function columnOf(edgeqlType: string): string {
  const e = engine();
  const plan = e.planMigration(
    null,
    parseModules(`module default {
  ${SCALARS}
  type Item { value: ${edgeqlType}; };
};
module other {
  scalar type Weight extending float64;
};`)
  );
  assert(plan.ok, "expected plan to succeed");
  const statements = e.generateDDL(plan.value);
  assert(statements.ok, "expected DDL generation to succeed");
  const create = statements.value.map(s => s.replace(/\s+/g, " ")).find(s => s.startsWith("CREATE TABLE item "));
  assert(create, statements.value.join("\n"));
  const column = /\bvalue ([^,)]+(?:\[\])?)/.exec(create)?.[1];
  assert(column, create);
  return column.trim();
}

const EXPECTED: [string, string][] = [
  ["bigint", "NUMERIC"],
  ["array<duration>", "INTERVAL[]"],
  ["array<cal::relative_duration>", "INTERVAL[]"],
  ["array<cal::date_duration>", "INTERVAL[]"],
  ["range<float32>", "NUMRANGE"],
  ["array<range<int32>>", "INT4RANGE[]"],
  ["array<range<datetime>>", "TSTZRANGE[]"],
  ["array<range<cal::local_date>>", "DATERANGE[]"],
  ["array<multirange<int64>>", "INT8MULTIRANGE[]"],
  ["multirange<float32>", "NUMMULTIRANGE"],
  ["Count", "BIGINT"],
  ["Money", "DECIMAL"],
  ["Cents", "DECIMAL"],
  ["array<Money>", "NUMERIC[]"],
  ["Email", "TEXT"],
  ["Status", "disc_enum_status"],
  ["other::Weight", "DOUBLE PRECISION"]
];

for (const [edgeqlType, pgType] of EXPECTED) {
  Deno.test(`column type - ${edgeqlType} is ${pgType}`, () => {
    assertEquals(columnOf(edgeqlType), pgType);
  });
}

Deno.test("column type - a multi bigint property is a NUMERIC array", () => {
  const e = engine();
  const plan = e.planMigration(null, parseModules(`module default { type Item { multi values: bigint; }; };`));
  assert(plan.ok);
  const statements = e.generateDDL(plan.value);
  assert(statements.ok);
  assert(statements.value.some(s => s.includes("values NUMERIC[]")), statements.value.join("\n"));
});

Deno.test("SchemaDiffer.declaredColumns - stored properties and link properties with their column types", () => {
  const schema = parseModules(`module default {
  scalar type Priority extending enum<Low, High>;
  type Task {
    required title: str;
    big: bigint {
      default := 0;
    };
    tags: array<Priority>;
    multi levels: Priority;
    doubled := .big * 2;
    multi link owners -> Task {
      weight: bigint;
    };
  };
};`);
  const columns = new SchemaDiffer().declaredColumns(schema, property => `pg(${property.type}${property.multi ? "[]" : ""})`);

  assertEquals(
    columns.sort((a, b) => a.tableName.localeCompare(b.tableName) || a.columnName.localeCompare(b.columnName)),
    [
      { columnName: "big", default: 0, pgType: "pg(bigint)", propertyType: "bigint", tableName: "task" },
      { columnName: "levels", multi: true, pgType: "pg(Priority[])", propertyType: "Priority", tableName: "task" },
      { columnName: "tags", pgType: "pg(array<Priority>)", propertyType: "array<Priority>", tableName: "task" },
      { columnName: "title", pgType: "pg(str)", propertyType: "str", tableName: "task" },
      { columnName: "weight", pgType: "pg(bigint)", propertyType: "bigint", tableName: "task_owners" }
    ]
  );
});

Deno.test("reconcileTextColumns - converts only existing text columns whose declared type is not TEXT", async () => {
  const declared: Types.DeclaredColumn[] = [
    { columnName: "big", pgType: "NUMERIC", propertyType: "bigint", tableName: "item" },
    { columnName: "title", pgType: "TEXT", propertyType: "str", tableName: "item" },
    { columnName: "count", pgType: "BIGINT", propertyType: "int64", tableName: "item" },
    { columnName: "added", pgType: "NUMERIC", propertyType: "bigint", tableName: "item" },
    { columnName: "big", pgType: "NUMERIC", propertyType: "bigint", tableName: "missing" }
  ];
  const existing: Record<string, { name: string; dataType: string; }[]> = {
    item: [{ dataType: "text", name: "big" }, { dataType: "text", name: "title" }, { dataType: "bigint", name: "count" }]
  };

  const ops = await reconcileTextColumns(declared, [], async table => await Promise.resolve(existing[table] ?? null));

  assertEquals(ops, [
    { columnName: "big", kind: "ConvertTextColumn", pgType: "NUMERIC", propertyType: "bigint", tableName: "item" }
  ]);
});

Deno.test("reconcileTextColumns - converts text[] columns whose declared array type is not TEXT[]", async () => {
  const declared: Types.DeclaredColumn[] = [
    { columnName: "values", multi: true, pgType: "NUMERIC[]", propertyType: "bigint", tableName: "item" },
    { columnName: "tags", multi: true, pgType: "TEXT[]", propertyType: "str", tableName: "item" },
    { columnName: "done", multi: true, pgType: "NUMERIC[]", propertyType: "bigint", tableName: "item" },
    { columnName: "spans", pgType: "INT4RANGE[]", propertyType: "array<range<int32>>", tableName: "item" }
  ];
  const existing = [
    { dataType: "ARRAY", name: "values", udtName: "_text" },
    { dataType: "ARRAY", name: "tags", udtName: "_text" },
    { dataType: "ARRAY", name: "done", udtName: "_numeric" },
    { dataType: "ARRAY", name: "spans", udtName: "_text" }
  ];

  const ops = await reconcileTextColumns(declared, [], async () => await Promise.resolve(existing));

  assertEquals(ops, [
    { columnName: "values", fromTextArray: true, kind: "ConvertTextColumn", multi: true, pgType: "NUMERIC[]", propertyType: "bigint", tableName: "item" },
    {
      columnName: "spans",
      fromTextArray: true,
      kind: "ConvertTextColumn",
      pgType: "INT4RANGE[]",
      propertyType: "array<range<int32>>",
      tableName: "item"
    }
  ]);
});

Deno.test("reconcileTextColumns - skips columns whose type the pending migration changes", async () => {
  const declared: Types.DeclaredColumn[] = [
    { columnName: "tags", pgType: "TEXT[]", propertyType: "str", tableName: "item" },
    { columnName: "big", pgType: "NUMERIC", propertyType: "bigint", tableName: "item" },
    { columnName: "weight", pgType: "NUMERIC", propertyType: "bigint", tableName: "item_owners" },
    { columnName: "count", pgType: "BIGINT", propertyType: "int64", tableName: "item" }
  ];
  const alter: Types.AlterTypeOperation = {
    kind: "AlterType",
    operations: [
      { changes: [{ kind: "ChangeMulti", newValue: true, oldValue: false }], kind: "AlterProperty", propertyName: "tags" } as Types.AlterPropertyOperation,
      { changes: [{ kind: "ChangeType", newValue: "bigint", oldValue: "str" }], kind: "AlterProperty", propertyName: "big" } as Types.AlterPropertyOperation,
      { changes: [{ kind: "ChangeDefault", newValue: 0 }], kind: "AlterProperty", propertyName: "count" } as Types.AlterPropertyOperation,
      { changes: [], kind: "AlterLink", linkName: "owners", propertyOperations: [] } as Types.AlterLinkOperation
    ],
    typeName: "Item"
  };
  const planned: Types.MigrationOperation[] = [alter];
  const existing = new Map([
    ["item", [{ dataType: "text", name: "tags" }, { dataType: "text", name: "big" }, { dataType: "text", name: "count" }]],
    ["item_owners", [{ dataType: "text", name: "weight" }]]
  ]);

  const ops = await reconcileTextColumns(declared, planned, async table => await Promise.resolve(existing.get(table) ?? null));

  assertEquals(ops.map(op => op.columnName), ["count"]);
});

Deno.test("ConvertTextColumn - a scalar column: checks every stored value, then converts the column", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "big",
    kind: "ConvertTextColumn",
    pgType: "NUMERIC",
    propertyType: "bigint",
    tableName: "item"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assertEquals(statements.length, 2, statements.join("\n"));
  assert(statements[0].startsWith("DO $$"), statements[0]);
  assert(statements[0].includes("FROM item WHERE big IS NOT NULL"), statements[0]);
  assert(statements[0].includes("PERFORM disc_value::NUMERIC;"), statements[0]);
  assert(statements[0].includes("RAISE EXCEPTION 'Cannot convert item.big from text to bigint: stored value % is not a valid bigint"), statements[0]);
  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN big TYPE NUMERIC USING big::NUMERIC;");
});

Deno.test("ConvertTextColumn - a column with a default re-sets it for the new type", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "big",
    default: 0,
    kind: "ConvertTextColumn",
    pgType: "NUMERIC",
    propertyType: "bigint",
    tableName: "item"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assertEquals(
    statements[1],
    "ALTER TABLE item ALTER COLUMN big DROP DEFAULT, ALTER COLUMN big TYPE NUMERIC USING big::NUMERIC, ALTER COLUMN big SET DEFAULT 0;"
  );
});

Deno.test("ConvertTextColumn - an array column also rewrites JSON arrays as array literals", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "spans",
    kind: "ConvertTextColumn",
    pgType: "INTERVAL[]",
    propertyType: "array<duration>",
    tableName: "item"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assertEquals(statements.length, 3, statements.join("\n"));
  assert(statements[0].includes("stored value % is not an array of duration values"), statements[0]);
  assert(statements[1].startsWith("UPDATE item SET spans ="), statements[1]);
  assertEquals(statements[2], "ALTER TABLE item ALTER COLUMN spans TYPE INTERVAL[] USING spans::INTERVAL[];");
});

Deno.test("ConvertTextColumn - a text[] multi column: checks every stored element, then converts it and keeps the empty-set default", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "values",
    fromTextArray: true,
    kind: "ConvertTextColumn",
    multi: true,
    pgType: "NUMERIC[]",
    propertyType: "bigint",
    tableName: "item"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assertEquals(statements.length, 2, statements.join("\n"));
  assert(statements[0].includes("SELECT DISTINCT disc_element FROM item, unnest(values) AS disc_element WHERE disc_element IS NOT NULL"), statements[0]);
  assert(statements[0].includes("PERFORM disc_value::NUMERIC;"), statements[0]);
  assert(
    statements[0].includes("RAISE EXCEPTION 'Cannot convert item.values from text[] to bigint: stored value % is not a valid bigint"),
    statements[0]
  );
  assertEquals(
    statements[1],
    "ALTER TABLE item ALTER COLUMN values DROP DEFAULT, ALTER COLUMN values TYPE NUMERIC[] USING values::NUMERIC[], ALTER COLUMN values SET DEFAULT '{}';"
  );
});

Deno.test("ConvertTextColumn - a text[] array<range> column checks elements against the range type", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "spans",
    fromTextArray: true,
    kind: "ConvertTextColumn",
    pgType: "INT4RANGE[]",
    propertyType: "array<range<int32>>",
    tableName: "item"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assert(statements[0].includes("PERFORM disc_value::INT4RANGE;"), statements[0]);
  assert(statements[0].includes("stored value % is not a valid range<int32>"), statements[0]);
  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN spans TYPE INT4RANGE[] USING spans::INT4RANGE[];");
});

Deno.test("ConvertTextColumn - rollback returns a text[] column to text[]", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "values",
    fromTextArray: true,
    kind: "ConvertTextColumn",
    multi: true,
    pgType: "NUMERIC[]",
    propertyType: "bigint",
    tableName: "item"
  };

  assertEquals(new DDLGenerator().generateRollbackDDL([op]), [
    "ALTER TABLE item ALTER COLUMN values DROP DEFAULT, ALTER COLUMN values TYPE TEXT[] USING values::text[], ALTER COLUMN values SET DEFAULT '{}';"
  ]);
});

Deno.test("ConvertTextColumn - rollback returns the column to text", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "big",
    kind: "ConvertTextColumn",
    pgType: "NUMERIC",
    propertyType: "bigint",
    tableName: "item"
  };

  assertEquals(new DDLGenerator().generateRollbackDDL([op]), ["ALTER TABLE item ALTER COLUMN big TYPE TEXT USING big::text;"]);
});

Deno.test("a bare scalar name resolves in the property's module before default, through a chain of that module's scalars", () => {
  const e = engine();
  const plan = e.planMigration(
    null,
    parseModules(`module default {
  scalar type Money extending decimal;
  scalar type Cents extending str;
};
module ledger {
  scalar type Money extending int64;
  scalar type Cents extending Money;
  type Entry { amount: Cents; amounts: array<Cents>; };
};`)
  );
  assert(plan.ok, "expected plan to succeed");
  const statements = e.generateDDL(plan.value);
  assert(statements.ok, "expected DDL generation to succeed");
  const create = statements.value.map(s => s.replace(/\s+/g, " ")).find(s => s.startsWith("CREATE TABLE entry "));
  assert(create, statements.value.join("\n"));

  assert(create.includes("amount BIGINT"), create);
  assert(create.includes("amounts BIGINT[]"), create);
  assert(!create.includes("_finite"), create);
});

Deno.test("reconcileColumnTypes - converts a column of another type than its declared one, leaving TEXT and unknown types alone", async () => {
  const declared: Types.DeclaredColumn[] = [
    { columnName: "amount", pgType: "BIGINT", propertyType: "ledger::Money", tableName: "entry" },
    { columnName: "parts", multi: true, pgType: "BIGINT[]", propertyType: "ledger::Money", tableName: "entry" },
    { columnName: "note", pgType: "BIGINT", propertyType: "ledger::Money", tableName: "entry" },
    { columnName: "total", pgType: "DECIMAL", propertyType: "Money", tableName: "entry" },
    { columnName: "span", pgType: "INT4RANGE", propertyType: "Span", tableName: "entry" }
  ];
  const existing = [
    { dataType: "numeric", name: "amount", udtName: "numeric" },
    { dataType: "ARRAY", name: "parts", udtName: "_numeric" },
    { dataType: "text", name: "note", udtName: "text" },
    { dataType: "numeric", name: "total", udtName: "numeric" },
    { dataType: "int8range", name: "span", udtName: "int8range" }
  ];

  const operations = await reconcileColumnTypes(declared, [], () => Promise.resolve(existing));

  assertEquals(operations, [
    { columnName: "amount", fromPgType: "NUMERIC", kind: "ConvertColumnType", pgType: "BIGINT", propertyType: "ledger::Money", tableName: "entry" },
    {
      columnName: "parts",
      fromPgType: "NUMERIC[]",
      kind: "ConvertColumnType",
      multi: true,
      pgType: "BIGINT[]",
      propertyType: "ledger::Money",
      tableName: "entry"
    }
  ]);
});
