/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL identifier escaping for the client SDK and generated query
 * builders. When a schema field shares a name with a reserved EdgeQL
 * keyword (e.g. `for`, `filter`, `order`), emitting it bare as an
 * identifier makes the parser read it as that keyword — `insert T { for
 * := ... }` parses `for` as a FOR-loop and fails on `:=`. Wrapping the
 * name in backticks turns it back into a plain identifier.
 *
 * Source of truth for the keyword list is `edgeql/tokens.ts`
 * (`RESERVED_KEYWORDS`); it is duplicated here so the materialized SDK
 * stays self-contained when extracted into a generated project. Keep the
 * two in sync.
 */

/** Reserved EdgeQL keywords that cannot be used as bare identifiers. */
const RESERVED_EDGEQL_KEYWORDS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "for",
  "with",
  "filter",
  "order",
  "by",
  "and",
  "or",
  "not",
  "if",
  "else",
  "true",
  "false",
  "is",
  "in",
  "union",
  "except",
  "intersect"
]);

/**
 * Backtick-quote `name` if it collides with a reserved EdgeQL keyword;
 * otherwise return it unchanged. The keyword check is case-insensitive
 * because the EdgeQL lexer lowercases keywords before matching.
 */
export function escapeEdgeQLIdent(name: string): string {
  return RESERVED_EDGEQL_KEYWORDS.has(name.toLowerCase()) ? `\`${name}\`` : name;
}
