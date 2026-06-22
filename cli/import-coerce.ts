/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Value coercion for `disc db import`.
 *
 * Converts a single CSV cell string into a JavaScript value suitable to pass
 * as a parameter to the PostgreSQL driver, driven by the source column's
 * EdgeQL type.
 *
 * The subtle part is that Gel exports tuple / array-of-tuple columns in
 * PostgreSQL composite/array *text* format (e.g. `client` =
 * `("Nickel Web Client",https://nickel.video)`), but Disc stores tuples as
 * JSONB (see `migration/ddl.ts` `mapEdgeQLTypeToPostgreSQL`). So those columns
 * are parsed out of their PG text form and re-emitted as JSON objects keyed by
 * the tuple's field names.
 *
 * All functions here are pure (no DB, no I/O) and unit-testable.
 *
 * Return-value contract for {@link coerceCell}:
 *   - `str` / enum / `uuid` / `datetime` -> string (or `null`)
 *   - integer / float / decimal          -> number (or `null`)
 *   - `array<scalar>`                    -> JS array of strings/`null`
 *                                           (the pg driver encodes it)
 *   - `tuple<...>` / `array<tuple<...>>` -> a JSON *string* (the value is
 *                                           bound to a `jsonb` param, which
 *                                           the driver passes verbatim, so we
 *                                           `JSON.stringify` here)
 */

/*** UTILITY ------------------------------------------ ***/

const FLOAT_TYPES = new Set(["float32", "float64", "decimal"]);
const INTEGER_TYPES = new Set(["int16", "int32", "int64"]);

/*** EXPORT ------------------------------------------- ***/

/**
 * Type metadata for one column, derived from the schema, used to drive cell
 * coercion. `type` is the bare EdgeQL type string (e.g. `str`, `int64`,
 * `array<str>`, `tuple<name: str, url: str>`).
 */
export interface EdgeQLTypeInfo {
  /** Whether the column has a schema default. */
  hasDefault: boolean;
  /** True if `type` names a user-declared enum scalar. */
  isEnum?: boolean;
  /** Whether the column is NOT NULL. */
  required: boolean;
  /**
   * For tuple / array-of-tuple types: the ordered list of field names. Required
   * for those types; ignored otherwise.
   */
  tupleFields?: string[];
  /** Bare EdgeQL type string. */
  type: string;
}

/**
 * Coerce one CSV cell to a pg driver parameter value, driven by its EdgeQL
 * type. See the module doc comment for the return-value contract.
 */
export function coerceCell(raw: string, type: EdgeQLTypeInfo): unknown {
  const t = type.type;

  /*** Empty cell handling. An empty string is `null` for every type EXCEPT a required `str` column
       with no default, where it is the empty string. ***/
  if (raw === "") {
    if (t === "str" && type.required && !type.hasDefault)
      return "";

    return null;
  }

  /*** array<tuple<...>> (JSONB): parse array of composite literals, then each composite into a
       named object. Checked before plain `array<` and `tuple<`. ***/
  if (t.startsWith("array<tuple<")) {
    const fields = type.tupleFields ?? [];
    const elements = parsePgArray(raw);

    const objects = elements.map(el => {
      if (el === null)
        return null;

      return tupleToObject(parsePgComposite(el), fields);
    });

    return JSON.stringify(objects);
  }

  /*** tuple<...> (JSONB): parse composite, zip with field names, return JSON. ***/
  if (t.startsWith("tuple<")) {
    const fields = type.tupleFields ?? [];
    const obj = tupleToObject(parsePgComposite(raw), fields);

    return JSON.stringify(obj);
  }

  /*** array<scalar> (native PG array): return a JS array; the driver encodes it. ***/
  if (t.startsWith("array<"))
    return parsePgArray(raw);

  /*** Numeric scalars. ***/
  if (INTEGER_TYPES.has(t) || FLOAT_TYPES.has(t))
    return Number(raw);

  /*** str / enum / uuid / datetime / everything else => string passthrough. ***/
  return raw;
}

/**
 * Parse a PostgreSQL array text literal `{elem1,"elem2",...}` into a JS array.
 * Unquoted `NULL` (case-insensitive) is the `null` element; a quoted `"NULL"`
 * is the literal string. Quoting rules match composites (doubled `"` and `\`).
 *
 * Implemented as a character-by-character state machine, not a regex.
 */
export function parsePgArray(input: string): (string | null)[] {
  if (input.length < 2 || input[0] !== "{" || input[input.length - 1] !== "}")
    throw new Error(`invalid PostgreSQL array literal: ${input}`);

  const body = input.slice(1, -1);

  if (body.length === 0)
    return [];

  return parseElements(body, input, true);
}

/**
 * Parse a PostgreSQL composite/record text literal `(elem1,elem2,...)` into an
 * ordered list of element strings. An empty unquoted element is `null` (PG
 * renders NULL composite fields as nothing); a quoted empty element (`""`) is
 * the empty string. Double-quoted elements may contain commas, parens, and
 * doubled quotes (`""`) / doubled backslashes for literal `"` / `\`.
 *
 * Implemented as a character-by-character state machine, not a regex.
 */
export function parsePgComposite(input: string): (string | null)[] {
  if (input.length < 2 || input[0] !== "(" || input[input.length - 1] !== ")")
    throw new Error(`invalid PostgreSQL composite literal: ${input}`);

  /*** Strip the surrounding parens; parse the comma-separated body. ***/
  return parseElements(input.slice(1, -1), input);
}

/*** HELPER ------------------------------------------- ***/

/**
 * Shared element scanner for composite and array bodies (the part between the
 * delimiters). Splits on top-level commas, honoring double-quoted segments with
 * doubled-quote / doubled-backslash escaping. Tracks whether each element was
 * quoted so the caller can distinguish empty/unquoted (NULL) from `""` (empty
 * string) and unquoted `NULL` from quoted `"NULL"`.
 *
 * @param treatUnquotedNullAsNull when true (array context), an unquoted,
 *   case-insensitive `NULL` element yields `null`.
 */
function parseElements(body: string, original: string, treatUnquotedNullAsNull = false): (string | null)[] {
  const result: (string | null)[] = [];
  let current = "";
  let i = 0;
  let inQuotes = false;
  let quoted = false; /*** this element contained a quoted segment ***/

  const pushElement = (): void => {
    if (!quoted && current.length === 0)
      result.push(null); /*** Empty unquoted element => NULL. ***/
    else if (!quoted && treatUnquotedNullAsNull && current.toUpperCase() === "NULL")
      result.push(null);
    else
      result.push(current);

    current = "";
    quoted = false;
  };

  while (i < body.length) {
    const ch = body[i];

    if (inQuotes) {
      if (ch === "\"") {
        if (body[i + 1] === "\"") {
          /*** Doubled quote => literal quote. ***/
          current += "\"";
          i += 2;

          continue;
        }

        /*** Closing quote. ***/
        inQuotes = false;
        i += 1;

        continue;
      }

      if (ch === "\\") {
        /*** Backslash escapes the next character literally (PG doubles `\`). ***/
        const next = body[i + 1];

        if (next === undefined)
          throw new Error(`unterminated escape in literal: ${original}`);

        current += next;
        i += 2;

        continue;
      }

      current += ch;
      i += 1;

      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      quoted = true;
      i += 1;

      continue;
    }

    if (ch === ",") {
      pushElement();
      i += 1;

      continue;
    }

    current += ch;
    i += 1;
  }

  if (inQuotes)
    throw new Error(`unterminated quote in literal: ${original}`);

  pushElement();
  return result;
}

function tupleToObject(elements: (string | null)[], fields: string[]): Record<string, string | null> {
  const obj: Record<string, string | null> = {};

  for (let i = 0; i < fields.length; i++) {
    obj[fields[i]] = elements[i] ?? null;
  }

  return obj;
}
