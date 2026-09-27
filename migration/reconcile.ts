/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Drift reconciliation for from-scratch `CREATE TABLE` DDL.
 *
 * When the database has drifted from migration history (e.g. `disc_migrations`
 * was dropped but the tables remain), a fresh migration re-plans from null and
 * emits `CREATE TABLE` for tables that already exist. Executing those would
 * hard-fail with `relation "<t>" already exists`.
 *
 * This module reconciles SAFELY (never a blanket `CREATE TABLE IF NOT EXISTS`,
 * which would mask a genuinely diverged table):
 *
 *   - If a target table already exists and its columns MATCH the intended
 *     shape, the `CREATE TABLE` is dropped from the statement list (no-op) so
 *     the apply succeeds.
 *   - If the table exists but DIFFERS from the intended shape, a descriptive
 *     `MigrationError` is raised naming the table and the mismatch. The drift
 *     is surfaced, never silently accepted.
 *
 * Column reading is injected (`ExistingColumnReader`) so this module stays pure
 * and reuses the caller's connection rather than opening its own.
 */

import { MigrationError } from "../lib/errors.ts";
import { PG_MAX_IDENTIFIER_BYTES, propNameToColumnName, typeNameToTableName } from "../lib/identifiers.ts";
import { deletesTargets } from "./types.ts";
import type {
  AddFiniteCheckOperation,
  AddLinkOperation,
  AddPropertyOperation,
  AddRewriteOperation,
  AlterLinkOperation,
  AlterPropertyOperation,
  AlterTypeOperation,
  ConvertColumnTypeOperation,
  ConvertTextColumnOperation,
  CreateIndexOperation,
  CreateTypeOperation,
  DeclaredAbstractMirror,
  DeclaredColumn,
  DeclaredLink,
  DeclaredLinkProperty,
  DeclaredRewrites,
  DropRewriteOperation,
  DropTypeOperation,
  IndexDefinition,
  LinkChange,
  LinkDefinition,
  MigrationOperation,
  MirrorAbstractTypeOperation,
  RewriteDefinition,
  TypeOperation
} from "./types.ts";

/** A column the database currently reports for an existing table. */
export interface ExistingColumn {
  /** Column name as stored by PostgreSQL (already lowercased / unquoted). */
  name: string;
  /** `information_schema.columns.data_type` (e.g. "bigint", "text", "ARRAY"). */
  dataType: string;
  /** `information_schema.columns.udt_name` (e.g. "int8", "_text" for a `text[]` column). */
  udtName?: string;
}

/**
 * Reads the columns of an already-existing table. Returns `null` when the
 * table does not exist. Injected by the engine so this module needs no DB
 * dependency of its own.
 */
export type ExistingColumnReader = (
  tableName: string
) => Promise<ExistingColumn[] | null>;

/** A column the pending `CREATE TABLE` intends to create. */
interface IntendedColumn {
  name: string;
  /** Normalized base type (lowercased, length/precision stripped). */
  baseType: string;
}

/**
 * A captured identifier as PostgreSQL stores it: a quoted one keeps its case
 * (a camelCase link's junction is `"channel_pinnedVideo"`), a bare one folds
 * to lowercase.
 */
function storedIdentifier(quoted: string | undefined, bare: string | undefined): string {
  return quoted ?? bare!.toLowerCase();
}

/**
 * Parse a generated `CREATE TABLE "name" ( ... );` statement into a table name
 * and the columns it would create. Returns `null` for any statement that is
 * not a `CREATE TABLE` (those pass through untouched).
 *
 * The grammar is the one this repo's `DDLGenerator` emits: a double-quoted
 * table name, then comma-separated lines that are either a quoted column name
 * followed by a type, or a `CONSTRAINT ...` clause (skipped here).
 */
function parseCreateTable(
  statement: string
): { tableName: string; columns: IntendedColumn[]; } | null {
  const trimmed = statement.trim();
  // The table name may be bare (`widget`) or double-quoted (`"user"`) — the
  // DDL generator only quotes reserved/special identifiers.
  const header = /^CREATE TABLE\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*\(/i
    .exec(trimmed);
  if (!header) {
    return null;
  }
  const tableName = storedIdentifier(header[1], header[2]);

  // Body is everything between the first "(" and the final ")".
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open === -1 || close === -1 || close <= open) {
    return null;
  }
  const body = trimmed.slice(open + 1, close);

  const columns: IntendedColumn[] = [];
  for (const rawLine of splitTopLevel(body)) {
    const line = rawLine.trim();
    if (line === "" || /^CONSTRAINT\b/i.test(line)) {
      continue;
    }
    // Column name may be bare or double-quoted, mirroring the table name.
    const colMatch = /^(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s+(.+)$/.exec(line);
    if (!colMatch) {
      continue;
    }
    columns.push({
      name: (colMatch[1] ?? colMatch[2]).toLowerCase(),
      baseType: normalizeType(colMatch[3])
    });
  }

  return { tableName, columns };
}

/**
 * Split a CREATE TABLE body on top-level commas (commas not inside
 * parentheses), so a type like `VARCHAR(255)` or `NUMERIC(10, 2)` stays on one
 * logical line.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") {
    parts.push(current);
  }
  return parts;
}

/**
 * Reduce a column definition tail (everything after the column name) to a
 * normalized base type token for comparison: take the leading type words, drop
 * length / precision modifiers, and lowercase. Column modifiers like `NOT
 * NULL`, `PRIMARY KEY`, `DEFAULT ...` are dropped.
 *
 * Type comparison is intentionally conservative: it only ever participates in a
 * MISMATCH decision when both sides map to a confidently-known canonical token.
 * Unknown / unmappable spellings are treated as comparable-equal so cosmetic
 * type-spelling differences never raise a false drift error.
 */
function normalizeType(typeTail: string): string {
  // Keep words up to the first column-modifier keyword.
  const stop = /\b(PRIMARY|NOT|NULL|UNIQUE|DEFAULT|REFERENCES|CHECK)\b/i;
  const match = stop.exec(typeTail);
  const typeText = (match ? typeTail.slice(0, match.index) : typeTail).trim();
  // Strip length / precision parentheses (VARCHAR(255), NUMERIC(10,2)).
  return canonicalType(typeText.replace(/\([^)]*\)/g, "").trim().toLowerCase());
}

/**
 * Map both intended (SQL DDL) and existing (information_schema) type spellings
 * to a shared canonical token. Returns the lowercased input unchanged when no
 * synonym is known.
 */
function canonicalType(type: string): string {
  const synonyms: Record<string, string> = {
    int8: "bigint",
    int4: "integer",
    int2: "smallint",
    bool: "boolean",
    "character varying": "text",
    varchar: "text",
    timestamptz: "timestamp with time zone",
    "timestamp without time zone": "timestamp",
    float8: "double precision",
    float4: "real"
  };
  return synonyms[type] ?? type;
}

/** The DDL left to run after reconciliation, and the tables whose CREATE it skipped. */
export interface ReconciledStatements {
  skippedTables: Set<string>;
  statements: string[];
}

/**
 * Reconcile a list of DDL statements against the live database. `CREATE TABLE`
 * statements whose target already exists with a matching shape are removed;
 * a divergent existing table raises a descriptive `MigrationError`.
 *
 * All non-`CREATE TABLE` statements and CREATE TABLEs for not-yet-existing
 * tables pass through unchanged and in order. The skipped tables are returned
 * too: the migration did not create them, so its rollback must not drop them.
 */
export async function reconcileCreateTables(
  statements: string[],
  readColumns: ExistingColumnReader
): Promise<ReconciledStatements> {
  const reconciled: string[] = [];
  // Tables whose CREATE was skipped because they already exist and match.
  // Dependent statements (deferred FK / UNIQUE constraints, indexes) that
  // target these tables must also be skipped — re-running them would collide
  // with the objects already present (e.g. "constraint already exists").
  const skippedTables = new Set<string>();

  for (const statement of statements) {
    const parsed = parseCreateTable(statement);
    if (parsed) {
      const existing = await readColumns(parsed.tableName);
      if (existing === null) {
        // Table does not exist — emit the CREATE as planned.
        reconciled.push(statement);
        continue;
      }

      const mismatch = describeMismatch(parsed.columns, existing);
      if (mismatch === null) {
        // Already created with a matching shape — skip the CREATE (no-op) and
        // remember the table so its dependent statements are skipped too.
        skippedTables.add(parsed.tableName);
        continue;
      }

      throw new MigrationError(
        `Table "${parsed.tableName}" exists but does not match the migrated ` +
          `schema — the database has drifted from migration history ` +
          `(${mismatch}). Wipe the table or reconcile it manually, then ` +
          `re-run the migration.`
      );
    }

    // Non-CREATE-TABLE statement: drop it only when it adds objects to a table
    // whose CREATE we skipped (so the table already carries those objects).
    const target = dependentStatementTarget(statement);
    if (target !== null && skippedTables.has(target)) {
      continue;
    }
    reconciled.push(statement);
  }

  return { skippedTables, statements: reconciled };
}

/**
 * Drop the `DROP TABLE` statements of a rollback that target `tables` — tables
 * that existed before the migration (see `reconcileCreateTables`), so undoing
 * it must leave them and their rows alone.
 */
export function withoutDropsOf(rollbackSql: string[], tables: Set<string>): string[] {
  if (tables.size === 0) {
    return rollbackSql;
  }

  return rollbackSql.filter(statement => {
    const drop = /^DROP TABLE\s+(?:IF EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/i.exec(statement.trim());
    return !drop || !tables.has(storedIdentifier(drop[1], drop[2]));
  });
}

/**
 * Return the table a deferred dependent statement targets, or `null` if the
 * statement is not table-scoped in a way reconciliation cares about. Covers the
 * forms the DDL generator defers: `ALTER TABLE <t> ...` and
 * `CREATE [UNIQUE] INDEX ... ON <t> ...`.
 */
function dependentStatementTarget(statement: string): string | null {
  const trimmed = statement.trim();
  const alter = /^ALTER TABLE\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*)\b)/i
    .exec(trimmed);
  if (alter) {
    return storedIdentifier(alter[1], alter[2]);
  }
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b.*?\bON\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*)\b)/i
    .exec(trimmed);
  if (index) {
    return storedIdentifier(index[1], index[2]);
  }
  return null;
}

/**
 * Compare the intended columns against the existing ones. Returns `null` when
 * the table matches, or a human-readable description of the first mismatch.
 *
 * Matching requires the same SET of column names. A type difference is only
 * reported when BOTH sides resolve to a confidently-known canonical token (so
 * cosmetic spelling differences don't trip false positives).
 */
function describeMismatch(
  intended: IntendedColumn[],
  existing: ExistingColumn[]
): string | null {
  const existingByName = new Map(
    existing.map(c => [c.name.toLowerCase(), canonicalType(c.dataType.toLowerCase())])
  );
  const intendedNames = new Set(intended.map(c => c.name));

  // Columns the schema expects but the table lacks.
  for (const col of intended) {
    if (!existingByName.has(col.name)) {
      return `missing column "${col.name}"`;
    }
  }

  // Columns the table has but the schema does not declare.
  for (const col of existing) {
    if (!intendedNames.has(col.name.toLowerCase())) {
      return `unexpected column "${col.name}"`;
    }
  }

  // Type mismatches, only when both canonical tokens are known and differ.
  const known = new Set([
    "bigint",
    "integer",
    "smallint",
    "boolean",
    "text",
    "uuid",
    "timestamp with time zone",
    "timestamp",
    "date",
    "double precision",
    "real",
    "jsonb",
    "bytea"
  ]);
  for (const col of intended) {
    const existingType = existingByName.get(col.name)!;
    if (
      known.has(col.baseType) &&
      known.has(existingType) &&
      col.baseType !== existingType
    ) {
      return `column "${col.name}" type ${existingType} ≠ expected ${col.baseType}`;
    }
  }

  return null;
}

/**
 * Reads which of the given index names exist in the database. Injected by the
 * engine, like {@link ExistingColumnReader}.
 */
export type ExistingIndexReader = (indexNames: string[]) => Promise<Set<string>>;

/**
 * Backfill for indexes the schema declares but the database lacks.
 *
 * The differ compares the stored schema snapshot with the new one and never
 * looks at the database. An index that both snapshots declare therefore diffs
 * to nothing even when it was never created — which is the state of every
 * type-level `constraint exclusive on (…)`, and every `index on (…)` of a type
 * created with it, written before Disc emitted them.
 *
 * Returns `CREATE … INDEX IF NOT EXISTS` operations for the declared indexes
 * that are neither created by the pending migration (`planned`) nor present in
 * the database. Idempotent: once the indexes exist it returns nothing.
 */
export async function reconcileDeclaredIndexes(
  declared: IndexDefinition[],
  planned: MigrationOperation[],
  readExisting: ExistingIndexReader
): Promise<CreateIndexOperation[]> {
  const plannedNames = new Set(
    planned.filter((op): op is CreateIndexOperation => op.kind === "CreateIndex").map(op => op.index.name)
  );
  const candidates = declared.filter(index => !plannedNames.has(index.name));

  if (candidates.length === 0) {
    return [];
  }

  const existing = await readExisting(candidates.map(index => index.name));

  return candidates
    .filter(index => !existing.has(index.name))
    .map(index => ({ ifNotExists: true, index, kind: "CreateIndex" }));
}

/**
 * Add the junction columns of declared link properties that the database
 * lacks. Before Disc stored link properties, a multi link's junction table
 * got only `source_id` / `target_id`, while the stored schema snapshot already
 * declared the link's properties — so the differ, comparing two snapshots that
 * both declare them, diffs to nothing.
 *
 * Returns one `AlterType` → `AlterLink` → `AddProperty` operation per link
 * with missing columns, skipping links the pending migration (`planned`)
 * creates or whose link properties it already changes, and junction tables
 * that don't exist. Idempotent: once the columns exist it returns nothing.
 */
export async function reconcileDeclaredLinkProperties(
  declared: DeclaredLinkProperty[],
  planned: MigrationOperation[],
  readExisting: ExistingColumnReader
): Promise<AlterTypeOperation[]> {
  const handled = new Set<string>();
  for (const op of planned) {
    if (op.kind === "CreateType") {
      for (const link of (op as CreateTypeOperation).links) {
        handled.add(`${(op as CreateTypeOperation).typeName}.${link.name}`);
      }
    } else if (op.kind === "AlterType") {
      const alter = op as AlterTypeOperation;
      for (const sub of alter.operations) {
        if (sub.kind === "AddLink") {
          handled.add(`${alter.typeName}.${(sub as AddLinkOperation).link.name}`);
        } else if (sub.kind === "AlterLink" && (sub as AlterLinkOperation).propertyOperations) {
          handled.add(`${alter.typeName}.${(sub as AlterLinkOperation).linkName}`);
        }
      }
    }
  }

  const missing = new Map<string, DeclaredLinkProperty[]>();
  const columnsByTable = new Map<string, Set<string> | null>();
  for (const entry of declared) {
    const key = `${entry.typeName}.${entry.linkName}`;
    if (handled.has(key)) {
      continue;
    }
    if (!columnsByTable.has(entry.junctionTable)) {
      const columns = await readExisting(entry.junctionTable);
      columnsByTable.set(entry.junctionTable, columns ? new Set(columns.map(c => c.name)) : null);
    }
    const columns = columnsByTable.get(entry.junctionTable);
    if (columns && !columns.has(propNameToColumnName(entry.property.name))) {
      missing.set(key, [...(missing.get(key) ?? []), entry]);
    }
  }

  return [...missing.values()].map(entries => ({
    kind: "AlterType",
    typeName: entries[0].typeName,
    operations: [{
      kind: "AlterLink",
      linkName: entries[0].linkName,
      changes: [],
      propertyOperations: entries.map((entry): AddPropertyOperation => ({ kind: "AddProperty", property: entry.property }))
    } as AlterLinkOperation]
  }));
}

/** The delete rules the database has on the tables it was asked about. */
export interface ExistingDeleteRules {
  /** The foreign keys (keyed like `foreignKeys`) that are `DEFERRABLE INITIALLY DEFERRED`. */
  deferredForeignKeys: Set<string>;
  /** ON DELETE action (`CASCADE`, `RESTRICT`, …) of each foreign key, keyed `<table>.<constraint>`. */
  foreignKeys: Map<string, string>;
  /** The asked-about tables that exist. */
  tables: Set<string>;
  /** Source (`pg_proc.prosrc`) of the function each trigger executes, keyed `<table>.<trigger>`. */
  triggerBodies: Map<string, string>;
  /** Timing (`BEFORE`, `AFTER`, `INSTEAD OF`) of each trigger, keyed `<table>.<trigger>`. */
  triggers: Map<string, string>;
}

/**
 * Reads the foreign keys and triggers of the given tables. Injected by the
 * engine, like {@link ExistingColumnReader}.
 */
export type ExistingDeleteRuleReader = (tableNames: string[]) => Promise<ExistingDeleteRules>;

/** How the DDL generator names a link's delete rules and which FK action it gives the link (see `DDLGenerator`). */
export interface LinkDeleteRuleNaming {
  sourceDeleteTrigger(tableName: string, link: LinkDefinition): { body: string; name: string; table: string; timing: string; };
  targetForeignKey(tableName: string, link: LinkDefinition): { constraint: string; deferred: boolean; onDelete: string; table: string; };
}

/** The repairs `reconcileLinkDeleteRules` plans, and the foreign keys it found missing and left alone. */
export interface ReconciledDeleteRules {
  missingForeignKeys: string[];
  operations: AlterTypeOperation[];
}

/*** The name PostgreSQL stores for a generated identifier: it cuts longer ones to 63 bytes. ***/
function pgStoredName(name: string): string {
  const encoder = new TextEncoder();
  let stored = name;

  while (encoder.encode(stored).length > PG_MAX_IDENTIFIER_BYTES)
    stored = stored.slice(0, -1);

  return stored;
}

/**
 * Repair link delete rules the database lacks. Before Disc applied a changed
 * `on target delete` / `on source delete`, `migrate` emitted only a comment
 * and still recorded the new schema — so the stored snapshot declares the new
 * rule, the diff between two snapshots is empty, and PostgreSQL keeps the old
 * foreign-key action (or the delete-target trigger never appears, or never
 * goes away).
 *
 * Compares every declared link (`declared`) with the database: the ON DELETE
 * action of its target FK (`fk_<table>_<link>_id`, or `fk_<junction>_target_id`
 * on a multi link) and whether that FK is deferred (a link to an abstract
 * type's is, see `LinkDefinition.targetAbstract`, and a `deferred restrict`
 * link's, whose action is NO ACTION rather than RESTRICT), and whether its `trg_source_delete_…` trigger exists —
 * with the timing, on the table and running the function body Disc creates
 * it with now (AFTER DELETE; a multi link's on its junction; `if orphan`
 * adds a check). Earlier Disc created it BEFORE DELETE on the source table,
 * where the target's RESTRICT FK blocked deleting the source; such a
 * trigger is replaced, as is one whose body runs another policy.
 * Returns one `AlterType` → `AlterLink` per link that differs, carrying the
 * same `ChangeOnDelete` / `ChangeOnSourceDelete` the ALTER LINK path turns
 * into DDL (drop and re-add the FK; create, replace or drop the trigger).
 *
 * Skips the FK (trigger) of links the pending migration (`planned`) creates
 * or whose `on target delete` (`on source delete`) it changes, and tables
 * that don't exist yet. A foreign key that doesn't exist at all is reported
 * in `missingForeignKeys`, never re-created: why it is missing isn't knowable
 * from here. Idempotent: once repaired, it returns nothing.
 */
export async function reconcileLinkDeleteRules(
  declared: DeclaredLink[],
  planned: MigrationOperation[],
  naming: LinkDeleteRuleNaming,
  readExisting: ExistingDeleteRuleReader
): Promise<ReconciledDeleteRules> {
  const foreignKeyPlanned = new Set<string>();
  const triggerPlanned = new Set<string>();
  const planBoth = (key: string): void => {
    foreignKeyPlanned.add(key);
    triggerPlanned.add(key);
  };

  for (const op of planned) {
    if (op.kind === "CreateType") {
      for (const link of (op as CreateTypeOperation).links) {
        planBoth(`${(op as CreateTypeOperation).typeName}.${link.name}`);
      }
    } else if (op.kind === "AlterType") {
      const alter = op as AlterTypeOperation;
      for (const sub of alter.operations) {
        if (sub.kind === "AddLink") {
          planBoth(`${alter.typeName}.${(sub as AddLinkOperation).link.name}`);
        } else if (sub.kind === "AlterLink") {
          const key = `${alter.typeName}.${(sub as AlterLinkOperation).linkName}`;
          for (const change of (sub as AlterLinkOperation).changes) {
            if (change.kind === "ChangeOnDelete") {
              foreignKeyPlanned.add(key);
            } else if (change.kind === "ChangeOnSourceDelete") {
              triggerPlanned.add(key);
            }
          }
        }
      }
    }
  }

  const candidates = declared.filter(entry => {
    const key = `${entry.typeName}.${entry.link.name}`;
    return !foreignKeyPlanned.has(key) || !triggerPlanned.has(key);
  });

  if (candidates.length === 0) {
    return { missingForeignKeys: [], operations: [] };
  }

  const existing = await readExisting([
    ...new Set(candidates.flatMap(entry => [
      entry.tableName,
      naming.targetForeignKey(entry.tableName, entry.link).table,
      naming.sourceDeleteTrigger(entry.tableName, entry.link).table
    ]))
  ]);
  const missingForeignKeys: string[] = [];
  const operations: AlterTypeOperation[] = [];

  for (const entry of candidates) {
    const key = `${entry.typeName}.${entry.link.name}`;
    const changes: LinkChange[] = [];

    const foreignKey = naming.targetForeignKey(entry.tableName, entry.link);
    if (!foreignKeyPlanned.has(key) && existing.tables.has(foreignKey.table)) {
      const actual = existing.foreignKeys.get(`${foreignKey.table}.${pgStoredName(foreignKey.constraint)}`);
      if (actual === undefined) {
        missingForeignKeys.push(
          `link '${entry.link.name}' on '${entry.typeName}' has no foreign key "${foreignKey.constraint}" on "${foreignKey.table}" ` +
            `(expected ON DELETE ${foreignKey.onDelete}); not re-created — add it by hand`
        );
      } else if (
        actual !== foreignKey.onDelete || existing.deferredForeignKeys.has(`${foreignKey.table}.${pgStoredName(foreignKey.constraint)}`) !== foreignKey.deferred
      ) {
        changes.push({ kind: "ChangeOnDelete", newValue: entry.link.onTargetDelete, oldValue: actual });
      }
    }

    const trigger = naming.sourceDeleteTrigger(entry.tableName, entry.link);
    if (!triggerPlanned.has(key) && existing.tables.has(entry.tableName) && existing.tables.has(trigger.table)) {
      const name = pgStoredName(trigger.name);
      const timing = existing.triggers.get(`${trigger.table}.${name}`);
      /*** Where a multi link's trigger was before it moved to the junction: the source table. ***/
      const misplaced = trigger.table !== entry.tableName && existing.triggers.has(`${entry.tableName}.${name}`);
      const present = timing !== undefined || misplaced;
      const body = existing.triggerBodies.get(`${trigger.table}.${name}`)?.trim();
      const matches = deletesTargets(entry.link.onSourceDelete) ?
        timing === trigger.timing && !misplaced && body === trigger.body :
        !present;
      if (!matches) {
        changes.push({ kind: "ChangeOnSourceDelete", newValue: entry.link.onSourceDelete, oldValue: present ? "DELETE TARGET" : undefined });
      }
    }

    if (changes.length > 0) {
      operations.push({
        kind: "AlterType",
        typeName: entry.typeName,
        operations: [{ kind: "AlterLink", linkName: entry.link.name, changes, link: entry.link } as AlterLinkOperation]
      });
    }
  }

  return { missingForeignKeys, operations };
}

/*** The property changes whose DDL changes the column's type. ***/
const RETYPING_CHANGES = new Set(["ChangeComputed", "ChangeMulti", "ChangeType"]);

/**
 * The columns whose type `planned` changes, keyed `<table>.<column>`, and the
 * junction tables whose link properties it changes, keyed `<junction>.*`.
 */
function retypedColumns(planned: MigrationOperation[]): Set<string> {
  const retyped = new Set<string>();
  for (const op of planned) {
    if (op.kind !== "AlterType") {
      continue;
    }
    const tableName = typeNameToTableName((op as AlterTypeOperation).typeName);
    for (const sub of (op as AlterTypeOperation).operations) {
      if (sub.kind === "AlterProperty" && (sub as AlterPropertyOperation).changes.some(c => RETYPING_CHANGES.has(c.kind))) {
        retyped.add(`${tableName}.${propNameToColumnName((sub as AlterPropertyOperation).propertyName)}`);
      } else if (sub.kind === "AlterLink" && (sub as AlterLinkOperation).propertyOperations) {
        retyped.add(`${tableName}_${(sub as AlterLinkOperation).linkName}.*`);
      }
    }
  }
  return retyped;
}

/**
 * Convert TEXT columns to the column type of their property's declared type.
 * Before Disc mapped a type (`bigint`, `array<Enum>`, `array<duration>`, a
 * scalar extending `int64`, …), its column was created as TEXT (holding the
 * value's text form, e.g. `12` or `{Low,High}`), while the stored schema
 * snapshot already declared the type — so the differ, comparing two
 * snapshots that agree, diffs to nothing.
 *
 * The same goes for array columns created as `text[]` — a `multi` property of
 * such a type (`multi x: bigint`, `multi tags: Priority` before enums were
 * mapped): those convert element-wise (`fromTextArray`).
 *
 * Returns one `ConvertTextColumn` per declared column whose type isn't TEXT
 * (or `TEXT[]`) and which the database has as `text` (or `text[]`), skipping
 * columns whose type the pending migration (`planned`) already changes (a
 * property's type, `multi` or computed-ness, or a link's link properties).
 * Tables and columns that don't exist yet are the pending migration's to
 * create, with the right type.
 * Idempotent: once converted, the column's type isn't `text` / `text[]` and
 * it returns nothing.
 */
export async function reconcileTextColumns(
  declared: DeclaredColumn[],
  planned: MigrationOperation[],
  readExisting: ExistingColumnReader
): Promise<ConvertTextColumnOperation[]> {
  const retyped = retypedColumns(planned);
  const columnsByTable = new Map<string, ExistingColumn[] | null>();
  const operations: ConvertTextColumnOperation[] = [];

  for (const column of declared) {
    if (
      column.pgType === "TEXT" ||
      retyped.has(`${column.tableName}.${column.columnName}`) ||
      retyped.has(`${column.tableName}.*`)
    ) {
      continue;
    }

    if (!columnsByTable.has(column.tableName)) {
      columnsByTable.set(column.tableName, await readExisting(column.tableName));
    }

    const existing = columnsByTable.get(column.tableName)?.find(c => c.name === column.columnName);

    if (existing?.dataType === "text") {
      operations.push({ ...column, kind: "ConvertTextColumn" });
    } else if (
      existing?.dataType === "ARRAY" && existing.udtName === "_text" &&
      column.pgType.endsWith("[]") && column.pgType.toUpperCase() !== "TEXT[]"
    ) {
      operations.push({ ...column, fromTextArray: true, kind: "ConvertTextColumn" });
    }
  }

  return operations;
}

/*** The column type each `information_schema.columns.udt_name` stands for, as the DDL spells it. ***/
const UDT_COLUMN_TYPES: Record<string, string> = {
  bool: "BOOLEAN",
  bytea: "BYTEA",
  date: "DATE",
  float4: "REAL",
  float8: "DOUBLE PRECISION",
  int2: "SMALLINT",
  int4: "INTEGER",
  int8: "BIGINT",
  interval: "INTERVAL",
  jsonb: "JSONB",
  numeric: "NUMERIC",
  text: "TEXT",
  time: "TIME WITHOUT TIME ZONE",
  timestamp: "TIMESTAMP WITHOUT TIME ZONE",
  timestamptz: "TIMESTAMP WITH TIME ZONE",
  uuid: "UUID"
};

/**
 * The column type `udtName` names, as the DDL spells it (`int8` → `BIGINT`,
 * `_numeric` → `NUMERIC[]`, an enum's `disc_enum_…` as is); undefined for
 * any other.
 */
function udtColumnType(udtName: string): string | undefined {
  const element = udtName.startsWith("_") ? udtName.slice(1) : udtName;
  const type = UDT_COLUMN_TYPES[element] ?? (element.startsWith("disc_enum_") ? element : undefined);
  return type === undefined || element === udtName ? type : `${type}[]`;
}

/*** `pgType` spelled as `udtColumnType` spells it (unquoted, `DECIMAL` as `NUMERIC`), or undefined when it can't be. ***/
function comparableColumnType(pgType: string): string | undefined {
  const spelled = pgType.replace(/"/g, "").replace(/^DECIMAL\b/, "NUMERIC").replace(/^TIMESTAMPTZ\b/, "TIMESTAMP WITH TIME ZONE");
  const element = spelled.endsWith("[]") ? spelled.slice(0, -2) : spelled;
  return Object.values(UDT_COLUMN_TYPES).includes(element) || element.startsWith("disc_enum_") ? spelled : undefined;
}

/**
 * Convert the columns of properties of user scalars whose type isn't their
 * declared type's column type (see `ConvertColumnTypeOperation`) — one
 * created with the type of another module's same-named scalar. `declared`
 * holds those properties' columns only (see `DDLGenerator.namesUserScalar`).
 *
 * Returns one `ConvertColumnType` per declared column the database has with
 * another type than its declared one, both types being ones the DDL emits,
 * skipping columns the database has as TEXT (`reconcileTextColumns` converts
 * those) and columns whose type the pending migration (`planned`) already
 * changes. Tables and columns that don't exist yet are the pending
 * migration's to create, with the right type. Idempotent: once converted, the
 * column has its declared type and it returns nothing.
 */
export async function reconcileColumnTypes(
  declared: DeclaredColumn[],
  planned: MigrationOperation[],
  readExisting: ExistingColumnReader
): Promise<ConvertColumnTypeOperation[]> {
  const retyped = retypedColumns(planned);
  const columnsByTable = new Map<string, ExistingColumn[] | null>();
  const operations: ConvertColumnTypeOperation[] = [];

  for (const column of declared) {
    const expected = comparableColumnType(column.pgType);

    if (
      expected === undefined ||
      retyped.has(`${column.tableName}.${column.columnName}`) ||
      retyped.has(`${column.tableName}.*`)
    ) {
      continue;
    }

    if (!columnsByTable.has(column.tableName)) {
      columnsByTable.set(column.tableName, await readExisting(column.tableName));
    }

    const existing = columnsByTable.get(column.tableName)?.find(c => c.name === column.columnName);
    const actual = existing?.udtName === undefined ? undefined : udtColumnType(existing.udtName);

    if (actual !== undefined && actual !== expected && actual !== "TEXT" && actual !== "TEXT[]") {
      operations.push({ ...column, fromPgType: actual, kind: "ConvertColumnType" });
    }
  }

  return operations;
}

/**
 * Reads the `disc_abstract_mirror` triggers in the database: each table that
 * has one, with the abstract tables its rows are copied to. Injected by the
 * engine, like {@link ExistingColumnReader}.
 */
export type ExistingMirrorReader = () => Promise<Map<string, string[]>>;

/**
 * Create, change or drop the triggers that copy concrete types' rows to the
 * tables of the abstract types they extend (see `MirrorAbstractTypeOperation`).
 * Read from the database rather than diffed, so databases created before
 * Disc kept those copies get them — and their rows copied — like new ones.
 *
 * Returns one `MirrorAbstractType` per declared table whose trigger is
 * missing or copies to other tables than it should, and one with no
 * `abstractTables` (a drop) per declared table whose trigger it no longer
 * needs. Tables of the new schema that don't exist yet are the pending
 * migration's to create; their triggers come with them, since the backfill
 * runs after it. Idempotent: once the triggers match, it returns nothing.
 */
export async function reconcileAbstractMirrors(
  declared: DeclaredAbstractMirror[],
  readExisting: ExistingMirrorReader
): Promise<MirrorAbstractTypeOperation[]> {
  const existing = await readExisting();

  return declared
    .filter(mirror => {
      const current = existing.get(mirror.tableName) ?? [];
      return current.length !== mirror.abstractTables.length ||
        current.some((table, index) => table !== mirror.abstractTables[index]);
    })
    .map(mirror => ({ ...mirror, kind: "MirrorAbstractType" }));
}

/** A trigger the database has on a table the rewrite repair asked about. */
export interface ExistingTrigger {
  /** Source (`pg_proc.prosrc`) of the function it executes. */
  body: string;
  /** Whether it fires BEFORE, FOR EACH ROW — as a rewrite's does. */
  beforeRow: boolean;
  /** The events it fires on, sorted (`delete`, `insert`, `truncate`, `update`). */
  events: string[];
  /** Name of the function it executes. */
  function: string;
  name: string;
  table: string;
}

/** The existing tables among those asked about, and their triggers. */
export interface ExistingTriggers {
  tables: Set<string>;
  triggers: ExistingTrigger[];
}

/**
 * Reads the triggers of the given tables. Injected by the engine, like
 * {@link ExistingColumnReader}.
 */
export type ExistingTriggerReader = (tableNames: string[]) => Promise<ExistingTriggers>;

/** How the DDL generator names a rewrite's trigger and function, and what the function runs (see `DDLGenerator.rewriteTrigger`). */
export interface RewriteTriggerNaming {
  rewriteTrigger(tableName: string, propertyName: string, rewrite: RewriteDefinition): { body: string; events: string[]; function: string; name: string; };
}

/**
 * Create, replace or drop the triggers of `rewrite … using (…)` rules to
 * match the schema. Before Disc migrated rewrites, only CREATE TYPE created
 * them: a property added with a rewrite to an existing type got none, a
 * dropped property's trigger stayed behind (running its rule against a
 * column that no longer exists), and the stored snapshot recorded the
 * schema all the same — so the diff between two snapshots is empty.
 *
 * Compares every declared rewrite (`declared`) with the trigger of its name
 * on the type's table: a missing one is created; one firing on other events,
 * or running another function or function body, is dropped and created
 * again. A rewrite trigger (`<table>__<column>__rewrite`, or
 * `…__update_rewrite`) on the table that no rewrite declares is dropped.
 * Returns one `AlterType` of `DropRewrite` / `AddRewrite` per type that
 * differs.
 *
 * Skips the tables of types the pending migration (`planned`) creates or
 * drops, the properties whose rewrites it already adds or drops, and tables
 * that don't exist. Idempotent: once the triggers match, it returns nothing.
 */
export async function reconcileRewrites(
  declared: DeclaredRewrites[],
  planned: MigrationOperation[],
  naming: RewriteTriggerNaming,
  readExisting: ExistingTriggerReader
): Promise<AlterTypeOperation[]> {
  const plannedTables = new Set<string>();
  const plannedColumns = new Set<string>();
  const rewriteMembers = new Set(["AddProperty", "AddRewrite", "DropProperty", "DropRewrite"]);

  for (const op of planned) {
    if (op.kind === "CreateType" || op.kind === "DropType") {
      plannedTables.add(typeNameToTableName((op as CreateTypeOperation | DropTypeOperation).typeName));
    } else if (op.kind === "AlterType") {
      const tableName = typeNameToTableName((op as AlterTypeOperation).typeName);
      for (const sub of (op as AlterTypeOperation).operations) {
        if (rewriteMembers.has(sub.kind)) {
          const propertyName = sub.kind === "AddProperty" ?
            (sub as AddPropertyOperation).property.name :
            (sub as DropRewriteOperation).propertyName;
          plannedColumns.add(`${tableName}.${propNameToColumnName(propertyName)}`);
        }
      }
    }
  }

  const candidates = declared.filter(entry => !plannedTables.has(entry.tableName));

  if (candidates.length === 0) {
    return [];
  }

  const existing = await readExisting(candidates.map(entry => entry.tableName));
  const operations: AlterTypeOperation[] = [];

  for (const entry of candidates) {
    if (!existing.tables.has(entry.tableName)) {
      continue;
    }

    const triggers = new Map(existing.triggers.filter(trigger => trigger.table === entry.tableName).map(trigger => [trigger.name, trigger]));
    const declaredNames = new Set<string>();
    const changes: TypeOperation[] = [];

    for (const { propertyName, rewrite } of entry.rewrites) {
      const trigger = naming.rewriteTrigger(entry.tableName, propertyName, rewrite);
      const name = pgStoredName(trigger.name);
      declaredNames.add(name);

      if (plannedColumns.has(`${entry.tableName}.${propNameToColumnName(propertyName)}`)) {
        continue;
      }

      const actual = triggers.get(name);
      const matches = actual !== undefined && actual.beforeRow && actual.function === pgStoredName(trigger.function) &&
        actual.body.trim() === trigger.body && actual.events.join(",") === trigger.events.join(",");

      if (!matches) {
        if (actual) {
          changes.push({ events: rewrite.events, kind: "DropRewrite", propertyName } as DropRewriteOperation);
        }
        changes.push({ kind: "AddRewrite", propertyName, rewrite } as AddRewriteOperation);
      }
    }

    /*** A rewrite trigger no rewrite declares: its property's column is the part of the name between the table and the suffix. ***/
    const prefix = `${entry.tableName}__`;
    for (const trigger of triggers.values()) {
      const suffix = ["__update_rewrite", "__rewrite"].find(end => trigger.name.endsWith(end));
      if (!suffix || !trigger.name.startsWith(prefix) || declaredNames.has(trigger.name)) {
        continue;
      }

      const column = trigger.name.slice(prefix.length, -suffix.length);
      if (column === "" || plannedColumns.has(`${entry.tableName}.${column}`)) {
        continue;
      }

      /*** Events only name the trigger: an update-only rewrite's has the `update_` prefix, any other's none. ***/
      const events: RewriteDefinition["events"] = suffix === "__update_rewrite" ? ["update"] : ["insert", "update"];
      changes.push({ events, kind: "DropRewrite", propertyName: column } as DropRewriteOperation);
    }

    if (changes.length > 0) {
      operations.push({ kind: "AlterType", operations: changes, typeName: entry.typeName });
    }
  }

  return operations;
}

/** The finite CHECKs and columns the database has on the tables it was asked about. */
export interface ExistingFiniteChecks {
  /** CHECK constraints, keyed `<table>.<constraint>`. */
  checks: Set<string>;
  /** Columns, keyed `<table>.<column>`. */
  columns: Set<string>;
}

/**
 * Reads the CHECK constraints and columns of the given tables. Injected by
 * the engine, like {@link ExistingColumnReader}.
 */
export type ExistingFiniteCheckReader = (tableNames: string[]) => Promise<ExistingFiniteChecks>;

/**
 * Add the finite CHECK (no NaN or ±Infinity, and for a bigint no fractional
 * part; see `DDLGenerator.finiteCheck`) to `decimal` and `bigint` columns the
 * database has without it. Disc created such columns without one before it
 * emitted them, while the stored schema snapshot already declared their type
 * — so the differ, comparing two snapshots that agree, diffs to nothing.
 *
 * `checkName` names the CHECK a declared column should have (undefined for
 * other types). Returns one `AddFiniteCheck` per declared column that exists
 * and lacks it, skipping columns whose type the pending migration (`planned`)
 * changes (a property's type, `multi` or computed-ness, or a link's link
 * properties): its DDL adds the check itself. Tables and columns that don't
 * exist yet are the pending migration's to create, with the check. A stored
 * value the check rejects (a NaN written before Disc refused it) fails the
 * operation's DDL, naming the column and the value, so nothing changes.
 * Idempotent: once added, it returns nothing.
 */
export async function reconcileFiniteChecks(
  declared: DeclaredColumn[],
  planned: MigrationOperation[],
  checkName: (column: DeclaredColumn) => string | undefined,
  readExisting: ExistingFiniteCheckReader
): Promise<AddFiniteCheckOperation[]> {
  const retyped = retypedColumns(planned);
  const candidates = declared
    .map(column => ({ column, name: checkName(column) }))
    .filter((candidate): candidate is { column: DeclaredColumn; name: string; } =>
      candidate.name !== undefined &&
      !retyped.has(`${candidate.column.tableName}.${candidate.column.columnName}`) &&
      !retyped.has(`${candidate.column.tableName}.*`)
    );

  if (candidates.length === 0) {
    return [];
  }

  const existing = await readExisting([...new Set(candidates.map(({ column }) => column.tableName))]);

  return candidates
    .filter(({ column, name }) =>
      existing.columns.has(`${column.tableName}.${column.columnName}`) && !existing.checks.has(`${column.tableName}.${pgStoredName(name)}`)
    )
    .map(({ column }) => ({ ...column, kind: "AddFiniteCheck" }));
}
