/**
 * SQL AST types for PostgreSQL code generation
 */

export interface SQLNode {
  kind: string;
}

export type SQLStatement = SelectStatement | InsertStatement | UpdateStatement | DeleteStatement;

export interface SelectStatement extends SQLNode {
  kind: "SelectStatement";
  select: SelectClause;
  from?: FromClause;
  where?: WhereClause;
  groupBy?: GroupByClause;
  having?: HavingClause;
  orderBy?: OrderByClause;
  limit?: LimitClause;
  offset?: OffsetClause;
}

export interface SelectClause extends SQLNode {
  kind: "SelectClause";
  distinct?: boolean;
  columns: SelectItem[];
}

export interface SelectItem extends SQLNode {
  kind: "SelectItem";
  expression: SQLExpression;
  alias?: string;
}

export interface FromClause extends SQLNode {
  kind: "FromClause";
  tables: TableReference[];
}

export interface TableReference extends SQLNode {
  kind: "TableReference";
  name: string;
  alias?: string;
  joins?: JoinClause[];
}

export interface JoinClause extends SQLNode {
  kind: "JoinClause";
  type: "INNER" | "LEFT" | "RIGHT" | "FULL";
  table: TableReference;
  condition: SQLExpression;
}

export interface WhereClause extends SQLNode {
  kind: "WhereClause";
  condition: SQLExpression;
}

export interface GroupByClause extends SQLNode {
  kind: "GroupByClause";
  expressions: SQLExpression[];
}

export interface HavingClause extends SQLNode {
  kind: "HavingClause";
  condition: SQLExpression;
}

export interface OrderByClause extends SQLNode {
  kind: "OrderByClause";
  items: OrderByItem[];
}

export interface OrderByItem extends SQLNode {
  kind: "OrderByItem";
  expression: SQLExpression;
  direction: "ASC" | "DESC";
}

export interface LimitClause extends SQLNode {
  kind: "LimitClause";
  count: SQLExpression;
}

export interface OffsetClause extends SQLNode {
  kind: "OffsetClause";
  count: SQLExpression;
}

export interface InsertStatement extends SQLNode {
  kind: "InsertStatement";
  table: string;
  columns: string[];
  values: SQLExpression[][];
  returning?: SelectItem[];
  onConflict?: OnConflictClause;
}

export interface OnConflictClause extends SQLNode {
  kind: "OnConflictClause";
  target?: string[];
  action: "DO NOTHING" | UpdateAction;
}

export interface UpdateAction extends SQLNode {
  kind: "UpdateAction";
  set: SetClause[];
}

export interface SetClause extends SQLNode {
  kind: "SetClause";
  column: string;
  value: SQLExpression;
}

export interface UpdateStatement extends SQLNode {
  kind: "UpdateStatement";
  table: string;
  set: SetClause[];
  where?: WhereClause;
  returning?: SelectItem[];
}

export interface DeleteStatement extends SQLNode {
  kind: "DeleteStatement";
  table: string;
  where?: WhereClause;
  returning?: SelectItem[];
}

// Base interface for SQL expressions
export interface SQLExpressionBase extends SQLNode {
  kind: string;
}

// Parameter reference for prepared statements
export interface ParameterReference extends SQLExpressionBase {
  kind: "ParameterReference";
  index: number;
}

// Raw SQL expression for complex access control conditions
export interface RawSQLExpression extends SQLExpressionBase {
  kind: "RawSQLExpression";
  sql: string;
}

// Discriminated union of all SQL expression types
export type SQLExpression = 
  | ColumnReference
  | LiteralExpression
  | BinaryExpression
  | UnaryExpression
  | FunctionCall
  | SubqueryExpression
  | CaseExpression
  | JsonBuildObject
  | JsonAgg
  | ParameterReference
  | RawSQLExpression;

export interface ColumnReference extends SQLExpressionBase {
  kind: "ColumnReference";
  table?: string;
  column: string;
}

export interface LiteralExpression extends SQLExpressionBase {
  kind: "LiteralExpression";
  type: "string" | "number" | "boolean" | "null";
  value: any;
}

export interface BinaryExpression extends SQLExpressionBase {
  kind: "BinaryExpression";
  operator: string;
  left: SQLExpression;
  right: SQLExpression;
}

export interface UnaryExpression extends SQLExpressionBase {
  kind: "UnaryExpression";
  operator: string;
  operand: SQLExpression;
}

export interface FunctionCall extends SQLExpressionBase {
  kind: "FunctionCall";
  name: string;
  args: SQLExpression[];
}

export interface SubqueryExpression extends SQLExpressionBase {
  kind: "SubqueryExpression";
  query: SelectStatement;
}

export interface CaseExpression extends SQLExpressionBase {
  kind: "CaseExpression";
  when: WhenClause[];
  else?: SQLExpression;
}

export interface WhenClause extends SQLNode {
  kind: "WhenClause";
  condition: SQLExpression;
  then: SQLExpression;
}

export interface JsonBuildObject extends SQLExpressionBase {
  kind: "JsonBuildObject";
  fields: JsonField[];
}

export interface JsonField extends SQLNode {
  kind: "JsonField";
  key: string;
  value: SQLExpression;
}

export interface JsonAgg extends SQLExpressionBase {
  kind: "JsonAgg";
  expression: SQLExpression;
}

// SQL Builder functions
export function createSelectStatement(options: {
  select: SelectClause;
  from?: FromClause;
  where?: WhereClause;
  groupBy?: GroupByClause;
  having?: HavingClause;
  orderBy?: OrderByClause;
  limit?: LimitClause;
  offset?: OffsetClause;
}): SelectStatement {
  return {
    kind: "SelectStatement",
    ...options,
  };
}

export function createSelectClause(columns: SelectItem[], distinct?: boolean): SelectClause {
  return {
    kind: "SelectClause",
    columns,
    distinct,
  };
}

export function createSelectItem(expression: SQLExpression, alias?: string): SelectItem {
  return {
    kind: "SelectItem",
    expression,
    alias,
  };
}

export function createFromClause(tables: TableReference[]): FromClause {
  return {
    kind: "FromClause",
    tables,
  };
}

export function createTableReference(name: string, alias?: string): TableReference {
  return {
    kind: "TableReference",
    name,
    alias,
  };
}

export function createWhereClause(condition: SQLExpression): WhereClause {
  return {
    kind: "WhereClause",
    condition,
  };
}

export function createColumnReference(column: string, table?: string): ColumnReference {
  return {
    kind: "ColumnReference",
    column,
    table,
  };
}

export function createLiteral(type: "string" | "number" | "boolean" | "null", value: any): LiteralExpression {
  return {
    kind: "LiteralExpression",
    type,
    value,
  };
}

export function createBinaryExpression(operator: string, left: SQLExpression, right: SQLExpression): BinaryExpression {
  return {
    kind: "BinaryExpression",
    operator,
    left,
    right,
  };
}

export function createFunctionCall(name: string, args: SQLExpression[]): FunctionCall {
  return {
    kind: "FunctionCall",
    name,
    args,
  };
}

export function createJsonBuildObject(fields: JsonField[]): JsonBuildObject {
  return {
    kind: "JsonBuildObject",
    fields,
  };
}

export function createJsonField(key: string, value: SQLExpression): JsonField {
  return {
    kind: "JsonField",
    key,
    value,
  };
}

export function createJsonAgg(expression: SQLExpression): JsonAgg {
  return {
    kind: "JsonAgg",
    expression,
  };
}

export function createParameterReference(index: number): ParameterReference {
  return {
    kind: "ParameterReference",
    index,
  };
}

export function createSubqueryExpression(query: SelectStatement): SubqueryExpression {
  return {
    kind: "SubqueryExpression",
    query,
  };
}

export function createCaseExpression(when: WhenClause[], elseExpr?: SQLExpression): CaseExpression {
  return {
    kind: "CaseExpression",
    when,
    else: elseExpr,
  };
}

export function createWhenClause(condition: SQLExpression, then: SQLExpression): WhenClause {
  return {
    kind: "WhenClause",
    condition,
    then,
  };
}