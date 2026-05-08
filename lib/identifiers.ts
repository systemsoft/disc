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
 * Strips the `default::` module qualifier so cross-module references like
 * `api::ApiKey -> default::Merchant` produce FK targets that match the
 * bare `merchant` table created for types in the default module. Other
 * module-qualified names (e.g. `payment::Transaction`) are preserved
 * because their tables are created with the qualifier intact.
 */
export function typeNameToTableName(typeName: string): string {
  const unqualified = typeName.replace(/^default::/, "");
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
