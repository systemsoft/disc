/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL → Disc Schema introspection (#3452)
 *
 * Pure transformer: takes flat metadata describing a PG database
 * (tables, columns, FKs) and produces an in-memory `Schema` that
 * can be serialized via `sdl-serializer.ts`.
 *
 * The actual SQL queries that produce the input metadata are a
 * separate module (`introspect-from-pg.ts`) so this transformer can
 * be tested without a live Postgres connection.
 *
 * Mapping rules:
 *   - Each PG table becomes an object type, named PascalCase-singular
 *     of the table name.
 *   - PG columns become properties, with `nullable: false` → required
 *     and `UNIQUE` → `constraint exclusive`.
 *   - PG foreign-key columns are removed from the property list and
 *     replaced with a single link named after the column with the
 *     `_id` suffix stripped.
 *   - Junction tables (exactly two FK columns, both PK members, no
 *     other meaningful columns) are not emitted as types; instead
 *     they yield reciprocal `multi` links on each side.
 *   - Tables in non-`public` schemas land in same-named modules
 *     (e.g. `billing.invoices` → `billing::Invoice`).
 *   - Disc-internal tables (`disc_*`) are skipped.
 */

import { getBuiltinFunctions } from "./builtin-functions.ts";
import type { LinkDef, PropertyDef, Schema, TypeDef } from "./context.ts";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface IntrospectedColumn {
  name: string;
  pgType: string;
  nullable: boolean;
  hasDefault: boolean;
  defaultExpression?: string;
}

export interface IntrospectedTable {
  schemaName: string;
  tableName: string;
  columns: IntrospectedColumn[];
  primaryKey?: string[];
  uniqueConstraints?: string[][];
  checkConstraints?: { name: string; expression: string; }[];
}

export interface IntrospectedForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete?: "cascade" | "restrict" | "set_null" | "no_action";
}

export interface IntrospectionData {
  tables: IntrospectedTable[];
  foreignKeys: IntrospectedForeignKey[];
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

const PG_TO_EDGEQL: Record<string, string> = {
  text: "str",
  varchar: "str",
  "character varying": "str",
  char: "str",
  character: "str",
  smallint: "int16",
  int2: "int16",
  integer: "int32",
  int4: "int32",
  bigint: "int64",
  int8: "int64",
  real: "float32",
  float4: "float32",
  "double precision": "float64",
  float8: "float64",
  boolean: "bool",
  bool: "bool",
  bytea: "bytes",
  timestamptz: "datetime",
  "timestamp with time zone": "datetime",
  timestamp: "local_datetime",
  "timestamp without time zone": "local_datetime",
  date: "local_date",
  time: "local_time",
  "time without time zone": "local_time",
  interval: "duration",
  uuid: "uuid",
  numeric: "decimal",
  decimal: "decimal",
  json: "json",
  jsonb: "json"
};

export function pgTypeToEdgeqlType(pgType: string): string {
  const norm = pgType.toLowerCase().trim();
  return PG_TO_EDGEQL[norm] ?? "str";
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function tableToTypeName(tableName: string): string {
  // snake_case → PascalCase, then drop trailing `s` for singular form.
  const pascal = tableName
    .split("_")
    .filter(s => s.length > 0)
    .map(s => s[0].toUpperCase() + s.slice(1).toLowerCase())
    .join("");
  return singularize(pascal);
}

function singularize(name: string): string {
  if (name.endsWith("ies")) {
    return name.slice(0, -3) + "y";
  }
  if (name.endsWith("ses") || name.endsWith("xes")) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss")) {
    return name.slice(0, -1);
  }
  return name;
}

function fkColumnToLinkName(columnName: string): string {
  // Convention: `<thing>_id` → `<thing>`. Otherwise pass through.
  if (columnName.endsWith("_id")) {
    return columnName.slice(0, -3);
  }
  return columnName;
}

function isDiscInternal(tableName: string): boolean {
  return tableName.startsWith("disc_");
}

function moduleForSchema(schemaName: string): string {
  return schemaName === "public" ? "default" : schemaName;
}

function qualifyTypeName(typeName: string, module: string): string {
  return module === "default" ? typeName : `${module}::${typeName}`;
}

// ---------------------------------------------------------------------------
// Junction-table detection
// ---------------------------------------------------------------------------

interface JunctionInfo {
  tableName: string;
  leftColumn: string;
  leftTarget: string; // table name (not type name)
  rightColumn: string;
  rightTarget: string;
}

function detectJunctions(data: IntrospectionData): JunctionInfo[] {
  const junctions: JunctionInfo[] = [];
  for (const t of data.tables) {
    const fks = data.foreignKeys.filter(fk => fk.fromTable === t.tableName);
    if (fks.length !== 2) {
      continue;
    }
    // Junction table: every column is part of the composite PK and is itself
    // a foreign key. No payload columns allowed (those would mean it's a
    // first-class associative entity, not a pure junction).
    const pk = t.primaryKey ?? [];
    if (pk.length !== 2) {
      continue;
    }
    const fkCols = new Set(fks.map(f => f.fromColumn));
    if (![...pk].every(c => fkCols.has(c))) {
      continue;
    }
    // Non-FK, non-PK columns disqualify (e.g. created_at, role)
    const extraCols = t.columns.filter(
      c => !fkCols.has(c.name)
    );
    if (extraCols.length > 0) {
      continue;
    }

    // Order by FK source-column position to make the result deterministic.
    const sortedFks = [...fks].sort((a, b) => a.fromColumn.localeCompare(b.fromColumn));
    junctions.push({
      tableName: t.tableName,
      leftColumn: sortedFks[0].fromColumn,
      leftTarget: sortedFks[0].toTable,
      rightColumn: sortedFks[1].fromColumn,
      rightTarget: sortedFks[1].toTable
    });
  }
  return junctions;
}

// ---------------------------------------------------------------------------
// Main transformer
// ---------------------------------------------------------------------------

export function buildSchemaFromIntrospection(
  data: IntrospectionData
): Schema {
  const types = new Map<string, TypeDef>();
  const junctions = detectJunctions(data);
  const junctionTableNames = new Set(junctions.map(j => j.tableName));

  // Build a lookup: table name → PK→{module, type} so FKs can resolve targets.
  const targetByTable = new Map<
    string,
    { module: string; typeName: string; qualified: string; }
  >();
  for (const t of data.tables) {
    if (isDiscInternal(t.tableName)) {
      continue;
    }
    if (junctionTableNames.has(t.tableName)) {
      continue;
    }
    const module = moduleForSchema(t.schemaName);
    const typeName = tableToTypeName(t.tableName);
    targetByTable.set(t.tableName, {
      module,
      typeName,
      qualified: qualifyTypeName(typeName, module)
    });
  }

  // Index FKs by source table for fast lookup
  const fksByFromTable = new Map<string, IntrospectedForeignKey[]>();
  for (const fk of data.foreignKeys) {
    if (!fksByFromTable.has(fk.fromTable)) {
      fksByFromTable.set(fk.fromTable, []);
    }
    fksByFromTable.get(fk.fromTable)!.push(fk);
  }

  // Build object types from tables (skipping junctions and internal tables)
  for (const t of data.tables) {
    if (isDiscInternal(t.tableName)) {
      continue;
    }
    if (junctionTableNames.has(t.tableName)) {
      continue;
    }

    const target = targetByTable.get(t.tableName)!;
    const typeDef = buildObjectType(t, target.module, target.typeName, {
      fksByFromTable,
      targetByTable
    });
    types.set(target.qualified, typeDef);
  }

  // Apply junction-derived multi links to both sides
  for (const j of junctions) {
    applyJunction(j, types, targetByTable);
  }

  return {
    types,
    functions: getBuiltinFunctions()
  };
}

function buildObjectType(
  table: IntrospectedTable,
  module: string,
  typeName: string,
  ctx: {
    fksByFromTable: Map<string, IntrospectedForeignKey[]>;
    targetByTable: Map<
      string,
      { module: string; typeName: string; qualified: string; }
    >;
  }
): TypeDef {
  const tableFks = ctx.fksByFromTable.get(table.tableName) ?? [];
  const fkColumns = new Set(tableFks.map(fk => fk.fromColumn));

  const properties = new Map<string, PropertyDef>();
  for (const col of table.columns) {
    if (fkColumns.has(col.name)) {
      continue; // FK columns become links, not properties
    }
    properties.set(col.name, columnToProperty(col, table));
  }

  const links = new Map<string, LinkDef>();
  for (const fk of tableFks) {
    const target = ctx.targetByTable.get(fk.toTable);
    if (!target) {
      continue; // FK pointing to junction or internal table — skip
    }
    const linkName = fkColumnToLinkName(fk.fromColumn);
    const sourceCol = table.columns.find(c => c.name === fk.fromColumn);
    links.set(linkName, {
      name: linkName,
      target: target.qualified,
      required: sourceCol ? !sourceCol.nullable : true,
      multi: false,
      columnName: fk.fromColumn
    });
  }

  return {
    name: typeName,
    kind: "object",
    tableName: table.tableName,
    properties,
    links,
    module
  };
}

function columnToProperty(
  col: IntrospectedColumn,
  table: IntrospectedTable
): PropertyDef {
  const edgeqlType = pgTypeToEdgeqlType(col.pgType);

  const constraints: PropertyDef["constraints"] = [];
  // UNIQUE on a single column → constraint exclusive
  for (const uc of table.uniqueConstraints ?? []) {
    if (uc.length === 1 && uc[0] === col.name) {
      constraints.push({ name: "exclusive" });
    }
  }

  return {
    name: col.name,
    type: edgeqlType, // we don't know the SQL-mapped shape; serializer uses edgeqlType
    edgeqlType,
    required: !col.nullable,
    multi: false,
    columnName: col.name,
    hasDefault: col.hasDefault,
    constraints: constraints.length > 0 ? constraints : undefined
  };
}

function applyJunction(
  j: JunctionInfo,
  types: Map<string, TypeDef>,
  targetByTable: Map<
    string,
    { module: string; typeName: string; qualified: string; }
  >
): void {
  const left = targetByTable.get(j.leftTarget);
  const right = targetByTable.get(j.rightTarget);
  if (!left || !right) {
    return;
  }

  const leftType = types.get(left.qualified);
  const rightType = types.get(right.qualified);
  if (!leftType || !rightType) {
    return;
  }

  // Link names from the junction-table FK columns: <other_table>_id → <other_table>.
  // E.g. `users_tags(user_id, tag_id)` → User.tags + Tag.users (multi each).
  // Use the *target table* name as the plural link name, since each side
  // links to many of the other.
  const leftLinkName = j.rightTarget; // e.g. "tags"
  const rightLinkName = j.leftTarget; // e.g. "users"

  leftType.links.set(leftLinkName, {
    name: leftLinkName,
    target: right.qualified,
    required: false,
    multi: true,
    junctionTable: j.tableName,
    junctionSourceColumn: j.leftColumn,
    junctionTargetColumn: j.rightColumn
  });

  rightType.links.set(rightLinkName, {
    name: rightLinkName,
    target: left.qualified,
    required: false,
    multi: true,
    junctionTable: j.tableName,
    junctionSourceColumn: j.rightColumn,
    junctionTargetColumn: j.leftColumn
  });
}
