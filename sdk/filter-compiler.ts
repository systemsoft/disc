/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Filter compiler — turns a codegen `XFilter` object (or a combinator
 * wrapping Filter objects) into an EdgeQL filter clause + a bound
 * parameter map. The generated `client.<type>.filter()` method delegates
 * to this; the runtime `SelectChain` DSL has its own compile path in
 * `query-builder.ts`.
 *
 * The shape this compiles is the one specified by the codegen design:
 * implicit-AND across object keys, nested objects walk links, scalar
 * fields take a bare value (equality) or an operator object, and
 * combinators (`and` / `or` / `not` from `query-builder.ts`) wrap any
 * mixture of Filter objects + Expr nodes.
 */

import type { Expr, FilterArg } from "./query-builder.ts";
import { escapeEdgeQLIdent } from "./edgeql-ident.ts";

/**
 * Per-type compile-time metadata. The codegen emits a `_typeInfo` per
 * generated query builder. `casts` maps each scalar field to its EdgeQL
 * cast (e.g. `<str>`, `<float64>`); `links` maps each link name to a
 * thunk returning the linked type's `TypeInfo` — thunks let us encode
 * cyclic schemas without forward-reference acrobatics.
 */
export interface TypeInfo {
  casts: Record<string, string>;
  links: Record<string, () => TypeInfo>;
  /**
   * Computed named-tuple properties (e.g. `counts := (videos := count(...))`)
   * keyed by property name → { tupleField → EdgeQL cast }. Lets the filter
   * compiler treat `{ counts: { videos: { gte: 5 } } }` as a pseudo-link,
   * emitting `.counts.videos >= <int64>$p` (the compiler inlines the field's
   * underlying expression). Omitted for types with no filterable computeds.
   */
  computed?: Record<string, Record<string, string>>;
  /**
   * The link properties of each link that has some, keyed by link name →
   * { property → EdgeQL cast }. `reviveTyped` reads a linked object's
   * `"@name"` keys by them. Omitted for types with none.
   */
  linkProperties?: Record<string, Record<string, string>>;
  /**
   * The multi properties and multi links. A condition on a multi property or
   * through a multi link holds when some element satisfies it, and compiles
   * to `any(<comparison>)`: one boolean, false with no element, so `not`,
   * `or` and a second condition on the same path mean the same in Gel (with
   * either path scoping) as in Disc. Omitted for types with none.
   */
  multi?: string[];
}

export interface CompiledFilter {
  /** EdgeQL filter clause without the `filter` prefix. Empty if no constraints. */
  clause: string;
  /** Bound parameters keyed `p0`, `p1`, … */
  variables: Record<string, unknown>;
  /**
   * EdgeQL select shape with braces (e.g. `{ id, amount, merchant: { name } }`).
   * `null` means the caller provided no `select` — the runtime should fall
   * back to `{ * }`.
   */
  selectShape: string | null;
  /**
   * Full EdgeQL `order by …` clause, or `null` if no ordering was specified.
   * Multi-key sort joins with `then`.
   */
  orderBy: string | null;
  /** Numeric limit, or `null` if not specified. */
  limit: number | null;
  /** Numeric offset, or `null` if not specified. */
  offset: number | null;
}

const OP_MAP: Record<string, string> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
  ilike: "ilike",
  in: "in",
  // dprint-ignore
  "not_in": "not in"
};

/** Operators whose RHS must be an array unpacked into a set. */
const SET_OPS = new Set(["in", "not_in"]);

/** Reserved keys handled by Stage D (select/order_by/limit/offset). */
const RESERVED_KEYS = new Set(["select", "order_by", "limit", "offset"]);

/**
 * A condition on a single property or link compares as SQL does, an empty
 * value as NULL: `not` of it does not hold, and `or` holds when the other
 * side does. EdgeQL makes an operator over an empty value empty instead, and
 * an `or` or `and` with an empty operand empty, so each condition is compiled
 * for what it must hold for — `negate`: the condition is false, not true —
 * and, where an empty value would make an enclosing `or` empty (`total`), as
 * `(<comparison>) ?? false`. `not` flips `negate` and moves inwards: `not`
 * of an `and` is an `or` of the negated conditions, and of an `or` an `and`.
 */
interface Ctx {
  /** True when `pathPrefix` goes through a multi link. */
  multiPath: boolean;
  /** Compile for the condition being false (under an odd number of `not`s). */
  negate: boolean;
  /** Compile to a condition that is never empty: it is an operand of an `or`. */
  total: boolean;
  vars: Record<string, unknown>;
  nextN: number;
  /** EdgeQL field path prefix; "" at root, ".merchant" inside a link, etc. */
  pathPrefix: string;
}

function isExpr(x: unknown): x is Expr {
  return typeof x === "object" && x !== null && "kind" in x &&
    typeof (x as { kind: unknown; }).kind === "string" &&
    ["binop", "exists", "and", "or", "not"].includes(
      (x as { kind: string; }).kind
    );
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  if (Array.isArray(x)) {
    return false;
  }
  if (x instanceof Date || x instanceof Uint8Array) {
    return false;
  }
  // Reject combinator Exprs — they're matched by isExpr first
  return !isExpr(x);
}

/**
 * Compile a filter argument (object or combinator) for `typeName` into
 * an EdgeQL clause, bound vars, and the optional shape/order/limit/offset
 * clauses extracted from the top-level Filter object's reserved keys.
 *
 * Reserved-key extraction only happens when the root argument is a plain
 * Filter object — combinators at the root (e.g. `or(...)`) carry no
 * select/order_by/limit/offset because they don't have a single
 * top-level shape. Reserved keys nested inside link sub-objects are
 * silently dropped.
 */
export function compileFilter<T extends object>(
  typeName: string,
  filter: FilterArg<T>,
  typeInfo: TypeInfo
): CompiledFilter {
  void typeName; // reserved for future error-context messages
  const ctx: Ctx = { multiPath: false, negate: false, nextN: 0, pathPrefix: "", total: false, vars: {} };

  let selectShape: string | null = null;
  let orderBy: string | null = null;
  let limit: number | null = null;
  let offset: number | null = null;

  // Reserved-key extraction (top-level object root only)
  if (!isExpr(filter) && isPlainObject(filter)) {
    const root = filter as Record<string, unknown>;
    if (root.select !== undefined) {
      // Compiled before the where clause below so that any parameters bound by
      // a link sub-shape `filter` are inserted into `ctx.vars` ahead of the
      // where clause's — the server binds `Object.values(variables)`
      // positionally, and the compiler numbers parameters in the order it
      // meets them, which is shape-then-where.
      selectShape = compileSelectShape(
        root.select as Record<string, unknown>,
        typeInfo,
        ctx
      );
    }
    if (root.order_by !== undefined) {
      orderBy = compileOrderBy(root.order_by as string | string[]);
    }
    if (root.limit !== undefined) {
      limit = validateNonNegativeInt(root.limit, "limit");
    }
    if (root.offset !== undefined) {
      offset = validateNonNegativeInt(root.offset, "offset");
    }
  }

  const clause = compileArg(filter as FilterArg, typeInfo, ctx);
  return { clause, variables: ctx.vars, selectShape, orderBy, limit, offset };
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function compileSelectShape(
  select: Record<string, unknown>,
  info: TypeInfo,
  ctx: Ctx
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(select)) {
    // `filter`, `order_by`, `offset` and `limit` inside a link's select object
    // are consumed by the parent link (they narrow, order and cap that link's
    // set, emitted as `link: { ... } filter ... order by ... offset ... limit
    // ...`), so they're not fields of this shape. At the top level they have no
    // parent link and are simply ignored — top-level narrowing, ordering and
    // paging use the sibling filter keys/`order_by`/`offset`/`limit`.
    if (key === "filter" || key === "order_by" || key === "offset" || key === "limit") {
      continue;
    }
    if (key === "*") {
      // Splat: pull every scalar field of this type. Pairs with explicit
      // link keys (e.g. `{ "*": true, posts: true }` → `{ *, posts: { * } }`),
      // letting callers get all scalars plus shaped links — something the
      // default `{ * }` shape can't express once a `select` is supplied.
      if (value === false || value === undefined || value === null) {
        continue;
      }
      if (value !== true) {
        throw new Error(
          `Invalid select value for "*": ${JSON.stringify(value)}`
        );
      }
      parts.push("*");
      continue;
    }
    if (!IDENT_RE.test(key)) {
      throw new Error(`Invalid select key: ${JSON.stringify(key)}`);
    }
    if (value === false || value === undefined || value === null) {
      continue;
    }
    if (value === true) {
      // Link → expand to {*}; scalar → bare field name. Same EdgeQL either way:
      // selecting a link without a sub-shape yields just its id, which is
      // rarely what callers want, so we expand to {*} for links.
      if (info.links[key]) {
        parts.push(`${escapeEdgeQLIdent(key)}: { * }`);
      } else {
        parts.push(escapeEdgeQLIdent(key));
      }
      continue;
    }
    if (typeof value === "object") {
      const linkThunk = info.links[key];
      if (!linkThunk) {
        throw new Error(`select: unknown link ${JSON.stringify(key)}`);
      }
      const linkSelect = value as Record<string, unknown>;
      const targetInfo = linkThunk();
      // A sub-object carrying only modifiers (`{ filter: … }`) names no fields,
      // and an empty `{ }` shape is not valid EdgeQL — fall back to the same
      // `{ * }` a bare `link: true` would produce.
      const shaped = compileSelectShape(linkSelect, targetInfo, ctx);
      const inner = shaped === "{  }" ? "{ * }" : shaped;

      // Trailing modifiers on the linked set, emitted in EdgeQL clause order:
      // `link: { ... } filter … order by .field [desc] offset n limit n`.
      const modifiers: string[] = [];

      // Narrow the linked set: the predicate reads against the *target* type,
      // so it compiles with an empty path prefix (`.isDraft`, not
      // `.videos.isDraft`) — unlike a sibling link key in the filter object,
      // which constrains the parent via EXISTS.
      if (linkSelect.filter !== undefined) {
        const savedPrefix = ctx.pathPrefix;
        const savedMulti = ctx.multiPath;
        ctx.pathPrefix = "";
        ctx.multiPath = false;
        const predicate = compileArg(
          linkSelect.filter as FilterArg,
          targetInfo,
          ctx
        );
        ctx.pathPrefix = savedPrefix;
        ctx.multiPath = savedMulti;
        if (predicate.length > 0) {
          modifiers.push(`filter ${predicate}`);
        }
      }

      if (linkSelect.order_by !== undefined) {
        modifiers.push(compileOrderBy(linkSelect.order_by as string | string[]));
      }
      if (linkSelect.offset !== undefined) {
        modifiers.push(`offset ${validateNonNegativeInt(linkSelect.offset, "offset")}`);
      }
      if (linkSelect.limit !== undefined) {
        modifiers.push(`limit ${validateNonNegativeInt(linkSelect.limit, "limit")}`);
      }

      const suffix = modifiers.length > 0 ? ` ${modifiers.join(" ")}` : "";
      parts.push(`${escapeEdgeQLIdent(key)}: ${inner}${suffix}`);
      continue;
    }
    throw new Error(
      `Invalid select value for ${JSON.stringify(key)}: ${JSON.stringify(value)}`
    );
  }
  return `{ ${parts.join(", ")} }`;
}

// Zero-arg functions allowed in order_by, e.g. "random()". Name-allowlisted
// to keep the raw EdgeQL emission injection-safe; the registry of what
// actually compiles lives in compiler/builtin-functions.ts.
const ORDER_BY_FUNCS = new Set(["random"]);
const ORDER_FN_RE = /^([a-z_][a-z0-9_]*)\(\)$/;

function compileOrderBy(orderBy: string | string[]): string {
  const fields = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts = fields.map(field => {
    const fnMatch = ORDER_FN_RE.exec(field);
    if (fnMatch) {
      const fn = fnMatch[1];
      if (!ORDER_BY_FUNCS.has(fn)) {
        throw new Error(`Invalid order_by function: ${JSON.stringify(field)}`);
      }
      return `${fn}()`;
    }
    const isDesc = field.startsWith("-");
    const name = isDesc ? field.slice(1) : field;
    if (!IDENT_RE.test(name)) {
      throw new Error(`Invalid order_by field: ${JSON.stringify(field)}`);
    }
    return `.${escapeEdgeQLIdent(name)}${isDesc ? " desc" : ""}`;
  });
  return `order by ${parts.join(" then ")}`;
}

function validateNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function compileArg(arg: FilterArg, info: TypeInfo, ctx: Ctx): string {
  if (isExpr(arg)) {
    return compileExpr(arg, info, ctx);
  }
  if (!isPlainObject(arg)) {
    throw new Error(
      `Filter compiler received a non-object argument: ${typeof arg}`
    );
  }
  return compileObject(arg, info, ctx);
}

function compileExpr(expr: Expr, info: TypeInfo, ctx: Ctx): string {
  switch (expr.kind) {
    case "and":
    case "or": {
      const join = junction(expr.kind, ctx);
      const parts = withTotal(ctx, (join === "or" && expr.exprs.length > 1) || ctx.total, () => expr.exprs.map(c => `(${compileArg(c, info, ctx)})`));
      return parts.join(` ${join} `);
    }
    case "not": {
      ctx.negate = !ctx.negate;
      try {
        return compileArg(expr.expr, info, ctx);
      } finally {
        ctx.negate = !ctx.negate;
      }
    }
    case "binop":
    case "exists":
      throw new Error(
        `Filter compiler received a runtime-DSL ${expr.kind} Expr — ` +
          `those are for the SelectChain DSL only. Use Filter objects instead.`
      );
  }
}

/*** The operator joining an `and` or `or`'s conditions: negated, `and` is `or` and `or` is `and`. ***/
function junction(kind: "and" | "or", ctx: Ctx): "and" | "or" {
  return ctx.negate ? (kind === "and" ? "or" : "and") : kind;
}

/*** `compile()` with `ctx.total` set to `total`. ***/
function withTotal<T>(ctx: Ctx, total: boolean, compile: () => T): T {
  const saved = ctx.total;
  ctx.total = total;
  try {
    return compile();
  } finally {
    ctx.total = saved;
  }
}

function compileObject(
  obj: Record<string, unknown>,
  info: TypeInfo,
  ctx: Ctx
): string {
  // The object's conditions are an `and`: one per key, and one per operator of an operator object.
  const count = Object
    .entries(obj)
    .filter(([key, value]) => !RESERVED_KEYS.has(key) && value !== undefined)
    .reduce((sum, [key, value]) => sum + (!info.links[key] && !info.computed?.[key] && isOperatorObject(value) ? Object.keys(value).length : 1), 0);
  const join = junction("and", ctx);
  return withTotal(ctx, (join === "or" && count > 1) || ctx.total, () => compileObjectClauses(obj, info, ctx).join(` ${join} `));
}

function compileObjectClauses(
  obj: Record<string, unknown>,
  info: TypeInfo,
  ctx: Ctx
): string[] {
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }

    // `undefined` means "no constraint on this field" — skip it entirely.
    // Emitting a placeholder for an undefined value produces SQL with a
    // bound `$param` that has no value, which breaks parameter binding
    // ("supplies N parameters, but ... requires N+1"). This lets callers
    // pass optional predicates (e.g. id OR slug). `null` is left intact as
    // a real value (compiles to `= <cast>$p` with a null binding).
    if (value === undefined) {
      continue;
    }

    // Link — recurse with extended path prefix.
    const linkThunk = info.links[key];
    if (linkThunk) {
      const targetInfo = linkThunk();
      const savedPrefix = ctx.pathPrefix;
      const savedMulti = ctx.multiPath;
      ctx.pathPrefix = `${savedPrefix}.${escapeEdgeQLIdent(key)}`;
      ctx.multiPath = savedMulti || (info.multi?.includes(key) ?? false);
      const inner = compileArg(value as FilterArg, targetInfo, ctx);
      ctx.pathPrefix = savedPrefix;
      ctx.multiPath = savedMulti;
      if (inner.length > 0) {
        clauses.push(`(${inner})`);
      }
      continue;
    }

    // Computed named-tuple property — recurse as a pseudo-link, treating each
    // tuple field as a scalar with the field's cast. `{ counts: { videos:
    // { gte: 5 } } }` → `.counts.videos >= <int64>$p`; the compiler inlines
    // the field's underlying expression.
    const computedFields = info.computed?.[key];
    if (computedFields) {
      const fieldInfo: TypeInfo = { casts: computedFields, links: {} };
      const savedPrefix = ctx.pathPrefix;
      ctx.pathPrefix = `${savedPrefix}.${escapeEdgeQLIdent(key)}`;
      const inner = compileArg(value as FilterArg, fieldInfo, ctx);
      ctx.pathPrefix = savedPrefix;
      if (inner.length > 0) {
        clauses.push(`(${inner})`);
      }
      continue;
    }

    // Scalar — operator object or bare value.
    const cast = info.casts[key] ?? "<str>";
    const path = `${ctx.pathPrefix}.${escapeEdgeQLIdent(key)}`;
    // Over a multi property or a multi link: whether some element matches,
    // one boolean (see `TypeInfo.multi`), never empty. Over a single one, the
    // comparison, empty for an empty value (see `Ctx`).
    const multi = ctx.multiPath || (info.multi?.includes(key) ?? false);
    const condition = (comparison: string): string => {
      if (multi) {
        return ctx.negate ? `not (any(${comparison}))` : `any(${comparison})`;
      }
      const holds = ctx.negate ? `not (${comparison})` : comparison;
      return ctx.total ? `(${holds}) ?? false` : holds;
    };

    if (isOperatorObject(value)) {
      for (const [op, opValue] of Object.entries(value)) {
        const sqlOp = OP_MAP[op];
        if (!sqlOp) {
          throw new Error(
            `Unknown operator "${op}" on field "${key}" — ` +
              `expected one of ${Object.keys(OP_MAP).join(", ")}`
          );
        }
        const param = `p${ctx.nextN++}`;
        ctx.vars[param] = opValue;
        if (SET_OPS.has(op)) {
          // EdgeQL `in` operates on sets; array_unpack widens an array
          // parameter into a set so callers can pass plain JS arrays.
          // The cast becomes `<array<inner>>` — strip the inner cast's
          // angle brackets to splice it inside `<array<...>>`.
          const inner = cast.slice(1, -1); // "<str>" -> "str"
          clauses.push(
            condition(`${path} ${sqlOp} array_unpack(<array<${inner}>>$${param})`)
          );
        } else {
          clauses.push(condition(`${path} ${sqlOp} ${cast}$${param}`));
        }
      }
      continue;
    }

    // Bare value — equality
    const param = `p${ctx.nextN++}`;
    ctx.vars[param] = value;
    clauses.push(condition(`${path} = ${cast}$${param}`));
  }

  return clauses;
}

/**
 * An object is treated as an operator object iff at least one of its
 * keys matches a known operator. JSON-typed scalar values that happen
 * to contain op-shaped keys could collide here; the codegen emits a
 * `<json>` cast for those, and callers should pass them via `{ eq: ... }`
 * to disambiguate.
 */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  for (const k of Object.keys(value)) {
    if (k in OP_MAP) {
      return true;
    }
  }
  return false;
}
