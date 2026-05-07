/**
 * Live PostgreSQL introspection queries (#3452 — Phase 4)
 *
 * Reads `information_schema` and `pg_catalog` to produce
 * `IntrospectionData` from a real database. The pure transformer in
 * `pg-introspect.ts` then turns that into a Disc `Schema`.
 *
 * Kept narrow on purpose: only the metadata categories the
 * transformer consumes (tables, columns, primary keys, unique
 * constraints, foreign keys). Indexes / check constraints / triggers
 * land in a follow-up if needed.
 */

import type { DatabaseConnection } from "../lib/database.ts";
import type { IntrospectedColumn, IntrospectedForeignKey, IntrospectedTable, IntrospectionData } from "./pg-introspect.ts";

export interface IntrospectOptions {
  /**
   * Schemas to introspect. Defaults to `['public']`. System schemas
   * (`pg_*`, `information_schema`) are always excluded.
   */
  schemas?: string[];
  /**
   * Optional predicate filtering tables by name. Useful for tests
   * that share a schema but want to scope to their own fixtures.
   */
  tableFilter?: (tableName: string) => boolean;
}

const SYSTEM_SCHEMA_PATTERNS = [
  /^pg_/,
  /^information_schema$/,
];

function isSystemSchema(s: string): boolean {
  return SYSTEM_SCHEMA_PATTERNS.some((p) => p.test(s));
}

export async function introspectDatabase(
  db: DatabaseConnection,
  opts: IntrospectOptions = {},
): Promise<IntrospectionData> {
  const schemas = (opts.schemas ?? ["public"]).filter((s) => !isSystemSchema(s));
  const tableFilter = opts.tableFilter ?? (() => true);

  // ── tables + columns ─────────────────────────────────────────────────
  const columnsByTable = new Map<string, IntrospectedColumn[]>();
  const tableSchema = new Map<string, string>();
  const allTableNames = new Set<string>();

  // Use unnest($1::text[]) so the schemas list goes through one parameter
  // — Deno's pg client interpolates arrays without complaint that way.
  const colRows = await db.query(
    `
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      c.udt_name,
      c.is_nullable,
      c.column_default
    FROM information_schema.columns c
    WHERE c.table_schema = ANY($1::text[])
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `,
    [schemas],
  );

  for (const row of colRows.rows) {
    const tableName = row.table_name as string;
    if (!tableFilter(tableName)) continue;
    if (!columnsByTable.has(tableName)) {
      columnsByTable.set(tableName, []);
      tableSchema.set(tableName, row.table_schema as string);
      allTableNames.add(tableName);
    }
    columnsByTable.get(tableName)!.push({
      name: row.column_name as string,
      pgType: normalizePgType(
        row.data_type as string,
        row.udt_name as string | null,
      ),
      nullable: row.is_nullable === "YES",
      hasDefault: row.column_default !== null,
      defaultExpression: row.column_default as string | null ?? undefined,
    });
  }

  // ── primary keys ─────────────────────────────────────────────────────
  const pkByTable = new Map<string, string[]>();
  const pkRows = await db.query(
    `
    SELECT
      tc.table_schema,
      tc.table_name,
      kcu.column_name,
      kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = ANY($1::text[])
    ORDER BY tc.table_name, kcu.ordinal_position
    `,
    [schemas],
  );
  for (const row of pkRows.rows) {
    const tn = row.table_name as string;
    if (!tableFilter(tn)) continue;
    if (!pkByTable.has(tn)) pkByTable.set(tn, []);
    pkByTable.get(tn)!.push(row.column_name as string);
  }

  // ── unique constraints ───────────────────────────────────────────────
  // Group columns by constraint name so multi-column uniques stay
  // grouped (a single UNIQUE on (a, b) becomes one entry, not two).
  const uniqueByTable = new Map<string, Map<string, string[]>>();
  const uniqueRows = await db.query(
    `
    SELECT
      tc.table_name,
      tc.constraint_name,
      kcu.column_name,
      kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE'
      AND tc.table_schema = ANY($1::text[])
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
    `,
    [schemas],
  );
  for (const row of uniqueRows.rows) {
    const tn = row.table_name as string;
    if (!tableFilter(tn)) continue;
    if (!uniqueByTable.has(tn)) uniqueByTable.set(tn, new Map());
    const byConstraint = uniqueByTable.get(tn)!;
    const cn = row.constraint_name as string;
    if (!byConstraint.has(cn)) byConstraint.set(cn, []);
    byConstraint.get(cn)!.push(row.column_name as string);
  }

  // ── foreign keys ─────────────────────────────────────────────────────
  // information_schema's referential_constraints + key_column_usage
  // joined gives us the from/to columns. ON DELETE comes from
  // referential_constraints.delete_rule.
  const fks: IntrospectedForeignKey[] = [];
  const fkRows = await db.query(
    `
    SELECT
      tc.table_schema     AS from_schema,
      tc.table_name       AS from_table,
      kcu.column_name     AS from_column,
      ccu.table_name      AS to_table,
      ccu.column_name     AS to_column,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
     AND tc.table_schema = rc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON rc.unique_constraint_name = ccu.constraint_name
     AND rc.unique_constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = ANY($1::text[])
    ORDER BY tc.table_name, kcu.ordinal_position
    `,
    [schemas],
  );
  for (const row of fkRows.rows) {
    const fromTable = row.from_table as string;
    if (!tableFilter(fromTable)) continue;
    fks.push({
      fromTable,
      fromColumn: row.from_column as string,
      toTable: row.to_table as string,
      toColumn: row.to_column as string,
      onDelete: mapDeleteRule(row.delete_rule as string | null),
    });
  }

  // ── assemble ─────────────────────────────────────────────────────────
  const tables: IntrospectedTable[] = [];
  for (const tn of [...allTableNames].sort()) {
    const cols = columnsByTable.get(tn) ?? [];
    const pk = pkByTable.get(tn);
    const uniques = [...(uniqueByTable.get(tn)?.values() ?? [])];
    tables.push({
      schemaName: tableSchema.get(tn) ?? "public",
      tableName: tn,
      columns: cols,
      primaryKey: pk,
      uniqueConstraints: uniques.length > 0 ? uniques : undefined,
    });
  }

  return { tables, foreignKeys: fks };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `information_schema.columns.data_type` reports verbose names like
 * `"character varying"` or `"timestamp with time zone"`. The transformer's
 * type map keys are these canonical names, but PG's `udt_name` (e.g.
 * `varchar`, `int4`, `timestamptz`) is the more authoritative shorthand.
 * Prefer the verbose form when it's a recognized canonical name; fall
 * back to udt_name otherwise (covers things like `citext`).
 */
function normalizePgType(dataType: string, udtName: string | null): string {
  const dt = dataType.toLowerCase();
  if (dt === "user-defined" && udtName) return udtName.toLowerCase();
  if (dt === "array" && udtName) return udtName.toLowerCase();
  return dt;
}

function mapDeleteRule(
  rule: string | null,
): IntrospectedForeignKey["onDelete"] | undefined {
  if (!rule) return undefined;
  switch (rule.toUpperCase()) {
    case "CASCADE":
      return "cascade";
    case "RESTRICT":
      return "restrict";
    case "SET NULL":
      return "set_null";
    case "NO ACTION":
      return "no_action";
    default:
      return undefined;
  }
}
