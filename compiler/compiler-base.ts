/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Compiler base layer: module-level type-mapping helpers, compiler options,
 * and the abstract root class of the EdgeQL compiler inheritance chain —
 * construction, instance state, and small shared utility predicates.
 */

import {
  AccessConfig,
  AccessContext,
  AccessDecision,
  AccessEvaluator,
  AccessPolicy,
  AccessSQLInjector
} from "../access/mod.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { CompilationError, type ErrorContext } from "../lib/errors.ts";
import { normalizeStdTypeName } from "../lib/std-types.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

/*** Where `node` is in the query, as a CompilationError's context (none when the parser recorded no span). ***/
export function locationOf(node: EdgeQLAST.EdgeQLNode | undefined): ErrorContext | undefined {
  const start = node?.span?.start;
  return start ? { location: { column: start.column, line: start.line, offset: start.offset } } : undefined;
}

/*** The operand of `detached <expr>` (the parser's `DETACHED` unary operator, or a `Detached` node), else null. ***/
export function detachedOperand(expr: EdgeQLAST.Expression): EdgeQLAST.Expression | null {
  if (expr.kind === "Detached") {
    return expr.expr;
  }
  return expr.kind === "UnaryOp" && expr.op === "DETACHED" ? expr.operand : null;
}

/**
 * Extract the intersection type name from a backlink step's optional
 * filter. The parser emits `[is X]` as a `TypeName` AST node here (see
 * edgeql/parser.ts:1227). Other filter expressions are valid EdgeQL but
 * map to a different code path, so this helper only matches `[is X]`.
 */
export function backlinkIntersectionName(
  filter: EdgeQLAST.Expression | undefined
): string | null {
  if (!filter || filter.kind !== "TypeName") {
    return null;
  }
  return (filter as EdgeQLAST.TypeName).name.parts.join("::");
}

/**
 * True when a select of `typeDef`'s objects keeps at most one, as Gel
 * infers it: `limit 1`, or a filter requiring `.id` or an exclusive
 * property to equal one value.
 */
export function selectKeepsAtMostOne(query: EdgeQLAST.SelectQuery, typeDef: Context.TypeDef): boolean {
  if (query.limit?.kind === "Literal" && Number(query.limit.value) <= 1) {
    return true;
  }
  const conjuncts = (expr: EdgeQLAST.Expression): EdgeQLAST.Expression[] =>
    expr.kind === "BinaryOp" && expr.op === "AND" ? [...conjuncts(expr.left), ...conjuncts(expr.right)] : [expr];
  const isUnique = (expr: EdgeQLAST.Expression): boolean => {
    if (expr.kind !== "Path" || expr.rooted || expr.steps.length !== 1 || expr.steps[0].type !== "property") {
      return false;
    }
    const name = expr.steps[0].name;
    return name === "id" || (typeDef.properties.get(name)?.constraints?.some(constraint => constraint.name === "exclusive") ?? false);
  };
  const isOneValue = (expr: EdgeQLAST.Expression): boolean =>
    ["GlobalRef", "Identifier", "Literal", "Parameter"].includes(expr.kind) || (expr.kind === "TypeCast" && isOneValue(expr.expr));
  return query.filter !== undefined && conjuncts(query.filter).some(condition =>
    condition.kind === "BinaryOp" && condition.op === "=" &&
    ((isUnique(condition.left) && isOneValue(condition.right)) || (isUnique(condition.right) && isOneValue(condition.left)))
  );
}

/**
 * Render a TypeName AST node back to its EdgeQL textual form, including
 * any generic subtypes — e.g. `array<str>`, `tuple<str, int64>`,
 * `array<array<int>>`. Used to build the lookup key for the PG type map.
 */
export function renderEdgeQLTypeName(type: EdgeQLAST.TypeName): string {
  const head = type.name.parts.join("::");
  const label = type.fieldName ? `${type.fieldName}: ` : "";
  if (!type.subtypes || type.subtypes.length === 0) {
    return `${label}${head}`;
  }
  return `${label}${head}<${type.subtypes.map(renderEdgeQLTypeName).join(", ")}>`;
}

/**
 * The elements of the tuple type `typeName`, each with its name when the
 * tuple is named: `tuple<n: int64, str>` → `[{ name: "n", type: "int64" },
 * { type: "str" }]`. Null when `typeName` is no tuple type.
 */
export function tupleTypeElements(typeName: string): { name?: string; type: string; }[] | null {
  const name = typeName.trim();
  if (!name.startsWith("tuple<") || !name.endsWith(">")) {
    return null;
  }
  // Split at the commas outside any `<…>`.
  const body = name.slice("tuple<".length, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "<") {
      depth++;
    } else if (body[i] === ">") {
      depth--;
    } else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map(part => {
    // A named element is `name: type`; `::` is a module separator.
    const named = /^\s*(\w+)\s*:(?!:)(.*)$/s.exec(part);
    return named ? { name: named[1], type: named[2].trim() } : { type: part.trim() };
  });
}

/**
 * The `nulls` placement for an EdgeQL order key: `empty first|last` is SQL
 * `NULLS FIRST|LAST`, since the empty set compiles to NULL. Without the
 * clause Gel sorts empty first for `asc` and last for `desc` (the reverse of
 * PG's default), so that placement is spelled out — unless the key can never
 * be empty, where it changes nothing and leaving it off keeps the key usable
 * by a default btree index (as Gel does for required exclusive properties).
 */
export function compileEmptyOrder(item: EdgeQLAST.OrderByClause, neverEmpty = false): Pick<SQL.OrderByItem, "nulls"> {
  if (item.emptyOrder === "EMPTY FIRST") {
    return { nulls: "FIRST" };
  }
  if (item.emptyOrder === "EMPTY LAST") {
    return { nulls: "LAST" };
  }
  if (neverEmpty) {
    return {};
  }
  return { nulls: item.direction === "DESC" ? "LAST" : "FIRST" };
}

/**
 * The elements of a set literal with nested set literals spliced in:
 * `{1, {2, 3}, {}}` is the set `{1, 2, 3}`.
 */
export function flattenSetElements(set: EdgeQLAST.SetExpr): EdgeQLAST.Expression[] {
  return set.elements.flatMap(element => element.kind === "SetExpr" ? flattenSetElements(element) : [element]);
}

/**
 * Maps EdgeQL type names to PostgreSQL type names. Agrees with the column
 * types of `migration/ddl.ts` (`mapEdgeQLTypeToPostgreSQL`), so a value cast
 * to a property's type has its column's type. `scalars` (`Schema.scalars`)
 * resolves a user scalar to the built-in type it extends.
 */
export function edgeqlTypeToPgType(edgeqlType: string, scalars?: Map<string, string>): string {
  const typeMap: Record<string, string> = {
    str: "text",
    int16: "smallint",
    int32: "integer",
    int64: "bigint",
    float32: "real",
    float64: "double precision",
    bool: "boolean",
    bytes: "bytea",
    datetime: "timestamptz",
    duration: "interval",
    json: "jsonb",
    uuid: "uuid",
    bigint: "numeric",
    decimal: "numeric",
    sequence: "bigint",
    "cal::local_date": "date",
    "cal::local_time": "time without time zone",
    "cal::local_datetime": "timestamp without time zone",
    "cal::relative_duration": "interval",
    "cal::date_duration": "interval",
    // Array types
    "array<str>": "text[]",
    "array<int16>": "smallint[]",
    "array<int32>": "integer[]",
    "array<int64>": "bigint[]",
    "array<float32>": "real[]",
    "array<float64>": "double precision[]",
    "array<bool>": "boolean[]",
    "array<uuid>": "uuid[]",
    "array<datetime>": "timestamptz[]",
    "array<duration>": "interval[]",
    "array<json>": "jsonb[]",
    "array<bytes>": "bytea[]",
    "array<bigint>": "numeric[]",
    "array<decimal>": "numeric[]",
    "array<sequence>": "bigint[]",
    "array<cal::local_date>": "date[]",
    "array<cal::local_time>": "time without time zone[]",
    "array<cal::local_datetime>": "timestamp without time zone[]",
    "array<cal::relative_duration>": "interval[]",
    "array<cal::date_duration>": "interval[]",
    // Range types
    "range<int32>": "int4range",
    "range<int64>": "int8range",
    "range<float32>": "numrange",
    "range<float64>": "numrange",
    "range<decimal>": "numrange",
    "range<datetime>": "tstzrange",
    "range<cal::local_date>": "daterange",
    "range<cal::local_datetime>": "tsrange",
    // Multirange types
    "multirange<int32>": "int4multirange",
    "multirange<int64>": "int8multirange",
    "multirange<float32>": "nummultirange",
    "multirange<float64>": "nummultirange",
    "multirange<decimal>": "nummultirange",
    "multirange<datetime>": "tstzmultirange",
    "multirange<cal::local_date>": "datemultirange",
    "multirange<cal::local_datetime>": "tsmultirange"
  };
  const name = normalizeStdTypeName(edgeqlType);
  if (typeMap[name]) {
    return typeMap[name];
  }

  // Tuple types map to jsonb (PostgreSQL has no native tuple type)
  if (name.startsWith("tuple<")) {
    return "jsonb";
  }

  // Arrays of non-scalar elements (e.g. array<tuple<...>>) have no native PG
  // array representation — only the scalar `array<T>` forms above do. Store
  // them as jsonb, matching how the tuple element itself is stored.
  if (name.startsWith("array<tuple<")) {
    return "jsonb";
  }

  // A user scalar (`scalar type Count extending int64`) is its base type;
  // `array<Count>` an array of it.
  const scalarBase = (scalar: string): string | undefined => scalars?.get(scalar) ?? scalars?.get(scalar.replace(/^default::/, ""));
  const base = scalarBase(name);
  if (base) {
    return edgeqlTypeToPgType(base);
  }

  const elementBase = scalarBase(/^array<(.+)>$/.exec(name)?.[1] ?? "");
  if (elementBase) {
    return edgeqlTypeToPgType(`array<${elementBase}>`);
  }

  return edgeqlType;
}

export interface CompilerOptions {
  enableAccessControl?: boolean;
  accessConfig?: AccessConfig;
  accessContext?: AccessContext;
}

/*** Calls `onParameter` with the bare name (no `$`) of every Parameter node under `node`, in AST-walk order. ***/
function visitParameters(node: unknown, onParameter: (bare: string) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  const obj = node as { kind?: string; name?: string; };
  if (obj.kind === "Parameter" && typeof obj.name === "string") {
    onParameter(obj.name.startsWith("$") ? obj.name.slice(1) : obj.name);
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        visitParameters(item, onParameter);
      }
    } else if (v && typeof v === "object") {
      visitParameters(v, onParameter);
    }
  }
}

/**
 * Walk a query AST and assign each named parameter a 1-indexed position
 * in first-seen order. Numeric parameters (`$0`, `$1`, ...) are skipped
 * because they bring their own index from the source. Used by `compile()`
 * when the caller doesn't pre-supply a map.
 */
export function buildParameterIndex(node: unknown): Map<string, number> {
  const out = new Map<string, number>();

  visitParameters(node, bare => {
    // Numeric parameters keep their source-supplied index.
    if (Number.isNaN(parseInt(bare, 10)) && !out.has(bare)) {
      out.set(bare, out.size + 1);
    }
  });

  return out;
}

/**
 * Variable names in bind order: `names[i]` is the variable PostgreSQL's
 * `$${i + 1}` refers to. `parameterIndex` is the map `compile()` was given
 * (named parameters); numeric parameters sit at their own index (`$0` → `$1`),
 * exactly as `compileParameter` emits them. The binding layer uses this to bind
 * a request's variables by name, so it has to be stored with a cached
 * compilation: the query AST is not available on a cache hit.
 */
export function parameterBindOrder(node: unknown, parameterIndex: Map<string, number>): string[] {
  const names: string[] = [];

  for (const [name, position] of parameterIndex) {
    names[position - 1] = name;
  }

  visitParameters(node, bare => {
    const numeric = parseInt(bare, 10);
    if (!Number.isNaN(numeric)) {
      names[numeric] = bare;
    }
  });

  return names;
}

/**
 * Bare names of the parameters cast `<optional T>` under `node`. The binding
 * layer lets these be left out of a request (they bind as NULL). Like
 * `parameterBindOrder`, this is stored with a cached compilation.
 */
export function optionalParameterNames(node: unknown): string[] {
  const names = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const obj = value as Partial<EdgeQLAST.TypeCast>;
    if (obj.kind === "TypeCast" && obj.cardinality?.required === false && obj.expr?.kind === "Parameter") {
      names.add(obj.expr.name.startsWith("$") ? obj.expr.name.slice(1) : obj.expr.name);
    }
    Object.values(value).forEach(visit);
  };

  visit(node);
  return [...names];
}

/**
 * What a query's result is, as far as the response layer is concerned. Derived
 * from the query AST, never from the SQL text: `select (update …) { id }` and a
 * junction-backed multi-link write both emit `WITH … UPDATE … SELECT`, yet the
 * first answers with a row set and the second with one mutated row. The AST is
 * not available on a compiled-query cache hit, so this is stored with the
 * cached compilation, like `parameterBindOrder`.
 */
export interface ResultInfo {
  /**
   * `"rows"`: the statement answers with its row set as-is, `[]` when empty —
   * a select (directly, or as the body of a `with` block, including a select
   * over a mutation), a group, a describe, an explain. `"mutation"`: anything
   * else; an insert, update or delete answers with the rows it wrote, as Gel
   * does (`[]` when none), anything else with a plain status.
   */
  kind: "rows" | "mutation";
  /**
   * For a bare `insert`/`update`/`delete`: the mutated type as the query
   * spelled it. Its `RETURNING *` rows carry column names, which the response
   * layer maps back to property names through this type.
   */
  mutatedType?: string;
  /**
   * Which statement a `"mutation"` result comes from — bare, as the body of a
   * `with` block, or as the body of a set-literal `for`; the rows it wrote are
   * the response. Absent for statements with a plain status response
   * (`configure`, `set global`).
   */
  mutation?: "insert" | "update" | "delete";
  /**
   * For `"rows"`: the statement selects values, not objects (see
   * `EdgeQLCompiler.selectsValues`), so each row's one column is answered
   * bare — `select User.name` is `["ann"]`, not `[{"name": "ann"}]`. Set from
   * the compilation, not from the query alone.
   */
  values?: boolean;
  /**
   * For `set global`: the global being set, so the handler takes the session
   * path (record the setting, answer `{success, global}`) on a cache hit too,
   * where it has no query AST.
   */
  setGlobal?: { module?: string; name: string; };
}

export function isMutationQuery(
  query: EdgeQLAST.Query
): query is EdgeQLAST.InsertQuery | EdgeQLAST.UpdateQuery | EdgeQLAST.DeleteQuery {
  return query.kind === "InsertQuery" || query.kind === "UpdateQuery" || query.kind === "DeleteQuery";
}

const MUTATION_OF: Record<string, ResultInfo["mutation"]> = {
  DeleteQuery: "delete",
  InsertQuery: "insert",
  UpdateQuery: "update"
};

export function describeResult(query: EdgeQLAST.Query): ResultInfo {
  switch (query.kind) {
    case "SelectQuery":
    case "GroupQuery":
    case "DescribeType":
    case "DescribeSchema":
    case "ExplainQuery":
      return { kind: "rows" };
    case "WithBlock": {
      // The body decides; a mutation's `RETURNING *` rows map through its
      // type, as a bare mutation's do.
      const body = describeResult(query.body);
      return body.kind === "rows" ? { kind: "rows" } : { kind: "mutation", mutatedType: body.mutatedType, mutation: body.mutation };
    }
    case "DeleteQuery":
    case "InsertQuery":
    case "UpdateQuery":
      return { kind: "mutation", mutatedType: query.type.name.parts.join("::"), mutation: MUTATION_OF[query.kind] };
    case "ForQuery": {
      // `for x in <function or subquery> union (…)` answers with its row set:
      // for a bulk insert, the ids of the rows it inserted (`[]` when every row
      // conflicted). A set-literal for-insert is one multi-row INSERT and keeps
      // the bare-insert response; a set-literal for over a select is rows.
      if (query.iterator.kind !== "SetExpr") {
        return { kind: "rows" };
      }
      const body = describeResult(query.body);
      return body.kind === "rows" ? { kind: "rows" } : { kind: "mutation", mutatedType: body.mutatedType, mutation: body.mutation };
    }
    case "SetGlobalQuery":
      return { kind: "mutation", setGlobal: { module: query.module, name: query.name } };
    default:
      return { kind: "mutation" };
  }
}

/**
 * Walk a compiled SQL AST and map each parameter's 1-indexed position to the
 * PostgreSQL type it is cast to (e.g. `1 -> "jsonb"`, `2 -> "text[]"`). Built
 * from `CastExpression` nodes wrapping a `ParameterReference`, which is how the
 * compiler emits every typed parameter (`CAST($n AS <type>)`). The binding
 * layer uses this to decide which params need JSON serialization (jsonb) versus
 * native driver encoding (scalars, PG arrays).
 */
export function buildParameterTypeMap(node: unknown): Map<number, string> {
  const out = new Map<number, string>();

  function visit(n: unknown): void {
    if (!n || typeof n !== "object") {
      return;
    }
    const obj = n as {
      kind?: string;
      targetType?: string;
      expression?: { kind?: string; index?: number; };
    };
    if (
      obj.kind === "CastExpression" &&
      typeof obj.targetType === "string" &&
      obj.expression &&
      obj.expression.kind === "ParameterReference" &&
      typeof obj.expression.index === "number"
    ) {
      out.set(obj.expression.index, obj.targetType);
    }
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          visit(item);
        }
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }

  visit(node);
  return out;
}

/**
 * The alias of a policy-filtered table inside its own subquery (see
 * `tableRowsWhere`), and of the object row a compiled policy condition reads
 * (see `policyConditionSql`).
 */
export const POLICY_ROWS = "__policy_rows";

export abstract class CompilerBase {
  protected ctx: Context.CompilationContext;
  protected accessEvaluator?: AccessEvaluator;
  protected accessInjector?: AccessSQLInjector;
  protected accessContext: AccessContext;
  /**
   * Set while a policy's condition compiles (see `policyConditionSql`): as in
   * Gel, policy expressions ignore every policy, so no read in one is narrowed.
   */
  protected compilingPolicy = false;
  /**
   * The alias a policy's condition reads the object's row by: `__policy_rows`
   * (see `tableRowsWhere`, and a written row's check), or a mutation's target
   * table where its WHERE reads it directly (see `withPolicySubject`).
   */
  protected policySubject = POLICY_ROWS;
  protected enableAccessControl: boolean;
  /**
   * Maps each named EdgeQL parameter (without leading `$`) to its 1-indexed
   * position in the bound-values array. Populated at the start of compile()
   * by walking the AST in first-seen order, so PG `$N` placeholders line up
   * with the values the binary protocol layer (and any other caller passing
   * `parameterMap`) supplies in that same order.
   */
  protected parameterIndex: Map<string, number> = new Map();
  /**
   * The table references the pass that narrows object reads leaves as they
   * are: those `tableRowsWhere` filters itself, and mutation targets read as
   * a table (see `mutationTargetTable`).
   */
  private exemptTables = new WeakSet<SQL.TableReference>();
  /**
   * The table references of reads that start from a type rather than from a
   * mutation's result (see `readingSnapshot`): they read the table as it was
   * before the statement, while select policies still narrow them.
   */
  private snapshotTables = new WeakSet<SQL.TableReference>();
  /** The CTE names this compilation has taken (see `claimCteName`). */
  protected cteNames = new Set<string>();
  /**
   * Set while a select of a mutation's result compiles: the mutation's
   * data-modifying CTEs, whose tables it reads as they are after the
   * statement (see `mutationOverlay`).
   */
  protected mutationWrites: Context.MutationWrite[] | undefined;
  /**
   * The rows each junction table a statement writes holds once it is done,
   * as a policy's condition in the check on the objects the statement writes
   * reads them (see `EdgeQLCompiler.withJunctionWrites`): a factory of the
   * rows, by junction table. Empty while anything else compiles.
   */
  protected junctionOverlays = new Map<string, () => SQL.SQLStatement>();

  constructor(schema: Context.Schema, options?: CompilerOptions) {
    this.ctx = Context.createContext(schema);

    // Access control is enabled by default
    this.enableAccessControl = options?.enableAccessControl !== false;
    this.accessContext = options?.accessContext || {};

    if (this.enableAccessControl) {
      // Initialize access control with default permissive config
      const config = options?.accessConfig || {
        mode: "permissive",
        defaultAllow: true,
        enableRLS: true,
        enableAudit: false
      };

      this.accessEvaluator = new AccessEvaluator(config);
      this.accessEvaluator.setGlobalResolver((name, objectType) => this.policyGlobalSql(name, objectType));
      this.accessEvaluator.setPolicyCompiler((edgeql, objectType) => this.policyConditionSql(edgeql, objectType));
      this.accessInjector = new AccessSQLInjector(this.accessEvaluator);
    }
  }

  /**
   * The SQL value of the custom global `name` read by a policy of
   * `objectType` (resolved in that type's module), or undefined when the
   * schema declares no such global.
   */
  protected abstract policyGlobalSql(name: string, objectType: string | undefined): string | undefined;

  /**
   * A policy's condition on objects of `objectType` (EdgeQL), as SQL over the
   * object's row aliased `__policy_rows` (see `AccessPolicyCompiler`).
   */
  protected abstract policyConditionSql(edgeql: string, objectType: string): string;

  /*** A scalar constraint (EdgeQL over `$__subject__`, names resolved in `module`) as SQL over `column` (see `EdgeQLCompiler.subjectCheckSql`). ***/
  abstract subjectCheckSql(edgeql: string, module: string, column: string | null): string;

  /*** `run`, with the policy conditions it compiles reading the object's row as `alias`. ***/
  protected withPolicySubject<T>(alias: string, run: () => T): T {
    const outer = this.policySubject;
    this.policySubject = alias;
    try {
      return run();
    } finally {
      this.policySubject = outer;
    }
  }

  /**
   * A compiled policy condition as SQL text. Its reads are not narrowed by
   * any policy (a policy expression ignores policies), but a read of an
   * abstract type's table still becomes a read of its objects.
   */
  protected renderPolicySql(expr: SQL.SQLExpression): string {
    this.restrictReads(expr, new Set(), false);
    return new SQLCodeGenerator().generateExpression(expr);
  }

  /**
   * Register an access policy (only works if access control is enabled)
   */
  registerAccessPolicy(policy: AccessPolicy): void {
    if (this.accessEvaluator) {
      this.accessEvaluator.registerPolicy(policy);
    }
  }

  /**
   * Set the access context for the current compilation
   */
  setAccessContext(context: AccessContext): void {
    this.accessContext = context;
  }

  /**
   * A CTE name no other CTE of this compilation has: `base`, or `base_<n>`
   * once `base` is taken. The data-modifying CTEs of every mutation in a
   * query end up in one top-level WITH (see `hoistMutations`), so their
   * names must differ.
   */
  protected claimCteName(base: string): string {
    const name = this.cteNames.has(base) ? Context.generateAlias(this.ctx, base) : base;
    this.cteNames.add(name);
    return name;
  }

  /** Check if an EdgeQL binary operator is a set operation. */
  protected isSetOperator(op: string): boolean {
    return op === "UNION" || op === "INTERSECT" || op === "EXCEPT";
  }

  /**
   * Renders a SQL AST expression to a SQL string (for RawSQLExpression
   * construction). Its reads of object tables are narrowed to the rows the
   * select policies show first: once text, they are out of the final pass's
   * reach.
   */
  protected renderSqlExpr(expr: SQL.SQLExpression): string {
    this.restrictObjectReads(expr, new Set(this.ctx.cteAliases.keys()));
    return new SQLCodeGenerator().generateExpression(expr);
  }

  /*** Renders a whole statement to SQL text, its object reads narrowed as `renderSqlExpr` does. ***/
  protected renderSqlStatement(statement: SQL.SQLStatement): string {
    this.restrictObjectReads(statement, new Set(this.ctx.cteAliases.keys()));
    return new SQLCodeGenerator().generate(statement);
  }

  /**
   * Access policy SQL conditions combined into one expression: any one
   * allowing policy is enough (permissive mode; restrictive mode's denials
   * are decided by the evaluator).
   */
  protected parseAccessConditions(
    sqlConditions: string[]
  ): SQL.SQLExpression | null {
    if (sqlConditions.length === 0) {
      return null;
    }

    // For now, create raw SQL expressions
    // In a production system, we'd parse these properly
    const conditions = sqlConditions.map(sql => ({
      kind: "RawSQLExpression" as const,
      sql: sql
    }));

    // Combine multiple conditions with OR (permissive mode)
    // In restrictive mode we'd use AND, but that's handled by the evaluator
    return conditions.slice(1).reduce<SQL.SQLExpression>((acc, cond) => ({
      kind: "BinaryExpression",
      operator: "OR",
      left: acc,
      right: cond
    }), conditions[0]);
  }

  /**
   * The rows an access decision keeps, as a predicate: those an allowing
   * policy's condition holds for (any one is enough), less those a denying
   * policy's condition holds for. Undefined when it keeps every row.
   */
  protected decisionFilter(decision: AccessDecision): SQL.SQLExpression | undefined {
    const allowed = this.parseAccessConditions(decision.sqlConditions ?? []) ?? undefined;
    const denies = decision.denySqlConditions ?? [];
    if (denies.length === 0) {
      return allowed;
    }
    const notDenied: SQL.SQLExpression = {
      kind: "RawSQLExpression",
      sql: `NOT COALESCE(${denies.map(condition => `(${condition})`).join(" OR ")}, FALSE)`
    };
    return allowed ? SQL.createBinaryExpression("AND", allowed, notDenied) : notDenied;
  }

  /**
   * The select policy's row filter on `typeDef`: undefined when the query may
   * read every row (access control off, a bypass caller, no policy narrowing
   * select), FALSE when select is denied. The filter is policy SQL over the
   * type's row, so it only holds over the type's table aliased
   * `__policy_rows` (see `tableRowsWhere`). A policy's condition may read
   * other objects (a link, a backlink), but those reads are never narrowed —
   * as in Gel, policy expressions ignore other policies — so applying one
   * never recurses into another policy.
   */
  protected selectPolicyFilter(typeDef: Context.TypeDef): SQL.SQLExpression | undefined {
    if (
      !this.enableAccessControl || !this.accessEvaluator || this.accessContext.bypass || this.compilingPolicy ||
      typeDef.kind !== "object"
    ) {
      return undefined;
    }
    // An abstract type's objects answer to their own types' policies: the
    // ones the union of its subtypes' readable rows keeps (see restrictReads).
    const subtypes = this.concreteSubtypes(typeDef);
    if (subtypes.length > 0) {
      if (!subtypes.some(subtype => this.selectPolicyFilter(subtype))) {
        return undefined;
      }
      const readable = SQL.createSelectStatement({
        from: SQL.createFromClause([SQL.createTableReference(typeDef.tableName)]),
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("id"))])
      });
      return SQL.createBinaryExpression("IN", SQL.createColumnReference("id"), SQL.createSubqueryExpression(readable));
    }
    const decision = this.accessEvaluator.evaluate(typeDef.name, "select", this.accessContext);
    if (!decision.allowed) {
      return SQL.createLiteral("boolean", false);
    }
    return this.decisionFilter(decision);
  }

  /*** A read of `table` as it is, which the pass that narrows object reads (and overlays junction writes) leaves alone. ***/
  protected exemptTableReference(table: string, alias?: string): SQL.TableReference {
    const reference = SQL.createTableReference(table, alias);
    this.exemptTables.add(reference);
    return reference;
  }

  /**
   * `SELECT * FROM "<table>" AS "__policy_rows" WHERE <filter>`: the rows of
   * `typeDef` a policy filter keeps. The filter's unqualified columns resolve
   * against the table; the alias keeps an outer reference qualified by the
   * table's name (a mutation's target, a self link) pointing outward. The
   * pass that narrows object reads leaves this table as it is.
   */
  protected tableRowsWhere(typeDef: Context.TypeDef, filter: SQL.SQLExpression, snapshot = false): SQL.SelectStatement {
    // While a select of a mutation's result compiles, the rows as the statement leaves them.
    const overlay = snapshot ? undefined : this.mutationOverlay(typeDef.tableName);
    const table: SQL.TableReference = overlay ?
      { alias: POLICY_ROWS, kind: "TableReference", name: "", subquery: overlay } :
      SQL.createTableReference(typeDef.tableName, POLICY_ROWS);
    this.exemptTables.add(table);
    return SQL.createSelectStatement({
      from: SQL.createFromClause([table]),
      select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("*"))]),
      where: SQL.createWhereClause(filter)
    });
  }

  /**
   * `typeDef`'s table as SQL text, for the SQL the compiler writes as text:
   * `"<table>"`, or `(SELECT * FROM "<table>" WHERE <filter>)` when a select
   * policy narrows it — or the table as a mutation leaves it, for a select of
   * its result (see `mutationOverlay`).
   */
  protected readableTableSql(typeDef: Context.TypeDef): string {
    const filter = this.selectPolicyFilter(typeDef);
    if (filter) {
      return `(${this.renderSqlStatement(this.tableRowsWhere(typeDef, filter))})`;
    }
    const overlay = this.mutationOverlay(typeDef.tableName);
    if (overlay) {
      return `(${this.renderSqlStatement(overlay)})`;
    }
    // An abstract type's table stands for its subtypes' rows (see abstractTableRows).
    const abstractRows = this.abstractTableRows(typeDef.tableName);
    return abstractRows ? `(${this.renderSqlStatement(abstractRows)})` : `"${typeDef.tableName}"`;
  }

  /**
   * A junction table as SQL text, for a FROM or JOIN the compiler writes as
   * text: `"<junction>"`, followed by `alias` when given. The junction of a
   * multi link declared on an abstract type holds no rows of its own: it is
   * the union of its subtypes' junctions (see abstractTableRows), aliased by
   * `alias` or else by the junction's name, so `"<junction>".col` still resolves.
   * So is a junction a mutation writes, for a select of its result (see
   * `mutationOverlay`), and a junction the statement writes, read by the
   * check on the objects it writes (see `junctionOverlays`).
   */
  protected junctionTableSql(junctionTable: string, alias?: string): string {
    const overlay = this.junctionOverlays.get(junctionTable);
    if (overlay) {
      return `(${this.renderSqlStatement(overlay())}) "${alias ?? junctionTable}"`;
    }
    const rows = this.abstractTableRows(junctionTable) ?? this.mutationOverlay(junctionTable);
    if (rows) {
      return `(${this.renderSqlStatement(rows)}) "${alias ?? junctionTable}"`;
    }
    return alias ? `"${junctionTable}" "${alias}"` : `"${junctionTable}"`;
  }

  /**
   * `<id> IN (SELECT "id" FROM <readable rows>)` when a select policy narrows
   * `typeDef`, else undefined: for an id read without its row (a junction's
   * target column, a single link's column), which only counts when the policy
   * shows that object.
   */
  protected readableIdCondition(typeDef: Context.TypeDef, id: SQL.SQLExpression): SQL.SQLExpression | undefined {
    const filter = this.selectPolicyFilter(typeDef);
    if (!filter) {
      return undefined;
    }
    const rows = this.tableRowsWhere(typeDef, filter);
    rows.select = SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("id"))]);
    return SQL.createBinaryExpression("IN", id, SQL.createSubqueryExpression(rows));
  }

  /**
   * The object `id` (a single link's column) names, or NULL when the select
   * policy hides it: `(SELECT "id" FROM <readable rows> WHERE "id" = <id>)`.
   * `id` itself when `typeDef` is not narrowed.
   */
  protected readableId(typeDef: Context.TypeDef, id: SQL.SQLExpression): SQL.SQLExpression {
    const filter = this.selectPolicyFilter(typeDef);
    if (!filter) {
      return id;
    }
    const rows = this.tableRowsWhere(
      typeDef,
      SQL.createBinaryExpression("AND", filter, SQL.createBinaryExpression("=", SQL.createColumnReference("id", POLICY_ROWS), id))
    );
    rows.select = SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("id", POLICY_ROWS))]);
    return SQL.createSubqueryExpression(rows);
  }

  /*** `readableId` as SQL text. ***/
  protected readableIdSql(typeDef: Context.TypeDef, idSql: string): string {
    const id: SQL.SQLExpression = { kind: "RawSQLExpression", sql: idSql };
    const readable = this.readableId(typeDef, id);
    return readable === id ? idSql : this.renderSqlExpr(readable);
  }

  /*** `readableIdCondition` as SQL text, prefixed ` AND `; empty when the type is not narrowed. ***/
  protected readableIdConditionSql(typeDef: Context.TypeDef, idSql: string): string {
    const condition = this.readableIdCondition(typeDef, { kind: "RawSQLExpression", sql: idSql });
    return condition ? ` AND ${this.renderSqlExpr(condition)}` : "";
  }

  /**
   * A mutation's target table where the statement reads it as a table (the
   * source rows of a multi-link update). Like `UPDATE <table>`, it is
   * narrowed by the mutation's own row condition (select and update policy
   * together), not by this pass.
   */
  protected mutationTargetTable(typeDef: Context.TypeDef): SQL.TableReference {
    const table = SQL.createTableReference(typeDef.tableName);
    this.exemptTables.add(table);
    return table;
  }

  /**
   * Narrow every read of an object type's table under `node` to the rows its
   * select policy shows: a `FROM "<table>" [AS a]` becomes
   * `FROM (SELECT * FROM "<table>" WHERE <filter>) AS a` (aliased by the
   * table name when it had no alias, so `"<table>".col` still resolves).
   *
   * This is the one place select policies meet the objects a query reaches —
   * a `with` binding, a `for` iterator, a path's hops, a sub-shape, a
   * subquery in a filter — whatever feature built the read. Mutation targets
   * (`UPDATE t`, `DELETE FROM t`, `INSERT INTO t`) are plain names, not
   * table references: an update or delete narrows its target itself, by the
   * select policy and its own (see `mutationRowCondition`).
   *
   * It is also where a read of an abstract type's table becomes a read of
   * its objects, which live in its concrete subtypes' tables (see
   * `abstractTableRows`) — whether or not access control is on. Each
   * subtype's table is then narrowed by its own select policy, as Gel
   * applies each object's own type's policies.
   *
   * While a select of a mutation's result compiles, it is also where a read
   * of a table the mutation writes becomes a read of the table as the
   * statement leaves it (see `mutationOverlay`).
   *
   * `shadowed` holds the CTE names in scope: a reference to one reads the
   * CTE, not a table of the same name. A non-recursive CTE sees only the
   * CTEs before it; a recursive WITH sees all of its own.
   */
  protected restrictObjectReads(node: unknown, shadowed: ReadonlySet<string>): void {
    this.restrictReads(node, shadowed, this.enableAccessControl && this.accessEvaluator !== undefined && !this.accessContext.bypass);
  }

  private restrictReads(node: unknown, shadowed: ReadonlySet<string>, restrict: boolean): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        this.restrictReads(item, shadowed, restrict);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    const sqlNode = node as { kind?: string; };

    if (sqlNode.kind === "CTEStatement") {
      const statement = node as SQL.CTEStatement;
      const recursive = statement.ctes.some(cte => cte.recursive);
      const inScope = new Set(shadowed);
      if (recursive) {
        statement.ctes.forEach(cte => inScope.add(cte.name));
      }
      for (const cte of statement.ctes) {
        this.restrictReads(cte.query, inScope, restrict);
        inScope.add(cte.name);
      }
      this.restrictReads(statement.query, inScope, restrict);
      return;
    }

    if (sqlNode.kind === "TableReference") {
      const table = node as SQL.TableReference;
      const overlay = this.exemptTables.has(table) ? undefined : this.junctionOverlays.get(table.name);
      if (overlay && !table.subquery && !table.expression && !shadowed.has(table.name)) {
        table.subquery = overlay();
        table.alias = table.alias ?? table.name;
        table.name = "";
      } else if (!table.subquery && !table.expression && table.name && !shadowed.has(table.name)) {
        const abstractRows = this.abstractTableRows(table.name);
        const exempt = this.exemptTables.has(table);
        const snapshot = this.snapshotTables.has(table);
        const typeDef = abstractRows || !restrict || exempt ? undefined : this.objectTypeOfTable(table.name);
        const filter = typeDef ? this.selectPolicyFilter(typeDef) : undefined;
        const rows = abstractRows ??
          (typeDef && filter ? this.tableRowsWhere(typeDef, filter, snapshot) : exempt || snapshot ? undefined : this.mutationOverlay(table.name));
        if (rows) {
          if (snapshot) {
            // An abstract type's subtype tables, read before the statement too.
            this.markSnapshotReads(rows);
          }
          table.subquery = rows;
          table.alias = table.alias ?? table.name;
          table.name = "";
        }
      }
    }

    for (const value of Object.values(node)) {
      this.restrictReads(value, shadowed, restrict);
    }
  }

  /**
   * The concrete types whose tables hold the objects of the abstract type
   * `typeDef`: its subtypes at any depth, less the abstract ones. Empty for a
   * concrete type.
   */
  protected concreteSubtypes(typeDef: Context.TypeDef): Context.TypeDef[] {
    if (!typeDef.abstract) {
      return [];
    }
    return [...new Set(Context.getAllSubtypes(this.ctx.schema, typeDef.name))]
      .map(name => this.ctx.schema.types.get(name))
      .filter((subtype): subtype is Context.TypeDef => subtype !== undefined && !subtype.abstract);
  }

  /**
   * The columns an abstract type's objects have in each of its concrete
   * subtypes' tables: `id`, the `__type__` discriminator, and the columns of
   * its stored properties and single links, which every subtype inherits
   * under the same names.
   */
  protected abstractColumns(typeDef: Context.TypeDef): string[] {
    const columns = ["id", "__type__"];
    for (const property of typeDef.properties.values()) {
      if (!property.computed) {
        columns.push(property.columnName ?? property.name);
      }
    }
    for (const link of typeDef.links.values()) {
      if (link.columnName && !link.computed) {
        columns.push(link.columnName);
      }
    }
    return [...new Set(columns)];
  }

  /**
   * The rows a read of `table` stands for when it is the table of an abstract
   * type, or the junction table of a multi link declared on one. Neither ever
   * holds a row: an abstract type's objects, and their links, are stored in
   * its concrete subtypes' tables. So the read is of their union —
   * `SELECT <columns> FROM "<subtype>" UNION ALL …` over the columns the
   * subtypes share with the abstract type (or its junction).
   *
   * Undefined for any other table, and for an abstract type without concrete
   * subtypes, which has no objects: its own table is that empty set.
   */
  protected abstractTableRows(table: string): SQL.SQLStatement | undefined {
    for (const typeDef of this.ctx.schema.types.values()) {
      if (typeDef.kind !== "object" || !typeDef.abstract) {
        continue;
      }
      const subtypes = this.concreteSubtypes(typeDef);
      if (subtypes.length === 0) {
        continue;
      }
      if (typeDef.tableName === table) {
        return this.unionOfTables(subtypes.map(subtype => subtype.tableName), this.abstractColumns(typeDef));
      }
      for (const link of typeDef.links.values()) {
        if (link.junctionTable !== table) {
          continue;
        }
        const columns = [
          link.junctionSourceColumn ?? "source_id",
          link.junctionTargetColumn ?? "target_id",
          ...[...(link.properties?.values() ?? [])].filter(property => !property.computed).map(property => property.columnName)
        ];
        const junctions = subtypes
          .map(subtype => subtype.links.get(link.name)?.junctionTable)
          .filter((junction): junction is string => junction !== undefined);
        return this.unionOfTables(junctions, columns);
      }
    }
    return undefined;
  }

  /**
   * Compile a select of a mutation's result with `writes`, the mutation's
   * data-modifying CTEs, as the tables they write (see `mutationOverlay`).
   * Its reads of those tables are replaced as it compiles — SQL text — and
   * once it has compiled — the rest.
   */
  protected readingMutation(writes: Context.MutationWrite[], compile: () => SQL.SQLStatement): SQL.SQLStatement {
    const outer = this.mutationWrites;
    this.mutationWrites = writes;
    try {
      const statement = compile();
      this.restrictObjectReads(statement, new Set(this.ctx.cteAliases.keys()));
      return statement;
    } finally {
      this.mutationWrites = outer;
    }
  }

  /**
   * Compile a read that starts from a type (`select Item`, `Item.name`) while
   * a select of a mutation's result compiles (see `readingMutation`). As in
   * Gel, where only the sets a mutation contributes to see its writes (the
   * overlays of `get_dml_sources`), such a read sees the tables as they were
   * before the statement — `with o := (insert Item {…}) select o { n := count((select Item)) }`
   * does not count the new item — even inside the result's shape. So it
   * compiles without the mutation's tables, and its table references are
   * left as they are by the pass that replaces them (`markSnapshotReads`).
   * A select of the result nested in it (`(select o.items)`) sees the writes
   * again: it compiles, and has its reads replaced, by `readingMutation`.
   */
  protected readingSnapshot<T>(compile: () => T): T {
    const writes = this.mutationWrites;
    if (!writes) {
      return compile();
    }
    this.mutationWrites = undefined;
    try {
      const compiled = compile();
      this.markSnapshotReads(compiled);
      return compiled;
    } finally {
      this.mutationWrites = writes;
    }
  }

  /*** Mark every table reference under `node` as a read before the statement (see `readingSnapshot`). ***/
  private markSnapshotReads(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(item => this.markSnapshotReads(item));
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if ((node as { kind?: string; }).kind === "TableReference") {
      this.snapshotTables.add(node as SQL.TableReference);
    }
    Object.values(node).forEach(value => this.markSnapshotReads(value));
  }

  /**
   * `table` as the mutation whose result is being selected leaves it (see
   * `readingMutation`), or undefined when the mutation does not write it.
   * PostgreSQL runs every part of a statement on one snapshot, so the table
   * itself still has its rows from before the statement; as in Gel, a select
   * of the result sees the objects and links it wrote. They are the rows the
   * statement did not touch, followed by those its INSERTs and UPDATEs
   * returned:
   *
   *   SELECT * FROM "<table>" WHERE ("id") NOT IN (SELECT "id" FROM "ins" UNION ALL …)
   *   UNION ALL SELECT * FROM "ins" UNION ALL …
   *
   * A junction's rows are keyed by source and target, and its DELETEs (a
   * `:=` or `-=` of the link) remove rows without adding any. Each CTE is
   * made to return its rows (`RETURNING *`).
   */
  protected mutationOverlay(table: string): SQL.SQLStatement | undefined {
    const writes = this.mutationWrites?.filter(write => write.statement.table === table) ?? [];
    if (writes.length === 0) {
      return undefined;
    }
    for (const { statement } of writes) {
      const returning = statement.returning ?? [];
      if (returning.length === 0) {
        statement.returning = [SQL.createSelectItem(SQL.createColumnReference("*"))];
      } else if (!returning.every(item => item.expression.kind === "ColumnReference" && item.expression.column === "*")) {
        throw new CompilationError(`Cannot read the objects this statement writes to '${table}': it does not return their rows.`);
      }
    }

    const readAll = (name: string): SQL.SelectStatement => {
      const from = SQL.createTableReference(name);
      this.exemptTables.add(from);
      return SQL.createSelectStatement({
        from: SQL.createFromClause([from]),
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("*"))])
      });
    };
    const key = this.overlayKey(table).map(column => `"${column}"`).join(", ");
    // A CTE is named after its `with` binding, which can hold a `"`.
    const touched = writes.map(write => `SELECT ${key} FROM "${write.cte.replaceAll("\"", "\"\"")}"`).join(" UNION ALL ");
    const untouched = readAll(table);
    untouched.where = SQL.createWhereClause({ kind: "RawSQLExpression", sql: `(${key}) NOT IN (${touched})` });
    const written = writes.filter(write => write.statement.kind !== "DeleteStatement").map(write => readAll(write.cte));
    return written.length > 0 ? SQL.unionAll([untouched, ...written]) : untouched;
  }

  /*** The columns identifying a row of `table`: an object's `id`, or a junction row's source and target. ***/
  private overlayKey(table: string): string[] {
    if (this.objectTypeOfTable(table)) {
      return ["id"];
    }
    for (const typeDef of this.ctx.schema.types.values()) {
      for (const link of typeDef.links.values()) {
        if (link.junctionTable === table) {
          return [link.junctionSourceColumn ?? "source_id", link.junctionTargetColumn ?? "target_id"];
        }
      }
    }
    throw new CompilationError(`Cannot read the rows this statement writes to '${table}': it is not an object type's or a link's table.`);
  }

  /*** `SELECT <columns> FROM "<t1>" UNION ALL SELECT <columns> FROM "<t2>" …`. ***/
  private unionOfTables(tables: string[], columns: string[]): SQL.SQLStatement {
    const selects = tables.map(table =>
      SQL.createSelectStatement({
        from: SQL.createFromClause([SQL.createTableReference(table)]),
        select: SQL.createSelectClause(columns.map(column => SQL.createSelectItem(SQL.createColumnReference(column))))
      })
    );
    return selects.length === 1 ? selects[0] : SQL.unionAll(selects);
  }

  /*** The object type stored in `table`, if any. ***/
  private objectTypeOfTable(table: string): Context.TypeDef | undefined {
    for (const typeDef of this.ctx.schema.types.values()) {
      if (typeDef.kind === "object" && typeDef.tableName === table) {
        return typeDef;
      }
    }
    return undefined;
  }

  /** Comparison operators that drive EdgeQL set-vs-scalar semantics. */
  protected isComparisonOp(op: string): boolean {
    return [
      "=",
      "!=",
      "<",
      "<=",
      ">",
      ">=",
      "LIKE",
      "ILIKE",
      "IN",
      "NOT IN"
    ]
      .includes(op);
  }
}
