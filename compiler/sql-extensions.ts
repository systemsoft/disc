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

export function withCTEs(ctes: CTE[], statement: SQL.SQLStatement): SQL.SQLStatement {
  return {
    ...statement,
    with: {
      kind: "WithClause",
      recursive: ctes.some(cte => cte.recursive),
      ctes
    }
  } as any;
}

export function windowFunction(
  func: string, 
  args: SQL.SQLExpression[], 
  spec: WindowSpec
): WindowFunction {
  return {
    kind: "WindowFunction",
    function: func,
    args,
    over: spec
  };
}

export function lateral(subquery: SQL.SQLStatement, alias?: string): LateralJoin {
  return {
    kind: "LateralJoin",
    subquery,
    alias
  };
}

export function aggregateWithFilter(
  func: string,
  args: SQL.SQLExpression[],
  filter?: SQL.SQLExpression,
  distinct?: boolean
): AggregateWithFilter {
  return {
    kind: "AggregateWithFilter",
    function: func,
    args,
    filter,
    distinct
  };
}

export function union(queries: SQL.SQLStatement[], all = false): UnionStatement {
  return {
    kind: "UnionStatement",
    queries,
    all
  };
}

// SQL generation extensions

export function generateCTE(cte: CTE): string {
  let sql = cte.name;
  
  if (cte.columns && cte.columns.length > 0) {
    sql += ` (${cte.columns.join(", ")})`;
  }
  
  sql += " AS (" + generateSQL(cte.query) + ")";
  
  return sql;
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
  let sql = window.function + "(";
  
  if (window.args.length > 0) {
    sql += window.args.map(generateExpression).join(", ");
  }
  
  sql += ") OVER (";
  
  const spec = window.over;
  const parts: string[] = [];
  
  if (spec.partitionBy && spec.partitionBy.length > 0) {
    parts.push("PARTITION BY " + spec.partitionBy.map(generateExpression).join(", "));
  }
  
  if (spec.orderBy && spec.orderBy.length > 0) {
    parts.push("ORDER BY " + spec.orderBy.map(generateOrderItem).join(", "));
  }
  
  if (spec.frame) {
    parts.push(generateWindowFrame(spec.frame));
  }
  
  sql += parts.join(" ");
  sql += ")";
  
  return sql;
}

export function generateWindowFrame(frame: WindowFrame): string {
  let sql = frame.mode + " ";
  
  sql += generateFrameBound(frame.start);
  
  if (frame.end) {
    sql += " AND " + generateFrameBound(frame.end);
  }
  
  if (frame.exclude) {
    sql += " EXCLUDE " + frame.exclude;
  }
  
  return sql;
}

export function generateFrameBound(bound: FrameBound): string {
  if (typeof bound === "string") {
    return bound;
  }
  
  return `${bound.offset} ${bound.direction}`;
}

export function generateLateralJoin(lateral: LateralJoin): string {
  let sql = "LATERAL (" + generateSQL(lateral.subquery) + ")";
  
  if (lateral.alias) {
    sql += " AS " + lateral.alias;
  }
  
  return sql;
}

export function generateAggregateWithFilter(agg: AggregateWithFilter): string {
  let sql = agg.function + "(";
  
  if (agg.distinct) {
    sql += "DISTINCT ";
  }
  
  if (agg.args.length > 0) {
    sql += agg.args.map(generateExpression).join(", ");
  }
  
  if (agg.orderBy && agg.orderBy.length > 0) {
    sql += " ORDER BY " + agg.orderBy.map(generateOrderItem).join(", ");
  }
  
  sql += ")";
  
  if (agg.filter) {
    sql += " FILTER (WHERE " + generateExpression(agg.filter) + ")";
  }
  
  return sql;
}

export function generateUnion(union: UnionStatement): string {
  const keyword = union.all ? "UNION ALL" : "UNION";
  return union.queries.map(generateSQL).join(` ${keyword} `);
}

export function generateOrderItem(item: OrderItem): string {
  let sql = generateExpression(item.expression);
  
  sql += " " + item.direction;
  
  if (item.nulls) {
    sql += " NULLS " + item.nulls;
  }
  
  return sql;
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
      columns: options.selections || []
    },
    from: options.from,
    where: options.where,
    groupBy: options.groupBy,
    having: options.having,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset
  };
}

export function innerJoin(options: any): SQL.SQLStatement {
  return {
    kind: "JoinClause",
    type: "INNER",
    table: options.right,
    on: options.on
  } as any;
}

export function leftJoin(options: any): SQL.SQLStatement {
  return {
    kind: "JoinClause",
    type: "LEFT",
    table: options.right,
    on: options.on,
    where: options.where
  } as any;
}

export function eq(left: any, right: any): SQL.SQLExpression {
  return {
    kind: "BinaryExpression",
    operator: "=",
    left,
    right
  } as any;
}

export function isNotNull(expr: any): SQL.SQLExpression {
  return {
    kind: "UnaryExpression",
    operator: "IS NOT NULL",
    operand: expr
  } as any;
}

export function star(): SQL.SQLExpression {
  return {
    kind: "Star"
  } as any;
}

export function aggregate(func: string, expr: SQL.SQLExpression): SQL.SQLStatement {
  return {
    kind: "FunctionCall",
    name: func,
    args: [expr]
  } as any;
}

export function distinct(expr: SQL.SQLStatement): SQL.SQLStatement {
  return {
    ...expr,
    distinct: true
  } as any;
}