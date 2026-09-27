/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Every `decimal` and `bigint` column has a CHECK keeping out what Gel's
 * types can't hold and PostgreSQL's numeric can: NaN and ±Infinity, and for a
 * bigint a fractional part (Gel's `bigint_t` domain checks
 * `scale(VALUE) = 0 AND VALUE != 'NaN'`). The compiler rejects such values
 * already (`disc_finite_numeric`); the CHECK keeps out whatever reaches the
 * column another way. It is named `chk_<table>_<column>_finite`, covers a
 * multi property's and an array's elements and a link property's junction
 * column, and follows the column's type changes. The drift repair adds it to
 * columns created before it existed (`reconcileFiniteChecks`).
 *
 * Real-PG coverage lives in `migration/finite-check-pg.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { MigrationEngine } from "./engine.ts";
import { reconcileFiniteChecks } from "./reconcile.ts";
import type * as Types from "./types.ts";

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

function modules(body: string) {
  return new SDLConverter().convertToModules(new SDLParser(`module default { ${body} };`).parse());
}

/*** The DDL (or its rollback) migrating `from` (null: an empty database) to `to`, whitespace-collapsed, without comments. ***/
function migrate(from: string | null, to: string, rollback = false): string[] {
  const e = engine();
  const plan = e.planMigration(from === null ? null : modules(from), modules(to));
  if (!plan.ok)
    throw plan.error;
  const statements = rollback ? e.generateRollbackSQL(plan.value.migrations[0]) : e.generateDDL(plan.value);
  if (!statements.ok)
    throw statements.error;
  return statements.value.map(s => s.replace(/\s+/g, " ").trim()).filter(s => s !== "" && !s.startsWith("--"));
}

function finiteChecks(statements: string[]): string[] {
  return statements.filter(s => /_finite\b/.test(s));
}

const DECIMAL = "NOT IN ('NaN', 'Infinity', '-Infinity')";
const NON_FINITE = "'{NaN,Infinity,-Infinity}'::numeric[]";

Deno.test("finite check - create type: one per decimal or bigint column, single, multi or array", () => {
  const statements = migrate(
    null,
    `scalar type Money extending decimal;
    type Reading {
      big: bigint;
      dec: decimal;
      price: Money;
      multi decs: decimal;
      bigs: array<bigint>;
      f64: float64;
      n: int64;
    };`
  );

  assertEquals(finiteChecks(statements), [
    `ALTER TABLE reading ADD CONSTRAINT chk_reading_big_finite CHECK (scale(big) = 0 AND big ${DECIMAL});`,
    `ALTER TABLE reading ADD CONSTRAINT chk_reading_dec_finite CHECK (dec ${DECIMAL});`,
    `ALTER TABLE reading ADD CONSTRAINT chk_reading_price_finite CHECK (price ${DECIMAL});`,
    `ALTER TABLE reading ADD CONSTRAINT chk_reading_decs_finite CHECK (NOT (decs && ${NON_FINITE}));`,
    `ALTER TABLE reading ADD CONSTRAINT chk_reading_bigs_finite CHECK (NOT (bigs && ${NON_FINITE}) AND disc_array_integral(bigs));`
  ]);
});

Deno.test("finite check - a decimal link property checks its junction column", () => {
  const statements = migrate(null, `type Sensor { name: str; }; type Reading { multi link sensors -> Sensor { property weight -> decimal; }; };`);

  assertEquals(finiteChecks(statements), [
    `ALTER TABLE reading_sensors ADD CONSTRAINT chk_reading_sensors_weight_finite CHECK (weight ${DECIMAL});`
  ]);
});

Deno.test("finite check - add property", () => {
  const statements = migrate("type Reading { label: str; };", "type Reading { label: str; big: bigint; };");

  assertEquals(finiteChecks(statements), [`ALTER TABLE reading ADD CONSTRAINT chk_reading_big_finite CHECK (scale(big) = 0 AND big ${DECIMAL});`]);
});

Deno.test("finite check - a type change to decimal checks the stored values, then adds the check", () => {
  const statements = migrate("type Reading { value: str; };", "type Reading { value: decimal; };");
  const checks = finiteChecks(statements);

  assertEquals(checks.length, 2, checks.join("\n"));
  assert(checks[0].startsWith("DO $$"), checks[0]);
  assert(checks[0].includes(`SELECT value::text INTO disc_value FROM reading WHERE NOT (value ${DECIMAL}) LIMIT 1;`), checks[0]);
  assert(checks[0].includes("Cannot add chk_reading_value_finite to reading.value: stored value % is not a valid decimal"), checks[0]);
  assertEquals(checks[1], `ALTER TABLE reading ADD CONSTRAINT chk_reading_value_finite CHECK (value ${DECIMAL});`);
  assert(statements.indexOf(checks[0]) > statements.findIndex(s => s.includes("ALTER COLUMN value TYPE")), "after the conversion");
});

Deno.test("finite check - a type change away from decimal drops the check first, and its rollback puts it back", () => {
  const statements = migrate("type Reading { value: decimal; };", "type Reading { value: float64; };");

  assertEquals(statements[0], "ALTER TABLE reading DROP CONSTRAINT IF EXISTS chk_reading_value_finite;");
  assertEquals(finiteChecks(statements).length, 1);

  const rollback = migrate("type Reading { value: decimal; };", "type Reading { value: float64; };", true);
  assertEquals(rollback.at(-1), `ALTER TABLE reading ADD CONSTRAINT chk_reading_value_finite CHECK (value ${DECIMAL});`);
});

Deno.test("finite check - decimal to bigint replaces the check with the integral one", () => {
  const checks = finiteChecks(migrate("type Reading { value: decimal; };", "type Reading { value: bigint; };"));

  assertEquals(checks[0], "ALTER TABLE reading DROP CONSTRAINT IF EXISTS chk_reading_value_finite;");
  assert(checks[1].includes(`WHERE NOT (scale(value) = 0 AND value ${DECIMAL})`), checks[1]);
  assertEquals(checks[2], `ALTER TABLE reading ADD CONSTRAINT chk_reading_value_finite CHECK (scale(value) = 0 AND value ${DECIMAL});`);
});

Deno.test("finite check - a multi property's type change checks each stored element", () => {
  const checks = finiteChecks(migrate("type Reading { multi nums: str; };", "type Reading { multi nums: bigint; };"));
  const validation = checks.find(s => s.startsWith("DO $$"));

  assert(validation, checks.join("\n"));
  assert(
    validation.includes(`SELECT e.v::text INTO disc_value FROM reading, unnest(nums) AS e(v) WHERE NOT (scale(e.v) = 0 AND e.v ${DECIMAL}) LIMIT 1;`),
    validation
  );
  assertEquals(
    checks.at(-1),
    `ALTER TABLE reading ADD CONSTRAINT chk_reading_nums_finite CHECK (NOT (nums && ${NON_FINITE}) AND disc_array_integral(nums));`
  );
});

Deno.test("finite check - AddFiniteCheck checks the stored values, then adds the check; its rollback drops it", () => {
  const generator = new DDLGenerator();
  const op: Types.AddFiniteCheckOperation = { columnName: "dec", kind: "AddFiniteCheck", pgType: "DECIMAL", propertyType: "decimal", tableName: "reading" };
  const statements = generator.generateDDL([op]).map(s => s.replace(/\s+/g, " ").trim());

  assertEquals(statements.length, 2);
  assert(statements[0].includes(`SELECT dec::text INTO disc_value FROM reading WHERE NOT (dec ${DECIMAL}) LIMIT 1;`), statements[0]);
  assertEquals(statements[1], `ALTER TABLE reading ADD CONSTRAINT chk_reading_dec_finite CHECK (dec ${DECIMAL});`);
  assertEquals(generator.generateRollbackDDL([op]).filter(s => !s.startsWith("--")), [
    "ALTER TABLE reading DROP CONSTRAINT IF EXISTS chk_reading_dec_finite;"
  ]);
});

const DECLARED: Types.DeclaredColumn[] = [
  { columnName: "dec", pgType: "DECIMAL", propertyType: "decimal", tableName: "reading" },
  { columnName: "big", pgType: "NUMERIC", propertyType: "bigint", tableName: "reading" },
  { columnName: "decs", multi: true, pgType: "DECIMAL[]", propertyType: "decimal", tableName: "reading" },
  { columnName: "label", pgType: "TEXT", propertyType: "str", tableName: "reading" },
  { columnName: "weight", pgType: "DECIMAL", propertyType: "decimal", tableName: "reading_sensors" },
  { columnName: "dec", pgType: "DECIMAL", propertyType: "decimal", tableName: "later" }
];

function checkName(column: Types.DeclaredColumn): string | undefined {
  return new DDLGenerator().finiteCheck(column.tableName, column.columnName, column.propertyType, column.multi === true)?.name;
}

Deno.test("reconcileFiniteChecks - adds the checks existing columns lack, skipping tables and columns that don't exist yet", async () => {
  const asked: string[][] = [];
  const operations = await reconcileFiniteChecks(DECLARED, [], checkName, tableNames => {
    asked.push(tableNames);
    return Promise.resolve({
      checks: new Set(["reading.chk_reading_big_finite"]),
      columns: new Set(["reading.dec", "reading.big", "reading.label", "reading_sensors.weight"])
    });
  });

  assertEquals(asked, [["reading", "reading_sensors", "later"]]);
  assertEquals(operations, [
    { columnName: "dec", kind: "AddFiniteCheck", pgType: "DECIMAL", propertyType: "decimal", tableName: "reading" },
    { columnName: "weight", kind: "AddFiniteCheck", pgType: "DECIMAL", propertyType: "decimal", tableName: "reading_sensors" }
  ]);
});

Deno.test("reconcileFiniteChecks - skips columns whose type the pending migration changes", async () => {
  const alter: Types.AlterPropertyOperation = {
    changes: [{ kind: "ChangeType", newValue: "decimal", oldValue: "str" }],
    kind: "AlterProperty",
    propertyName: "dec"
  };
  const planned: Types.AlterTypeOperation[] = [{ kind: "AlterType", operations: [alter], typeName: "Reading" }];
  const operations = await reconcileFiniteChecks(
    DECLARED.slice(0, 1),
    planned,
    checkName,
    () => Promise.resolve({ checks: new Set<string>(), columns: new Set(["reading.dec"]) })
  );

  assertEquals(operations, []);
});

Deno.test("reconcileFiniteChecks - asks nothing when no column needs a check", async () => {
  const operations = await reconcileFiniteChecks(DECLARED.slice(3, 4), [], checkName, () => {
    throw new Error("not asked");
  });

  assertEquals(operations, []);
});
