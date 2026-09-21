/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Shared SQL identifier conversion helpers.
 *
 * PostgreSQL lowercases all unquoted identifiers, so any camelCase or
 * PascalCase name written into DDL as a quoted identifier breaks
 * unquoted lookups elsewhere. CLAUDE.md requires snake_case for every
 * SQL identifier (column, table, config directive). These two helpers
 * are the canonical conversion path; both DDL emission and EdgeQL→SQL
 * compilation must agree on the same mapping or queries miss columns.
 *
 * Both helpers are idempotent — passing already-snake-case input
 * returns it unchanged.
 */

/**
 * Convert a PascalCase type name to a snake_case table name.
 *
 * Handles consecutive capitals correctly (the abbreviation rule):
 *   User → user
 *   BlogPost → blog_post
 *   HTTPRequest → http_request
 *
 * Strips any `module::` qualifier (`default::`, `api::`, `payment::`, …).
 * `CreateType` operations emit tables with bare names (the differ uses
 * `item.name.value` only), so FK targets coming from `link.target`
 * (which carries the full qualified name) must collapse the same way or
 * the constraint references a relation that doesn't exist.
 */
export function typeNameToTableName(typeName: string): string {
  const unqualified = typeName.includes("::") ?
    typeName.slice(typeName.lastIndexOf("::") + 2) :
    typeName;
  return unqualified
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Convert an SDL property identifier (camelCase) to a SQL column name
 * (snake_case). Same regex pair as typeNameToTableName so type and
 * property names follow identical conversion rules.
 */
export function propNameToColumnName(propName: string): string {
  return propName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Column that stores a single link: `<snake_case link name>_id`, a uuid FK.
 *
 * Every place that turns a link into a column name must go through this one
 * function — table DDL, index columns (`migration/differ.ts`) and
 * `ON CONFLICT (…)` targets in the compiler. If a unique index and the
 * conflict target that relies on it ever spell the column differently,
 * Postgres rejects the insert with "no unique or exclusion constraint
 * matching the ON CONFLICT specification".
 */
export function linkColumnName(linkName: string): string {
  return `${propNameToColumnName(linkName)}_id`;
}

/** PostgreSQL truncates identifiers to `NAMEDATALEN - 1` bytes, silently. */
export const PG_MAX_IDENTIFIER_BYTES = 63;

/**
 * Make a generated identifier fit PostgreSQL's 63-byte limit.
 *
 * A name that fits is returned unchanged, so existing indexes are never
 * renamed. A longer name is cut and suffixed with `_<8 hex>` of a hash of the
 * full name: left to Postgres, two long names sharing their first 63 bytes
 * would collide. The hash (FNV-1a, 32-bit) is part of stored index names —
 * never change it.
 */
export function fitIdentifier(name: string): string {
  const encoder = new TextEncoder();

  if (encoder.encode(name).length <= PG_MAX_IDENTIFIER_BYTES)
    return name;

  let hash = 0x811c9dc5;

  for (const byte of encoder.encode(name))
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;

  const suffix = `_${hash.toString(16).padStart(8, "0")}`;
  let head = name;

  while (encoder.encode(head).length > PG_MAX_IDENTIFIER_BYTES - suffix.length)
    head = head.slice(0, -1);

  return `${head}${suffix}`;
}

/**
 * PostgreSQL 16 reserved keywords that cannot appear unquoted as identifiers.
 * Source: https://www.postgresql.org/docs/16/sql-keywords-appendix.html
 * (columns marked "reserved" and "reserved (can be function or type)"). We use
 * the superset because both categories fail in table/column positions.
 *
 * Shared by DDL emission (`migration/ddl.ts`) and EdgeQL→SQL codegen
 * (`compiler/codegen.ts`): a table created as `"user"` is only reachable if
 * queries quote it the same way, so both sides must agree on one list.
 */
export const RESERVED_PG_KEYWORDS: ReadonlySet<string> = new Set<string>([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "authorization",
  "binary",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "collation",
  "column",
  "concurrently",
  "constraint",
  "create",
  "cross",
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "freeze",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "ilike",
  "in",
  "initially",
  "inner",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "lateral",
  "leading",
  "left",
  "like",
  "limit",
  "localtime",
  "localtimestamp",
  "natural",
  "not",
  "notnull",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "overlaps",
  "placing",
  "primary",
  "references",
  "returning",
  "right",
  "select",
  "session_user",
  "similar",
  "some",
  "symmetric",
  "system_user",
  "table",
  "tablesample",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "verbose",
  "when",
  "where",
  "window",
  "with",
  // Common non-standard additions that still conflict unquoted:
  "add",
  "alter",
  "cascade",
  "drop",
  "index",
  "key",
  "restrict",
  "update",
  "delete",
  "insert"
]);

/** True when `name` must be double-quoted to survive as a SQL identifier. */
export function isReservedPgKeyword(name: string): boolean {
  return RESERVED_PG_KEYWORDS.has(name.toLowerCase());
}
