/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * `disc db import <dir>` — import a Gel CSV export into a Disc database.
 *
 * Stage 1 (this file, for now): schema-aware classification of the export
 * directory. Each `*.csv` is matched against the project `Schema` and bucketed
 * into the work later stages consume — concrete object files, junction
 * (multi-link) files, and a set of intentional skips (abstract types, computed
 * links). No data is written yet; this produces and logs a manifest.
 */

/*** IMPORT ------------------------------------------- ***/

import { parse } from "@std/csv";

/*** UTILITY ------------------------------------------ ***/

import { coerceCell } from "./import-coerce.ts";
import { propNameToColumnName } from "../lib/identifiers.ts";

import type { CLIArgs } from "./commands.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import type { DatabaseConnection } from "../lib/database.ts";
import type { EdgeQLTypeInfo } from "./import-coerce.ts";
import type { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";

/*** EXPORT ------------------------------------------- ***/

/** A CSV that maps to a concrete object table (Pass 1 target). */
export interface ObjectFileEntry {
  /** Header-only file (no data rows). */
  empty: boolean;
  fileName: string;
  tableName: string;
  typeName: string;
}

/** A CSV that maps to a junction table for a stored multi-link (Pass 2 target). */
export interface LinkFileEntry {
  /** Header-only file (no data rows). */
  empty: boolean;
  fileName: string;
  junctionSourceColumn: string;
  junctionTable: string;
  junctionTargetColumn: string;
  linkName: string;
  typeName: string;
}

/** A CSV that was deliberately skipped, with a human-readable reason. */
export interface SkippedFileEntry {
  fileName: string;
  reason: string;
}

/** A CSV that could not be classified (schema/export mismatch). */
export interface ErrorFileEntry {
  fileName: string;
  reason: string;
}

/** Structured result of classifying an export directory. */
export interface ImportManifest {
  errors: ErrorFileEntry[];
  linkFiles: LinkFileEntry[];
  objectFiles: ObjectFileEntry[];
  skipped: SkippedFileEntry[];
}

/** Parsed components of an export CSV filename. */
interface ParsedFileName {
  linkName: string | null;
  module: string;
  typeName: string;
}

/**
 * Classifies and (in later stages) imports a Gel CSV export.
 */
export class DbImport {
  private readonly args: CLIArgs;
  private readonly dir: string;
  private readonly pool: ConnectionPool;
  private readonly schema: Schema;

  constructor(schema: Schema, pool: ConnectionPool, dir: string, args: CLIArgs) {
    this.args = args;
    this.dir = dir;
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Stage 1 entry point: discover and classify every CSV in the export
   * directory, print a manifest, and exit non-zero on any unknown-type or
   * unknown-link error (those indicate a schema/export mismatch).
   */
  async run(): Promise<ImportManifest> {
    const fileNames = await this.enumerateCsvFiles();
    const manifest = await this.classify(fileNames);

    this.logManifest(manifest);

    if (manifest.errors.length > 0) {
      console.error(`\n✗ ${manifest.errors.length} file${manifest.errors.length === 1 ? "" : "s"} could not be classified (schema/export mismatch).`);
      Deno.exit(1);
    }

    await this.importData(manifest);
    return manifest;
  }

  /**
   * Execute the two-pass import inside a single transaction so any failure
   * rolls back the whole dataset. Pass 1 inserts concrete object rows
   * (ordered so single-link FKs resolve); Pass 2 inserts junction rows.
   * Prints a per-table inserted-row-count summary; exits non-zero on error.
   */
  private async importData(manifest: ImportManifest): Promise<void> {
    const onConflict = this.resolveOnConflict();
    const plans = this.buildObjectPlans(manifest.objectFiles);
    const order = this.topoSortObjectTables(plans);
    const counts = new Map<string, number>();

    try {
      await this.pool.transaction(async conn => {
        /*** Pass 1: concrete object rows, dependency-ordered. ***/
        for (const tableName of order) {
          const plan = plans.get(tableName)!;
          const inserted = await this.insertObjectRows(conn, plan, onConflict);
          counts.set(plan.fileName, inserted);
        }

        /*** Pass 2: junction (multi-link) rows. ***/
        for (const link of manifest.linkFiles) {
          if (link.empty)
            continue;

          const inserted = await this.insertLinkRows(conn, link, onConflict);
          counts.set(link.fileName, inserted);
        }
      });
    } catch (err) {
      console.error(`\n✗ Import failed (transaction rolled back): ${err instanceof Error ? err.message : String(err)}`);
      Deno.exit(1);
    }

    this.logImportSummary(manifest, counts);
  }

  /** Resolve and validate the `--on-conflict` flag (`skip` | `error`). */
  private resolveOnConflict(): "skip" | "error" {
    const raw = this.args["on-conflict"];

    if (raw === undefined || raw === "error")
      return "error";

    if (raw === "skip")
      return "skip";

    console.error(`✗ invalid --on-conflict "${raw}" (expected "skip" or "error")`);
    Deno.exit(1);
  }

  /** List `*.csv` files in the import directory (filenames only, sorted). */
  private async enumerateCsvFiles(): Promise<string[]> {
    const names: string[] = [];

    for await (const entry of Deno.readDir(this.dir)) {
      if (entry.isFile && entry.name.toLowerCase().endsWith(".csv"))
        names.push(entry.name);
    }

    names.sort();
    return names;
  }

  /**
   * Parse a filename of the form `<module>_<TypeName>[.<linkName>].csv`.
   *
   * The module prefix is separated on the FIRST `_`; the remainder is split on
   * `.` to yield the (PascalCase, underscore-free) `TypeName` and an optional
   * `linkName`. The module is only a disambiguator and is otherwise ignored,
   * since `Schema.types` is keyed by unqualified name for the `default` module.
   */
  parseFileName(fileName: string): ParsedFileName | null {
    if (!fileName.toLowerCase().endsWith(".csv"))
      return null;

    const base = fileName.slice(0, fileName.length - ".csv".length);
    const underscore = base.indexOf("_");

    if (underscore <= 0 || underscore === base.length - 1)
      return null;

    const module = base.slice(0, underscore);
    const remainder = base.slice(underscore + 1);
    const dot = remainder.indexOf(".");

    if (dot === -1)
      return { linkName: null, module, typeName: remainder };

    const typeName = remainder.slice(0, dot);
    const linkName = remainder.slice(dot + 1);

    if (typeName.length === 0 || linkName.length === 0)
      return null;

    return { linkName, module, typeName };
  }

  /**
   * Resolve an unqualified type name against `Schema.types`. Keys are either the
   * bare type name (module `default`) or `module::TypeName`; match by the
   * unqualified component so the filename's module prefix need not align with
   * the SDL module.
   */
  resolveType(typeName: string): TypeDef | undefined {
    const direct = this.schema.types.get(typeName);

    if (direct)
      return direct;

    for (const [key, def] of this.schema.types) {
      const unqualified = key.includes("::") ?
        key.slice(key.lastIndexOf("::") + 2) :
        key;

      if (unqualified === typeName && def.kind === "object")
        return def;
    }

    return undefined;
  }

  /**
   * Classify every CSV filename into the manifest buckets. `emptyChecker`
   * defaults to reading each file's header/rows from disk; tests inject a
   * synchronous stub so classification can be exercised without fixtures.
   */
  async classify(fileNames: string[], emptyChecker?: (fileName: string) => boolean | Promise<boolean>): Promise<ImportManifest> {
    const manifest: ImportManifest = {
      errors: [],
      linkFiles: [],
      objectFiles: [],
      skipped: []
    };

    const isEmpty = emptyChecker ?? ((name: string) => this.isFileEmpty(name));

    for (const fileName of fileNames) {
      const parsed = this.parseFileName(fileName);

      if (!parsed) {
        manifest.errors.push({
          fileName,
          reason: `unrecognized filename (expected <module>_<TypeName>[.<linkName>].csv)`
        });

        continue;
      }

      const typeDef = this.resolveType(parsed.typeName);

      if (!typeDef) {
        manifest.errors.push({
          fileName,
          reason: `unknown type "${parsed.typeName}"`
        });

        continue;
      }

      /*** Abstract types are never stored (single-leaf storage); their export
           CSV is a redundant union of concrete descendants. Skip. ***/
      if (typeDef.abstract === true) {
        manifest.skipped.push({
          fileName,
          reason: `abstract: ${parsed.typeName}`
        });

        continue;
      }

      if (parsed.linkName === null) {
        manifest.objectFiles.push({
          empty: await isEmpty(fileName),
          fileName,
          tableName: typeDef.tableName,
          typeName: parsed.typeName
        });

        continue;
      }

      /*** Link file: must resolve to a stored multi-link with a junction. ***/
      const linkDef = typeDef.links.get(parsed.linkName);

      if (!linkDef) {
        manifest.errors.push({
          fileName,
          reason: `unknown link "${parsed.typeName}.${parsed.linkName}"`
        });

        continue;
      }

      if (linkDef.computed === true) {
        manifest.skipped.push({
          fileName,
          reason: `computed link: ${parsed.typeName}.${parsed.linkName}`
        });

        continue;
      }

      if (linkDef.multi !== true) {
        manifest.skipped.push({
          fileName,
          reason: `non-multi link (unexpected .link file): ${parsed.typeName}.${parsed.linkName}`
        });

        continue;
      }

      manifest.linkFiles.push({
        empty: await isEmpty(fileName),
        fileName,
        junctionSourceColumn: linkDef.junctionSourceColumn ?? "source_id",
        junctionTable: linkDef.junctionTable ?? this.deriveJunctionTable(typeDef, linkDef),
        junctionTargetColumn: linkDef.junctionTargetColumn ?? "target_id",
        linkName: parsed.linkName,
        typeName: parsed.typeName
      });
    }

    return manifest;
  }

  /**
   * Fallback junction-table name when a `LinkDef` carries none — `<table>_<link>`
   * in snake_case, matching the migration engine's convention.
   */
  private deriveJunctionTable(typeDef: TypeDef, linkDef: LinkDef): string {
    const link = linkDef
      .name
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .toLowerCase();

    return `${typeDef.tableName}_${link}`;
  }

  /** True if the CSV has no data rows (header-only or completely empty). */
  private async isFileEmpty(fileName: string): Promise<boolean> {
    const path = `${this.dir}/${fileName}`;
    const text = await Deno.readTextFile(path);

    if (text.trim().length === 0)
      return true;

    const rows = parse(text, { skipFirstRow: false });
    /*** Row 0 is the header; any further row is data. ***/
    return rows.length <= 1;
  }

  /** Print the classification manifest to stdout. */
  private logManifest(manifest: ImportManifest): void {
    console.log(`\nImport manifest for ${this.dir}\n`);
    console.log(`Object files (${manifest.objectFiles.length}):`);

    for (const obj of manifest.objectFiles) {
      const note = obj.empty ? " (empty — no-op)" : "";
      console.log(`  ${obj.fileName} → ${obj.tableName}${note}`);
    }

    console.log(`\nLink files (${manifest.linkFiles.length}):`);

    for (const link of manifest.linkFiles) {
      const note = link.empty ? " (empty — no-op)" : "";
      console.log(`  ${link.fileName} → ${link.junctionTable} (${link.junctionSourceColumn}, ${link.junctionTargetColumn})${note}`);
    }

    console.log(`\nSkipped (${manifest.skipped.length}):`);

    for (const skip of manifest.skipped) {
      console.log(`  skip ${skip.reason} [${skip.fileName}]`);
    }

    if (manifest.errors.length > 0) {
      console.log(`\nErrors (${manifest.errors.length}):`);

      for (const err of manifest.errors) {
        console.log(`  ✗ ${err.reason} [${err.fileName}]`);
      }
    }
  }

  /**
   * Print the per-table row-count summary. With `--on-conflict skip` the counts
   * are rows *attempted* (the importer cannot cheaply distinguish a fresh insert
   * from a `DO NOTHING`), so the wording reflects that rather than claiming a
   * net-new "inserted" count it can't substantiate.
   */
  private logImportSummary(manifest: ImportManifest, counts: Map<string, number>): void {
    const skipMode = this.resolveOnConflict() === "skip";
    const noun = skipMode ? "rows attempted" : "rows inserted";

    console.log(skipMode ? `\nProcessed (--on-conflict skip — counts are rows attempted, not net-new):` : `\nImported:`);

    let total = 0;

    for (const obj of manifest.objectFiles) {
      const n = counts.get(obj.fileName) ?? 0;
      total += n;
      console.log(`  ${obj.tableName}: ${n}`);
    }

    for (const link of manifest.linkFiles) {
      const n = counts.get(link.fileName) ?? 0;
      total += n;
      const note = link.empty ? " (empty — no-op)" : "";
      console.log(`  ${link.junctionTable}: ${n}${note}`);
    }

    const skippedTotal = manifest.skipped.length;
    console.log(`\nTotal ${noun}: ${total} (skipped ${skippedTotal} file${skippedTotal === 1 ? "" : "s"})`);
  }

  /*** STAGE 3: PASS 1 — concrete object rows ----------- ***/

  /**
   * Build a column plan for every non-empty object file: resolve each CSV
   * header to a property column or a single-link FK column, dropping
   * `__type__` and any header with no schema match (with a warning). Keyed by
   * table name.
   */
  private buildObjectPlans(objectFiles: ObjectFileEntry[]): Map<string, ObjectPlan> {
    const plans = new Map<string, ObjectPlan>();

    for (const file of objectFiles) {
      if (file.empty)
        continue;

      const typeDef = this.resolveType(file.typeName);

      /*** Should never happen post-classification, but keep the type narrow. ***/
      if (!typeDef)
        continue;

      const path = `${this.dir}/${file.fileName}`;
      const text = Deno.readTextFileSync(path);
      const rows = parse(text, { skipFirstRow: false }) as string[][];

      if (rows.length === 0)
        continue;

      const header = rows[0];
      const dataRows = rows.slice(1);
      const columns = this.buildColumnPlan(typeDef, header, file.fileName);

      plans.set(typeDef.tableName, {
        columns,
        dataRows,
        fileName: file.fileName,
        tableName: typeDef.tableName,
        typeName: file.typeName
      });
    }

    return plans;
  }

  /**
   * Resolve each CSV header to a {@link ColumnPlan}. A header matches either a
   * property (column via `propNameToColumnName`) or a non-multi link FK (its
   * `columnName`, e.g. `creator_id`). `__type__` and unmatched headers are
   * dropped (the latter with a warning).
   */
  buildColumnPlan(typeDef: TypeDef, header: string[], fileName: string): ColumnPlan[] {
    const columns: ColumnPlan[] = [];
    /*** Index single links by their FK column name for O(1) header lookup. ***/
    const fkByColumn = new Map<string, LinkDef>();

    for (const link of typeDef.links.values()) {
      if (link.multi || link.computed)
        continue;

      const col = link.columnName ?? `${propNameToColumnName(link.name)}_id`;
      fkByColumn.set(col, link);
    }

    for (let i = 0; i < header.length; i++) {
      const raw = header[i];

      if (raw === "__type__")
        continue;

      const prop = typeDef.properties.get(raw);

      if (prop) {
        columns.push({
          columnName: prop.columnName,
          csvIndex: i,
          typeInfo: this.propertyTypeInfo(prop)
        });

        continue;
      }

      /*** A link FK header is the snake_case column (e.g. `creator_id`),
           which is exactly the CSV header Gel emits for a single link. ***/
      const fk = fkByColumn.get(raw);

      if (fk) {
        columns.push({
          columnName: fk.columnName ?? raw,
          csvIndex: i,
          typeInfo: { type: "uuid", required: fk.required, hasDefault: false }
        });

        continue;
      }

      console.warn(`  dropping unmatched column "${raw}" in ${fileName} (no property or single-link FK)`);
    }

    return columns;
  }

  /** Build the coercion type info for a property, including tuple field names. */
  private propertyTypeInfo(prop: PropertyDef): EdgeQLTypeInfo {
    const type = prop.edgeqlType ?? prop.type;
    const isEnum = this.schema.types.get(type)?.kind === "enum" ||
      this.schema.types.get(prop.type)?.kind === "enum";

    const info: EdgeQLTypeInfo = {
      hasDefault: prop.hasDefault ?? false,
      isEnum,
      required: prop.required,
      type
    };

    if (type.includes("tuple<"))
      info.tupleFields = extractTupleFields(type);

    return info;
  }

  /**
   * Topologically sort object tables so a table with a single-link FK is
   * inserted after the table it points at. Throws on a cycle, naming it.
   */
  topoSortObjectTables(plans: Map<string, ObjectPlan>): string[] {
    /*** Edge table -> set of tables it depends on (must come first). ***/
    const deps = new Map<string, Set<string>>();

    for (const [tableName, plan] of plans) {
      const typeDef = this.resolveType(plan.typeName);
      const set = new Set<string>();

      if (typeDef) {
        for (const link of typeDef.links.values()) {
          if (link.multi || link.computed)
            continue;

          const target = this.resolveType(link.target);

          /*** Only order against tables we are actually importing, and never
               self-loop on a self-referential link (a row's FK can point at
               another row in the same table; that's intra-table and handled by
               row order, not table order). ***/
          if (target && plans.has(target.tableName) && target.tableName !== tableName)
            set.add(target.tableName);
        }
      }

      deps.set(tableName, set);
    }

    const sorted: string[] = [];
    const state = new Map<string, "visiting" | "done">();

    const visit = (table: string, stack: string[]): void => {
      const status = state.get(table);

      if (status === "done")
        return;

      if (status === "visiting") {
        const cycleStart = stack.indexOf(table);
        const cycle = [...stack.slice(cycleStart), table].join(" → ");

        throw new Error(
          `single-link FK cycle detected among object tables: ${cycle}. ` +
            `Deferred-constraint import is not supported (v1); break the cycle to import.`
        );
      }

      state.set(table, "visiting");

      for (const dep of deps.get(table) ?? []) {
        visit(dep, [...stack, table]);
      }

      state.set(table, "done");
      sorted.push(table);
    };

    for (const table of plans.keys()) {
      visit(table, []);
    }

    return sorted;
  }

  /** Insert all rows for one object table; returns the inserted count. */
  private async insertObjectRows(conn: DatabaseConnection, plan: ObjectPlan, onConflict: "skip" | "error"): Promise<number> {
    if (plan.columns.length === 0 || plan.dataRows.length === 0)
      return 0;

    const colSql = plan.columns.map(c => escapeIdent(c.columnName)).join(", ");

    const placeholders = plan
      .columns
      .map((_c, i) => `$${i + 1}`)
      .join(", ");

    const conflict = onConflict === "skip" ?
      ` ON CONFLICT (${escapeIdent("id")}) DO NOTHING` :
      "";

    const sql = `INSERT INTO ${escapeIdent(plan.tableName)} (${colSql}) VALUES (${placeholders})${conflict}`;
    let count = 0;

    for (const row of plan.dataRows) {
      const params = plan
        .columns
        .map(c => coerceCell(row[c.csvIndex] ?? "", c.typeInfo));

      await conn.execute(sql, params);
      count++;
    }

    return count;
  }

  /*** STAGE 4: PASS 2 — junction (multi-link) rows ----- ***/

  /** Insert all `(source,target)` rows for one link file; returns the count. */
  private async insertLinkRows(conn: DatabaseConnection, link: LinkFileEntry, onConflict: "error" | "skip"): Promise<number> {
    const path = `${this.dir}/${link.fileName}`;
    const text = Deno.readTextFileSync(path);
    const rows = parse(text, { skipFirstRow: false }) as string[][];

    if (rows.length <= 1)
      return 0;

    const header = rows[0];
    const sourceIdx = header.indexOf("source");
    const targetIdx = header.indexOf("target");

    if (sourceIdx === -1 || targetIdx === -1)
      throw new Error(`link file ${link.fileName} is missing "source"/"target" columns (found: ${header.join(", ")})`);

    const conflict = onConflict === "skip" ?
      ` ON CONFLICT (${escapeIdent(link.junctionSourceColumn)}, ${escapeIdent(link.junctionTargetColumn)}) DO NOTHING` :
      "";

    const sql = `INSERT INTO ${escapeIdent(link.junctionTable)} (${escapeIdent(link.junctionSourceColumn)}, ${
      escapeIdent(link.junctionTargetColumn)
    }) VALUES ($1, $2)${conflict}`;

    let count = 0;

    for (const row of rows.slice(1)) {
      await conn.execute(sql, [row[sourceIdx], row[targetIdx]]);
      count++;
    }

    return count;
  }
}

/*** HELPER ------------------------------------------- ***/

/** A resolved CSV-column → table-column mapping with its coercion type. */
export interface ColumnPlan {
  /** Target SQL column name (snake_case). */
  columnName: string;
  /** Index of this column in the CSV header/row. */
  csvIndex: number;
  /** Coercion type info for the cell. */
  typeInfo: EdgeQLTypeInfo;
}

/** Everything needed to insert one object file's rows into its table. */
export interface ObjectPlan {
  columns: ColumnPlan[];
  dataRows: string[][];
  fileName: string;
  tableName: string;
  typeName: string;
}

/**
 * Escape a SQL identifier by double-quoting and doubling embedded quotes.
 * Import identifiers are schema-derived snake_case, but quoting unconditionally
 * is correct for any identifier and avoids reserved-keyword collisions
 * (mirrors the quoting branch of `migration/ddl.ts` `escapeIdentifier`).
 */
export function escapeIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

/**
 * Extract the ordered field names from a (possibly array-wrapped) tuple type
 * string. Named tuples (`tuple<name: str, url: str>`) yield `["name","url"]`;
 * unnamed tuples (`tuple<str, str>`) fall back to positional `["f0","f1"]`.
 * Only the outermost tuple's fields are extracted.
 */
export function extractTupleFields(type: string): string[] {
  const open = type.indexOf("tuple<");

  if (open === -1)
    return [];

  /*** Find the matching closing `>` for this `tuple<`. ***/
  const start = open + "tuple<".length;
  let depth = 0;
  let end = -1;

  for (let i = start; i < type.length; i++) {
    const ch = type[i];

    if (ch === "<") {
      depth++;
    } else if (ch === ">") {
      if (depth === 0) {
        end = i;
        break;
      }

      depth--;
    }
  }

  if (end === -1)
    return [];

  const body = type.slice(start, end);
  const parts = splitTopLevel(body);

  return parts.map((part, i) => {
    const colon = topLevelColonIndex(part);

    if (colon === -1)
      return `f${i}`;

    return part.slice(0, colon).trim();
  });
}

/** Split a tuple body on top-level commas (ignoring commas inside `<...>`). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of body) {
    if (ch === "<")
      depth++;
    else if (ch === ">")
      depth--;

    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";

      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0)
    parts.push(current);

  return parts;
}

/** Index of the field-name `:` separator at depth 0, or -1 for unnamed. */
function topLevelColonIndex(part: string): number {
  let depth = 0;

  for (let i = 0; i < part.length; i++) {
    const ch = part[i];

    if (ch === "<")
      depth++;
    else if (ch === ">")
      depth--;
    else if (ch === ":" && depth === 0)
      return i;
  }

  return -1;
}
