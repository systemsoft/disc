/**
 * SQL AST types for PostgreSQL code generation
 */

export interface SQLNode {
  kind: string;
}

export interface SQLStatement extends SQLNode {
  kind: "SQLStatement";
}

export interface SelectStatement extends SQLStatement {
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

export interface InsertStatement extends SQLStatement {
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

export interface UpdateStatement extends SQLStatement {
  kind: "UpdateStatement";
  table: string;
  set: SetClause[];
  where?: WhereClause;
  returning?: SelectItem[];
}

export interface DeleteStatement extends SQLStatement {
  kind: "DeleteStatement";
  table: string;
  where?: WhereClause;
  returning?: SelectItem[];
}

export interface SQLExpression extends SQLNode {
  kind: string;
}

export interface ColumnReference extends SQLExpression {
  kind: "ColumnReference";
  table?: string;
  column: string;
}

export interface LiteralExpression extends SQLExpression {
  kind: "LiteralExpression";
  type: "string" | "number" | "boolean" | "null";
  value: any;
}

export interface BinaryExpression extends SQLExpression {
  kind: "BinaryExpression";
  operator: string;
  left: SQLExpression;
  right: SQLExpression;
}

export interface UnaryExpression extends SQLExpression {
  kind: "UnaryExpression";
  operator: string;
  operand: SQLExpression;
}

export interface FunctionCall extends SQLExpression {
  kind: "FunctionCall";
  name: string;
  args: SQLExpression[];
}

export interface SubqueryExpression extends SQLExpression {
  kind: "SubqueryExpression";
  query: SelectStatement;
}

export interface CaseExpression extends SQLExpression {
  kind: "CaseExpression";
  when: WhenClause[];
  else?: SQLExpression;
}

export interface WhenClause extends SQLNode {
  kind: "WhenClause";
  condition: SQLExpression;
  then: SQLExpression;
}

export interface JsonBuildObject extends SQLExpression {
  kind: "JsonBuildObject";
  fields: JsonField[];
}

export interface JsonField extends SQLNode {
  kind: "JsonField";
  key: string;
  value: SQLExpression;
}

export interface JsonAgg extends SQLExpression {
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