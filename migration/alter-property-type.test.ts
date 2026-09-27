/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Changing a property's type.
 *
 * `AlterProperty` emitted `ALTER COLUMN … TYPE <new>` with no `USING`, so
 * `str` → enum, `array<str>` → `array<Enum>`, `str` → `int64` and the like
 * failed on any table with rows ("column cannot be cast automatically"). The
 * type change now converts stored values with a cast (through text where
 * PostgreSQL has no direct one, e.g. enum → enum), after a check that names
 * the first value that does not convert. A change PostgreSQL has no cast for
 * (`duration` → `int64`) is refused when the DDL is generated.
 *
 * Real-PG coverage lives in `migration/alter-property-type-pg.test.ts`.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { MigrationEngine } from "./engine.ts";
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

const SCALARS = `scalar type Priority extending enum<Low, High>;
  scalar type Level extending enum<Low, High, Top>;`;

/*** The forward (or rollback) DDL of changing `type Item { value: <from>; }` to `<to>`, whitespace-collapsed. ***/
function retype(from: string, to: string, rollback = false): string[] {
  const e = engine();
  const schema = (property: string) =>
    parseModules(`module default {
  ${SCALARS}
  type Item { ${property}; };
};`);
  const plan = e.planMigration(schema(from), schema(to));
  if (!plan.ok)
    throw plan.error;
  const migration = plan.value.migrations[0];
  const statements = rollback ? e.generateRollbackSQL(migration) : e.generateDDL(plan.value);
  if (!statements.ok)
    throw statements.error;
  return statements.value.map(s => s.replace(/\s+/g, " ").trim()).filter(s => s !== "" && !s.startsWith("--"));
}

Deno.test("AlterProperty type change - str to int64 checks stored values, then converts with a cast", () => {
  const statements = retype("value: str", "value: int64");

  assertEquals(statements.length, 2, statements.join("\n"));
  assert(statements[0].startsWith("DO $$ DECLARE disc_value item.value%TYPE;"), statements[0]);
  assert(statements[0].includes("SELECT DISTINCT value FROM item WHERE value IS NOT NULL"), statements[0]);
  assert(statements[0].includes("PERFORM disc_value::BIGINT;"), statements[0]);
  assert(
    statements[0].includes("RAISE EXCEPTION 'Cannot convert item.value from str to int64: stored value % is not a valid int64 (%)'"),
    statements[0]
  );
  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN value TYPE BIGINT USING value::BIGINT;");
});

Deno.test("AlterProperty type change - str to an enum casts the text to the enum", () => {
  const statements = retype("value: str", "value: Priority");

  assert(statements[0].includes("PERFORM disc_value::disc_enum_priority;"), statements[0]);
  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN value TYPE disc_enum_priority USING value::disc_enum_priority;");
});

Deno.test("AlterProperty type change - one enum to another goes through text", () => {
  const statements = retype("value: Priority", "value: Level");

  assert(statements[0].includes("PERFORM disc_value::text::disc_enum_level;"), statements[0]);
  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN value TYPE disc_enum_level USING value::text::disc_enum_level;");
});

Deno.test("AlterProperty type change - array<str> to array<Enum> casts the array", () => {
  const statements = retype("value: array<str>", "value: array<Priority>");

  assert(statements[0].includes("PERFORM disc_value::disc_enum_priority[];"), statements[0]);
  assert(statements[0].includes("stored value % is not an array of Priority values"), statements[0]);
  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN value TYPE disc_enum_priority[] USING value::disc_enum_priority[];");
});

Deno.test("AlterProperty type change - array<Enum> to another enum's array goes through text[]", () => {
  const statements = retype("value: array<Priority>", "value: array<Level>");

  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN value TYPE disc_enum_level[] USING value::text[]::disc_enum_level[];");
});

Deno.test("AlterProperty type change - to str needs no check", () => {
  assertEquals(retype("value: int32", "value: str"), ["ALTER TABLE item ALTER COLUMN value TYPE TEXT USING value::TEXT;"]);
  assertEquals(retype("value: Priority", "value: str"), ["ALTER TABLE item ALTER COLUMN value TYPE TEXT USING value::TEXT;"]);
});

Deno.test("AlterProperty type change - between numeric types casts directly", () => {
  const statements = retype("value: float64", "value: int32");

  assertEquals(statements[1], "ALTER TABLE item ALTER COLUMN value TYPE INTEGER USING value::INTEGER;");
  assertEquals(retype("value: str", "value: bigint")[1], "ALTER TABLE item ALTER COLUMN value TYPE NUMERIC USING value::NUMERIC;");
});

Deno.test("AlterProperty type change - a column with a default drops it for the change and sets it again", () => {
  const statements = retype(`value: str { default := "3"; }`, `value: int64 { default := 3; }`);

  assertEquals(
    statements[statements.length - 1],
    "ALTER TABLE item ALTER COLUMN value DROP DEFAULT, ALTER COLUMN value TYPE BIGINT USING value::BIGINT, ALTER COLUMN value SET DEFAULT 3;"
  );
  assert(!statements.some(s => s.includes("SET DEFAULT 3;") && !s.includes("TYPE BIGINT")), statements.join("\n"));

  const unchanged = retype(`value: str { default := "Low"; }`, `value: Priority { default := "Low"; }`);
  assert(
    unchanged.includes(
      "ALTER TABLE item ALTER COLUMN value DROP DEFAULT, ALTER COLUMN value TYPE disc_enum_priority USING value::disc_enum_priority, ALTER COLUMN value SET DEFAULT 'Low';"
    ),
    unchanged.join("\n")
  );
});

Deno.test("AlterProperty type change - a multi property converts its array and keeps the empty-set default", () => {
  const statements = retype("multi value: str", "multi value: int64");

  assert(statements.some(s => s.includes("PERFORM disc_value::BIGINT[];")), statements.join("\n"));
  assert(statements.some(s => s.includes("stored value % is not a set of int64 values")), statements.join("\n"));
  assert(
    statements.includes(
      "ALTER TABLE item ALTER COLUMN value DROP DEFAULT, ALTER COLUMN value TYPE BIGINT[] USING value::BIGINT[], ALTER COLUMN value SET DEFAULT '{}';"
    ),
    statements.join("\n")
  );
});

Deno.test("AlterProperty type change - single to multi with a type change casts each value", () => {
  const statements = retype("value: str", "multi value: int64");

  assert(statements.some(s => s.includes("PERFORM disc_value::BIGINT;")), statements.join("\n"));
  assert(
    statements.includes(
      "ALTER TABLE item ALTER COLUMN value TYPE BIGINT[] USING CASE WHEN value IS NULL THEN '{}' ELSE ARRAY[value::BIGINT] END;"
    ),
    statements.join("\n")
  );
});

Deno.test("AlterProperty type change - a change PostgreSQL has no cast for is refused", () => {
  const error = assertThrows(() => retype("value: duration", "value: int64"));

  assert(
    (error as Error).message.includes(
      "Cannot change the type of property 'value' on 'item' from 'duration' to 'int64': PostgreSQL has no conversion from INTERVAL to BIGINT"
    ),
    (error as Error).message
  );
});

Deno.test("AlterProperty type change - rollback converts back with a cast", () => {
  const statements = retype("value: str", "value: int64", true);

  assertEquals(statements, ["ALTER TABLE item ALTER COLUMN value TYPE TEXT USING value::TEXT;"]);
});

Deno.test("AlterProperty type change - a handwritten operation without property definitions still gets a cast", () => {
  const op: Types.AlterTypeOperation = {
    kind: "AlterType",
    operations: [
      { changes: [{ kind: "ChangeType", newValue: "int64", oldValue: "str" }], kind: "AlterProperty", propertyName: "age" } as Types.AlterPropertyOperation
    ],
    typeName: "User"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assertEquals(statements[statements.length - 1], `ALTER TABLE "user" ALTER COLUMN age TYPE BIGINT USING age::BIGINT;`);
});
