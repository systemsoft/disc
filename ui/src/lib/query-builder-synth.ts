/**
 * EdgeQL synthesizer for the visual query builder (#3b).
 *
 * Pure function: takes a `QuerySpec` (the visual choices made in the
 * UI) and returns a `{ query, variables }` pair ready to ship through
 * the existing `/query` endpoint. No DOM, no Svelte — keeps the
 * synthesizer testable from Deno without the broken Vitest config in
 * `ui/`. The page wires its form state into a `QuerySpec` and renders
 * the synthesized EdgeQL live as the user clicks.
 *
 * Scope: single-type root, scalar filters only, one-level link
 * expansion in the result shape (the EdgeQL pipeline supports
 * arbitrary nesting; the form just doesn't surface deeper levels).
 * Cross-link filters (`.author.email = ...`) are out of scope for v1.
 */

export type FilterOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** Subset of EdgeQL casts the form can produce — keep aligned with form inputs. */
export type FilterCast =
  | "str"
  | "uuid"
  | "datetime"
  | "bool"
  | "int16"
  | "int32"
  | "int64"
  | "float32"
  | "float64";

export interface FilterSpec {
  field: string;
  op: FilterOp;
  /** Raw text from the form input — coerced by `cast` at synth time. */
  value: string;
  cast: FilterCast;
}

export interface OrderSpec {
  field: string;
  direction: "asc" | "desc";
}

/** Shape node — leaves track scalar field names; `links` carries one-level expansions. */
export interface ShapeNode {
  fields: string[];
  links: Record<string, { fields: string[] }>;
}

export interface QuerySpec {
  type: string;
  shape: ShapeNode;
  filters: FilterSpec[];
  order?: OrderSpec;
  limit?: number;
  offset?: number;
}

export interface SynthResult {
  query: string;
  variables: Record<string, unknown>;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name: string, ctx: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid ${ctx}: ${JSON.stringify(name)}`);
  }
}

/**
 * Coerce a form input string into the JS value the EdgeQL parameter
 * expects. Throws with a per-field message so the UI can pinpoint the
 * row that needs fixing.
 */
export function coerceValue(
  value: string,
  cast: FilterCast,
  fieldLabel: string,
): unknown {
  switch (cast) {
    case "str":
    case "uuid":
    case "datetime":
      return value;
    case "bool": {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      throw new Error(
        `${fieldLabel}: expected boolean (true/false), got ${JSON.stringify(value)}`,
      );
    }
    case "int16":
    case "int32":
    case "int64": {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || String(n) !== value.trim()) {
        throw new Error(
          `${fieldLabel}: expected ${cast}, got ${JSON.stringify(value)}`,
        );
      }
      return n;
    }
    case "float32":
    case "float64": {
      const n = Number.parseFloat(value);
      if (!Number.isFinite(n)) {
        throw new Error(
          `${fieldLabel}: expected ${cast}, got ${JSON.stringify(value)}`,
        );
      }
      return n;
    }
  }
}

function compileShape(shape: ShapeNode): string {
  const parts: string[] = [];
  for (const f of shape.fields) {
    assertIdent(f, "shape field");
    parts.push(f);
  }
  for (const [linkName, linkShape] of Object.entries(shape.links)) {
    assertIdent(linkName, "link name");
    const inner = linkShape.fields.map((f) => {
      assertIdent(f, "link field");
      return f;
    });
    parts.push(`${linkName}: { ${inner.join(", ")} }`);
  }
  return parts.length === 0 ? "" : `{ ${parts.join(", ")} }`;
}

/**
 * Build the `{ query, variables }` pair for a visual builder spec.
 *
 * Output order is fixed: `select Type { ... } filter ... order by ...
 * limit ... offset ...`. Multiple filters AND together with parens.
 * Filter values are parameterized as `$p0`, `$p1`, … so the UI can
 * pass them straight through to `/query`.
 */
export function synthesize(spec: QuerySpec): SynthResult {
  assertIdent(spec.type, "type name");

  const variables: Record<string, unknown> = {};
  const parts: string[] = [`select ${spec.type}`];

  const shapeStr = compileShape(spec.shape);
  if (shapeStr) parts.push(shapeStr);

  if (spec.filters.length > 0) {
    const compiled = spec.filters.map((f, i) => {
      assertIdent(f.field, "filter field");
      const param = `p${i}`;
      variables[param] = coerceValue(f.value, f.cast, f.field);
      return `.${f.field} ${f.op} <${f.cast}>$${param}`;
    });
    if (compiled.length === 1) {
      parts.push(`filter ${compiled[0]}`);
    } else {
      parts.push(`filter ${compiled.map((c) => `(${c})`).join(" and ")}`);
    }
  }

  if (spec.order) {
    assertIdent(spec.order.field, "order field");
    const dir = spec.order.direction === "desc" ? " desc" : "";
    parts.push(`order by .${spec.order.field}${dir}`);
  }

  if (spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || spec.limit < 0) {
      throw new Error("limit must be a non-negative integer");
    }
    parts.push(`limit ${spec.limit}`);
  }
  if (spec.offset !== undefined) {
    if (!Number.isInteger(spec.offset) || spec.offset < 0) {
      throw new Error("offset must be a non-negative integer");
    }
    parts.push(`offset ${spec.offset}`);
  }

  return { query: parts.join(" "), variables };
}
