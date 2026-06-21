/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL identifier quoting for generated queries.
 *
 * A field/link whose name is an EdgeQL reserved keyword (e.g. a link named
 * `for`) must be backtick-quoted when emitted into a query — otherwise the
 * parser reads `for` as the FOR keyword and fails with "Expected identifier".
 *
 * This set mirrors `RESERVED_KEYWORDS` in `edgeql/tokens.ts`; the
 * `edgeql-ident.test.ts` sibling asserts the two stay in sync.
 */
export const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
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
 * Backtick-quote `name` when it collides with an EdgeQL reserved keyword;
 * otherwise return it unchanged. Use everywhere a schema field/link name is
 * interpolated into generated EdgeQL (shapes, filter/order paths, mutations).
 */
export function quoteIdent(name: string): string {
  return RESERVED_KEYWORDS.has(name.toLowerCase()) ? `\`${name}\`` : name;
}
