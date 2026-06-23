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

/** A column the database currently reports for an existing table. */
export interface ExistingColumn {
  /** Column name as stored by PostgreSQL (already lowercased / unquoted). */
  name: string;
  /** `information_schema.columns.data_type` (e.g. "bigint", "text"). */
  dataType: string;
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
  const tableName = (header[1] ?? header[2]).toLowerCase();

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

/**
 * Reconcile a list of DDL statements against the live database. `CREATE TABLE`
 * statements whose target already exists with a matching shape are removed;
 * a divergent existing table raises a descriptive `MigrationError`.
 *
 * All non-`CREATE TABLE` statements and CREATE TABLEs for not-yet-existing
 * tables pass through unchanged and in order.
 */
export async function reconcileCreateTables(
  statements: string[],
  readColumns: ExistingColumnReader
): Promise<string[]> {
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

  return reconciled;
}

/**
 * Return the table a deferred dependent statement targets, or `null` if the
 * statement is not table-scoped in a way reconciliation cares about. Covers the
 * forms the DDL generator defers: `ALTER TABLE <t> ...` and
 * `CREATE [UNIQUE] INDEX ... ON <t> ...`.
 */
function dependentStatementTarget(statement: string): string | null {
  const trimmed = statement.trim();
  const alter = /^ALTER TABLE\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\b/i
    .exec(trimmed);
  if (alter) {
    return (alter[1] ?? alter[2]).toLowerCase();
  }
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b.*?\bON\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\b/i
    .exec(trimmed);
  if (index) {
    return (index[1] ?? index[2]).toLowerCase();
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
