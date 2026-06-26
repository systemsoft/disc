/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Codegen-free EdgeQL query builder (Disc-original feature #1, Phase 1).
 *
 * A runtime DSL that produces `{ query, variables }` pairs from a
 * chainable builder. Types are intentionally permissive at this stage
 * (Phase 1 = runtime); Phase 2 will add a `defineSchema()` companion
 * that supplies inference without codegen.
 *
 * The builder never speaks to the network. `toEdgeQL()` returns a
 * compiled fragment that the existing `client.query()` pipeline runs.
 * That keeps access policies, read-only mode, the auth gate, and
 * server-side validators on the same execution path as raw EdgeQL.
 */

import type {
  DiscSchema,
  FieldType,
  ResolveSelected,
  ResolveType,
  SchemaSpec,
  SelectShape
} from "./schema-types.ts";
import type { QueryOptions } from "./types.ts";
import { escapeEdgeQLIdent } from "./edgeql-ident.ts";

/** Minimum surface a client must expose to be awaitable from the builder. */
export interface QueryRunner {
  query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    options?: QueryOptions<T>
  ): Promise<T>;
}

/** Recursive shape spec: `true` to include, nested object to expand a link. */
export interface Shape {
  [key: string]: true | Shape;
}

/** A boolean expression node — the result of comparisons / `exists`. */
export type Expr =
  | { kind: "binop"; op: string; field: string; value: unknown; }
  | { kind: "exists"; field: string; }
  | { kind: "and"; exprs: FilterArg[]; }
  | { kind: "or"; exprs: FilterArg[]; }
  | { kind: "not"; expr: FilterArg; };

/**
 * Anything `and`/`or`/`not` can wrap: a runtime-DSL `Expr`, another
 * combinator, or a codegen Filter object (a plain `Record<string, unknown>`
 * keyed by schema field names). The runtime-DSL `compileExpr` only knows
 * how to compile `Expr` children — feeding it a Filter object throws. The
 * codegen filter compiler understands both.
 *
 * Generic `T` lets the codegen layer narrow the object branch to a typed
 * `XFilter` shape (e.g. `FilterArg<MerchantFilter>`) while combinators
 * stay permissive enough to accept either form.
 */
export type FilterArg<T = Record<string, unknown>> = Expr | T;

/** Order specification — produced by `field.desc()` or by passing a bare FieldRef. */
interface OrderSpec {
  kind: "order";
  field: string;
  direction: "asc" | "desc";
}

/** Anything orderBy() can accept from a predicate. */
type OrderTarget = FieldRef | OrderSpec;

/** Shape of a TypeRef proxy — any property access yields a FieldRef. */
type TypeRef = Record<string, FieldRef>;

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name: string, ctx: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid ${ctx}: ${JSON.stringify(name)}`);
  }
}

/**
 * One field on a TypeRef. Holds the SDL property name verbatim — the
 * server's compiler converts to snake_case at SQL emission, not us.
 */
class FieldRef {
  constructor(readonly name: string) {}

  eq(value: unknown): Expr {
    return { kind: "binop", op: "=", field: this.name, value };
  }
  neq(value: unknown): Expr {
    return { kind: "binop", op: "!=", field: this.name, value };
  }
  lt(value: unknown): Expr {
    return { kind: "binop", op: "<", field: this.name, value };
  }
  lte(value: unknown): Expr {
    return { kind: "binop", op: "<=", field: this.name, value };
  }
  gt(value: unknown): Expr {
    return { kind: "binop", op: ">", field: this.name, value };
  }
  gte(value: unknown): Expr {
    return { kind: "binop", op: ">=", field: this.name, value };
  }
  exists(): Expr {
    return { kind: "exists", field: this.name };
  }
  desc(): OrderSpec {
    return { kind: "order", field: this.name, direction: "desc" };
  }
  asc(): OrderSpec {
    return { kind: "order", field: this.name, direction: "asc" };
  }
}

function makeTypeRef(): TypeRef {
  return new Proxy({} as TypeRef, {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      return new FieldRef(prop);
    }
  });
}

/** Infer the EdgeQL cast for a JS variable. Conservative — unknown types throw. */
function inferCast(value: unknown): string {
  if (typeof value === "string") {
    return "str";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "bigint") {
    return "bigint";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int64" : "float64";
  }
  if (value instanceof Date) {
    return "datetime";
  }
  if (value instanceof Uint8Array) {
    return "bytes";
  }
  throw new Error(
    `Cannot infer EdgeQL cast for filter value of type ${typeof value}`
  );
}

interface CompileCtx {
  vars: Record<string, unknown>;
  nextN: number;
}

function isExpr(x: FilterArg): x is Expr {
  return typeof x === "object" && x !== null && "kind" in x &&
    typeof (x as { kind: unknown; }).kind === "string" &&
    ["binop", "exists", "and", "or", "not"].includes(
      (x as { kind: string; }).kind
    );
}

function compileExpr(arg: FilterArg, ctx: CompileCtx): string {
  if (!isExpr(arg)) {
    throw new Error(
      "Plain Filter objects are not supported in the runtime SelectChain DSL. " +
        "Use FieldRef-based predicates (e.g., ref => ref.email.eq(\"x\")), " +
        "or compile via the codegen client's filter() method."
    );
  }
  switch (arg.kind) {
    case "binop": {
      const param = `p${ctx.nextN++}`;
      ctx.vars[param] = arg.value;
      return `.${escapeEdgeQLIdent(arg.field)} ${arg.op} <${inferCast(arg.value)}>$${param}`;
    }
    case "exists":
      return `exists .${escapeEdgeQLIdent(arg.field)}`;
    case "and":
      return arg.exprs.map(e => `(${compileExpr(e, ctx)})`).join(" and ");
    case "or":
      return arg.exprs.map(e => `(${compileExpr(e, ctx)})`).join(" or ");
    case "not":
      return `not (${compileExpr(arg.expr, ctx)})`;
  }
}

function compileShape(shape: Shape): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    assertIdent(key, "shape field");
    if (value === true) {
      parts.push(escapeEdgeQLIdent(key));
    } else {
      parts.push(`${escapeEdgeQLIdent(key)}: ${compileShape(value)}`);
    }
  }
  return `{ ${parts.join(", ")} }`;
}

/** Compiled output of `toEdgeQL()` — fed straight to `client.query()`. */
export interface CompiledQuery {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Boolean combinators. Accept either runtime-DSL `Expr` nodes (produced
 * by FieldRef methods like `ref.email.eq(...)`) OR codegen Filter objects
 * (`{ email: "x" }`). The runtime DSL only knows how to compile Expr
 * children; the codegen client knows how to compile both. Top-level
 * object keys inside a Filter are implicit-AND, so reach for `and()`
 * only when you need to nest under `or` / `not`.
 */
export function and(...args: FilterArg[]): Expr {
  return { kind: "and", exprs: args };
}
export function or(...args: FilterArg[]): Expr {
  return { kind: "or", exprs: args };
}
export function not(arg: FilterArg): Expr {
  return { kind: "not", expr: arg };
}

/**
 * The chainable builder returned by `from(Type)` or `qb.Type`. Every
 * mutator returns the same instance for chaining. Awaiting the chain
 * runs it via the attached client (if one was provided).
 */
export class SelectChain<T = unknown> implements PromiseLike<T> {
  private readonly typeName: string;
  private shape: Shape | null = null;
  private filters: Expr[] = [];
  private order: OrderSpec | null = null;
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private readonly client: QueryRunner | null;

  constructor(typeName: string, client: QueryRunner | null = null) {
    assertIdent(typeName, "type name");
    this.typeName = typeName;
    this.client = client;
  }

  select(shape: Shape): this {
    // Validate keys eagerly so injection-shaped names fail fast, not at run time.
    for (const key of Object.keys(shape)) {
      assertIdent(key, "shape field");
    }
    this.shape = shape;
    return this;
  }

  filter(predicate: (ref: TypeRef) => Expr): this {
    this.filters.push(predicate(makeTypeRef()));
    return this;
  }

  orderBy(fn: (ref: TypeRef) => OrderTarget): this {
    const target = fn(makeTypeRef());
    if (target instanceof FieldRef) {
      this.order = { kind: "order", field: target.name, direction: "asc" };
    } else {
      this.order = target;
    }
    return this;
  }

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("limit() requires a non-negative integer");
    }
    this.limitN = n;
    return this;
  }

  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("offset() requires a non-negative integer");
    }
    this.offsetN = n;
    return this;
  }

  toEdgeQL(): CompiledQuery {
    const ctx: CompileCtx = { vars: {}, nextN: 0 };
    const parts: string[] = [`select ${this.typeName}`];

    if (this.shape) {
      parts.push(compileShape(this.shape));
    }

    if (this.filters.length === 1) {
      parts.push(`filter ${compileExpr(this.filters[0], ctx)}`);
    } else if (this.filters.length > 1) {
      const combined = this
        .filters
        .map(e => `(${compileExpr(e, ctx)})`)
        .join(" and ");
      parts.push(`filter ${combined}`);
    }

    if (this.order) {
      const dir = this.order.direction === "desc" ? " desc" : "";
      parts.push(`order by .${escapeEdgeQLIdent(this.order.field)}${dir}`);
    }

    if (this.limitN !== null) {
      parts.push(`limit ${this.limitN}`);
    }
    if (this.offsetN !== null) {
      parts.push(`offset ${this.offsetN}`);
    }

    return { query: parts.join(" "), variables: ctx.vars };
  }

  /** Run the query against the attached client. Throws if no client. */
  async run<R = T>(options?: QueryOptions<R>): Promise<R> {
    if (!this.client) {
      throw new Error(
        "SelectChain has no client attached — call toEdgeQL() and run it manually, or use createQueryBuilder(client)."
      );
    }
    const compiled = this.toEdgeQL();
    return await this.client.query<R>(
      compiled.query,
      compiled.variables,
      options
    );
  }

  /**
   * Run with `limit 1` and unwrap to a single row (or `null` if empty).
   * Mutates `limitN` so subsequent `toEdgeQL()` reflects the limit.
   */
  async first<R = unknown>(options?: QueryOptions<R[]>): Promise<R | null> {
    this.limitN = 1;
    const arr = await this.run<R[]>(options);
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  }

  /** PromiseLike: `await chain` is sugar for `chain.run()`. */
  // deno-lint-ignore no-explicit-any
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled as never, onrejected);
  }
}

/**
 * Standalone factory — `from("User").select({...})` produces a chain
 * with no client, useful for unit tests or hand-running the compiled
 * fragment through any EdgeQL transport.
 */
export function from<T = unknown>(typeName: string): SelectChain<T> {
  return new SelectChain<T>(typeName, null);
}

/** Root proxy: `qb.User.select(...)` resolves to a SelectChain bound to the client. */
export type QueryBuilder = Record<string, SelectChain>;

// --- Typed builder (Phase 2 — driven by `defineSchema()`) ---

/** Typed FieldRef — `eq()` etc. accept only the field's TS type. */
export interface TypedFieldRef<T> {
  eq(value: T): Expr;
  neq(value: T): Expr;
  lt(value: T): Expr;
  lte(value: T): Expr;
  gt(value: T): Expr;
  gte(value: T): Expr;
  exists(): Expr;
  desc(): OrderSpec;
  asc(): OrderSpec;
}

/** A typed reference handed to `filter()` / `orderBy()` predicates. */
export type TypedRef<S extends SchemaSpec, K extends keyof S> = {
  [F in keyof S[K]]: TypedFieldRef<FieldType<S, S[K][F]>>;
};

/**
 * The chain returned by `qb.User`. Methods narrow the awaited row type
 * as the user composes the query. Backed at runtime by the same
 * `SelectChain` class — type narrowing is intersection-based, not a
 * different runtime class.
 */
export type TypedSelectChain<
  S extends SchemaSpec,
  K extends keyof S,
  Sel = ResolveType<S, S[K]>
> =
  & Omit<
    SelectChain<Sel[]>,
    | "select"
    | "filter"
    | "orderBy"
    | "limit"
    | "offset"
    | "first"
    | "then"
    | "run"
  >
  & {
    select<Sh extends SelectShape<S, K>>(
      shape: Sh
    ): TypedSelectChain<S, K, ResolveSelected<S, K, Sh>>;
    filter(
      predicate: (ref: TypedRef<S, K>) => Expr
    ): TypedSelectChain<S, K, Sel>;
    orderBy(
      fn: (ref: TypedRef<S, K>) => OrderSpec | TypedFieldRef<unknown>
    ): TypedSelectChain<S, K, Sel>;
    limit(n: number): TypedSelectChain<S, K, Sel>;
    offset(n: number): TypedSelectChain<S, K, Sel>;
    first(options?: QueryOptions<Sel[]>): Promise<Sel | null>;
    run(options?: QueryOptions<Sel[]>): Promise<Sel[]>;
    then<TResult1 = Sel[], TResult2 = never>(
      onfulfilled?: ((value: Sel[]) => TResult1 | PromiseLike<TResult1>) | null,
      // deno-lint-ignore no-explicit-any
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2>;
  };

/** Typed root proxy — one chain per type defined in the schema. */
export type TypedQueryBuilder<S extends SchemaSpec> = {
  [K in keyof S & string]: TypedSelectChain<S, K>;
};

/**
 * Bind the builder to a client so chains are awaitable. With a schema,
 * `qb.User.select(...)` is fully typed; without one, types stay
 * permissive (useful for ad-hoc queries or test code).
 *
 * The `client` argument is duck-typed against `QueryRunner` — a real
 * `DiscClient` works, and so does any test fake that implements
 * `query()`.
 */
export function createQueryBuilder(client: QueryRunner): QueryBuilder;
export function createQueryBuilder<S extends SchemaSpec>(
  client: QueryRunner,
  schema: DiscSchema<S>
): TypedQueryBuilder<S>;
export function createQueryBuilder(
  client: QueryRunner,
  schema?: DiscSchema<SchemaSpec>
  // deno-lint-ignore no-explicit-any
): any {
  return new Proxy({} as QueryBuilder, {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      // When a schema is provided, refuse access to undeclared types
      // at runtime — catches typos that would otherwise hit the server.
      if (schema && !(prop in schema.spec)) {
        throw new Error(
          `Type ${JSON.stringify(prop)} is not defined in the schema. Available: ${Object.keys(schema.spec).join(", ")}`
        );
      }
      return new SelectChain(prop, client);
    }
  });
}
