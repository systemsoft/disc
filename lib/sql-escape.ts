/**
 * SQL string escaping helpers.
 *
 * PostgreSQL recognizes two string-literal syntaxes:
 *   - Ordinary literals:  'foo'        (backslashes are literal only when
 *                                       `standard_conforming_strings = on`,
 *                                       which is the default since PG 9.1)
 *   - Escape literals:    E'foo\\bar'  (backslashes are always interpreted as
 *                                       escape sequences, regardless of the
 *                                       `standard_conforming_strings` setting)
 *
 * To make string interpolation safe under BOTH settings — which matters for
 * access-policy expressions where user-derived context values (userId, role,
 * session globals) end up in SQL at compile time — we use the E'…' syntax
 * and escape both single-quotes and backslashes.
 *
 * This is defense-in-depth; the correct long-term fix is to parameterize
 * policy-derived values instead of interpolating them. Until then, this
 * helper closes the most common injection vectors (P0-01 / P0-02).
 */

/**
 * Escape a string for safe inclusion inside a PostgreSQL string literal,
 * returning a fully-quoted `E'...'` expression.
 *
 * Examples:
 *   sqlStringLiteral("alice")              -> "E'alice'"
 *   sqlStringLiteral("O'Brien")            -> "E'O''Brien'"
 *   sqlStringLiteral("'; DROP TABLE --")   -> "E'''; DROP TABLE --'"
 *   sqlStringLiteral("a\\b")               -> "E'a\\\\b'"
 *
 * The E-prefix is safe to use anywhere a regular string literal is valid.
 */
export function sqlStringLiteral(value: string): string {
  const escaped = String(value)
    .replace(/\\/g, "\\\\") // backslash → \\ (P0-02: safe even with standard_conforming_strings off)
    .replace(/'/g, "''"); // single quote → '' (SQL-standard doubling)
  return `E'${escaped}'`;
}

/**
 * Validate that an identifier consists only of ASCII letters, digits, and
 * underscores — the SDL parser already enforces this for user-defined names,
 * but SQL generators that interpolate identifier strings should double-check
 * rather than trust callers.
 *
 * Throws if the identifier would be unsafe to embed unquoted in SQL.
 */
export function assertSafeIdentifier(identifier: string, context: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `Unsafe identifier in ${context}: ${JSON.stringify(identifier)}`,
    );
  }
}
