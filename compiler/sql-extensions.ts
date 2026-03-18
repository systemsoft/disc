/**
 * SQL Extensions for Complex Queries
 * Additional SQL builder functions for advanced features
 */

import * as SQL from "./sql.ts";

// CTE (Common Table Expression) support
export interface CTE {
  name: string;
  recursive?: boolean;
  columns?: string[];
  query: SQL.SQLStatement;
}

export interface WithClause extends SQL.SQLNode {
  kind: "WithClause";
  recursive: boolean;
  ctes: CTE[];
}

// Window function support
export interface WindowFunction extends SQL.SQLNode {
  kind: "WindowFunction";
  function: string;
  args: SQL.SQLExpression[];
  over: WindowSpec;
}

export interface WindowSpec {
  partitionBy?: SQL.SQLExpression[];
  orderBy?: OrderItem[];
  frame?: WindowFrame;
}

export interface WindowFrame {
  mode: "ROWS" | "RANGE" | "GROUPS";
  start: FrameBound;
  end?: FrameBound;
  exclude?: "CURRENT ROW" | "GROUP" | "TIES" | "NO OTHERS";
}

export type FrameBound =
  | "UNBOUNDED PRECEDING"
  | "UNBOUNDED FOLLOWING"
  | "CURRENT ROW"
  | { offset: number; direction: "PRECEDING" | "FOLLOWING" };

export interface OrderItem {
  expression: SQL.SQLExpression;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}

// Lateral join support
export interface LateralJoin extends SQL.SQLNode {
  kind: "LateralJoin";
  subquery: SQL.SQLStatement;
  alias?: string;
}

// Aggregate with filter
export interface AggregateWithFilter extends SQL.SQLNode {
  kind: "AggregateWithFilter";
  function: string;
  args: SQL.SQLExpression[];
  filter?: SQL.SQLExpression;
  distinct?: boolean;
  orderBy?: OrderItem[];
}

// Union queries
export interface UnionStatement extends SQL.SQLNode {
  kind: "UnionStatement";
  queries: SQL.SQLStatement[];
  all: boolean;
}

// Helper functions

export function withCTEs(
  ctes: CTE[],
  statement: SQL.SQLStatement,
): SQL.SQLStatement {
  return {
    ...statement,
    with: {
      kind: "WithClause",
      recursive: ctes.some((cte) => cte.recursive),
      ctes,
    },
  } as any;
}

export function windowFunction(
  func: string,
  args: SQL.SQLExpression[],
  spec: WindowSpec,
): WindowFunction {
  return {
    kind: "WindowFunction",
    function: func,
    args,
    over: spec,
  };
}

export function lateral(
  subquery: SQL.SQLStatement,
  alias?: string,
): LateralJoin {
  return {
    kind: "LateralJoin",
    subquery,
    alias,
  };
}

export function aggregateWithFilter(
  func: string,
  args: SQL.SQLExpression[],
  filter?: SQL.SQLExpression,
  distinct?: boolean,
): AggregateWithFilter {
  return {
    kind: "AggregateWithFilter",
    function: func,
    args,
    filter,
    distinct,
  };
}

export function union(
  queries: SQL.SQLStatement[],
  all = false,
): UnionStatement {
  return {
    kind: "UnionStatement",
    queries,
    all,
  };
}

// SQL generation extensions

export function generateCTE(cte: CTE): string {
  const parts: string[] = [];

  parts.push(cte.name);

  if (cte.columns && cte.columns.length > 0) {
    parts.push(` (${cte.columns.join(", ")})`);
  }

  parts.push(" AS (" + generateSQL(cte.query) + ")");

  return parts.join("");
}

export function generateWithClause(withClause: WithClause): string {
  let sql = "WITH ";

  if (withClause.recursive) {
    sql += "RECURSIVE ";
  }

  sql += withClause.ctes.map(generateCTE).join(", ");

  return sql;
}

export function generateWindowFunction(window: WindowFunction): string {
  const outerParts: string[] = [];

  outerParts.push(window.function + "(");

  if (window.args.length > 0) {
    outerParts.push(window.args.map(generateExpression).join(", "));
  }

  outerParts.push(") OVER (");

  const spec = window.over;
  const specParts: string[] = [];

  if (spec.partitionBy && spec.partitionBy.length > 0) {
    specParts.push(
      "PARTITION BY " + spec.partitionBy.map(generateExpression).join(", "),
    );
  }

  if (spec.orderBy && spec.orderBy.length > 0) {
    specParts.push(
      "ORDER BY " + spec.orderBy.map(generateOrderItem).join(", "),
    );
  }

  if (spec.frame) {
    specParts.push(generateWindowFrame(spec.frame));
  }

  outerParts.push(specParts.join(" "));
  outerParts.push(")");

  return outerParts.join("");
}

export function generateWindowFrame(frame: WindowFrame): string {
  const parts: string[] = [];

  parts.push(frame.mode + " ");
  parts.push(generateFrameBound(frame.start));

  if (frame.end) {
    parts.push(" AND " + generateFrameBound(frame.end));
  }

  if (frame.exclude) {
    parts.push(" EXCLUDE " + frame.exclude);
  }

  return parts.join("");
}

export function generateFrameBound(bound: FrameBound): string {
  if (typeof bound === "string") {
    return bound;
  }

  return `${bound.offset} ${bound.direction}`;
}

export function generateLateralJoin(lateral: LateralJoin): string {
  const parts: string[] = [];

  parts.push("LATERAL (" + generateSQL(lateral.subquery) + ")");

  if (lateral.alias) {
    parts.push(" AS " + lateral.alias);
  }

  return parts.join("");
}

export function generateAggregateWithFilter(agg: AggregateWithFilter): string {
  const parts: string[] = [];

  parts.push(agg.function + "(");

  if (agg.distinct) {
    parts.push("DISTINCT ");
  }

  if (agg.args.length > 0) {
    parts.push(agg.args.map(generateExpression).join(", "));
  }

  if (agg.orderBy && agg.orderBy.length > 0) {
    parts.push(" ORDER BY " + agg.orderBy.map(generateOrderItem).join(", "));
  }

  parts.push(")");

  if (agg.filter) {
    parts.push(" FILTER (WHERE " + generateExpression(agg.filter) + ")");
  }

  return parts.join("");
}

export function generateUnion(union: UnionStatement): string {
  const keyword = union.all ? "UNION ALL" : "UNION";
  return union.queries.map(generateSQL).join(` ${keyword} `);
}

export function generateOrderItem(item: OrderItem): string {
  const parts: string[] = [];

  parts.push(generateExpression(item.expression));
  parts.push(" " + item.direction);

  if (item.nulls) {
    parts.push(" NULLS " + item.nulls);
  }

  return parts.join("");
}

// Placeholder functions to be integrated with main SQL module
function generateSQL(statement: SQL.SQLStatement): string {
  // This would call the main SQL generation function
  return statement.toSQL ? statement.toSQL() : JSON.stringify(statement);
}

function generateExpression(expr: SQL.SQLExpression): string {
  // This would call the main expression generation function
  return JSON.stringify(expr);
}

// Builder helper functions

export function select(options: any): SQL.SQLStatement {
  return {
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: options.selections || [],
    },
    from: options.from,
    where: options.where,
    groupBy: options.groupBy,
    having: options.having,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
  };
}

export function innerJoin(options: any): SQL.SQLStatement {
  return {
    kind: "JoinClause",
    type: "INNER",
    table: options.right,
    on: options.on,
  } as any;
}

export function leftJoin(options: any): SQL.SQLStatement {
  return {
    kind: "JoinClause",
    type: "LEFT",
    table: options.right,
    on: options.on,
    where: options.where,
  } as any;
}

export function eq(left: any, right: any): SQL.SQLExpression {
  return {
    kind: "BinaryExpression",
    operator: "=",
    left,
    right,
  } as any;
}

export function isNotNull(expr: any): SQL.SQLExpression {
  return {
    kind: "UnaryExpression",
    operator: "IS NOT NULL",
    operand: expr,
  } as any;
}

export function star(): SQL.SQLExpression {
  return {
    kind: "Star",
  } as any;
}

export function aggregate(
  func: string,
  expr: SQL.SQLExpression,
): SQL.SQLStatement {
  return {
    kind: "FunctionCall",
    name: func,
    args: [expr],
  } as any;
}

export function distinct(expr: SQL.SQLStatement): SQL.SQLStatement {
  return {
    ...expr,
    distinct: true,
  } as any;
}
