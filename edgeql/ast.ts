/**
 * EdgeQL Abstract Syntax Tree (AST) node definitions
 */

import { Span } from "../lib/types.ts";

// Base AST node interface
export interface EdgeQLNode {
  kind: string;
  span?: Span;
}

// Top-level query types
export type Query =
  | SelectQuery
  | InsertQuery
  | UpdateQuery
  | DeleteQuery
  | ForQuery
  | WithBlock
  | GroupQuery
  | DescribeTypeQuery
  | DescribeSchemaQuery
  | SetGlobalQuery
  | ExplainQuery
  | ConfigureQuery;

// SELECT query
export interface SelectQuery extends EdgeQLNode {
  kind: "SelectQuery";
  distinct?: boolean;
  expr: Expression;
  shape?: Shape;
  filter?: Expression;
  orderBy?: OrderByClause[];
  offset?: Expression;
  limit?: Expression;
}

// INSERT query
export interface InsertQuery extends EdgeQLNode {
  kind: "InsertQuery";
  type: TypeName;
  shape: Shape;
  unless?: ConflictClause;
}

// UPDATE query
export interface UpdateQuery extends EdgeQLNode {
  kind: "UpdateQuery";
  type: TypeName;
  filter?: Expression;
  shape: Shape;
}

// DELETE query
export interface DeleteQuery extends EdgeQLNode {
  kind: "DeleteQuery";
  type: TypeName;
  filter?: Expression;
  orderBy?: OrderByClause[];
  limit?: Expression;
}

// FOR query
export interface ForQuery extends EdgeQLNode {
  kind: "ForQuery";
  variable: Identifier;
  iterator: Expression;
  body: Query;
}

// WITH block
export interface WithBlock extends EdgeQLNode {
  kind: "WithBlock";
  module?: string;
  bindings: WithBinding[];
  body: Query;
}

export interface WithBinding extends EdgeQLNode {
  kind: "WithBinding";
  name: Identifier;
  value: Expression;
  recursive?: boolean;
}

// GROUP query
export interface GroupQuery extends EdgeQLNode {
  kind: "GroupQuery";
  expr: Expression;
  using: WithBinding[];
  by: GroupByClause;
  filter?: Expression;
}

export interface GroupByClause extends EdgeQLNode {
  kind: "GroupByClause";
  elements: Expression[];
}

// DESCRIBE TYPE <typeName>
export interface DescribeTypeQuery extends EdgeQLNode {
  kind: "DescribeType";
  typeName: string;
}

// DESCRIBE SCHEMA
export interface DescribeSchemaQuery extends EdgeQLNode {
  kind: "DescribeSchema";
}

// SET GLOBAL query
export interface SetGlobalQuery extends EdgeQLNode {
  kind: "SetGlobalQuery";
  name: string;
  module?: string;
  value: Expression;
}

// EXPLAIN query
export interface ExplainQuery extends EdgeQLNode {
  kind: "ExplainQuery";
  query: Query;
  analyze?: boolean;
  buffers?: boolean;
  format?: "JSON" | "TEXT" | "YAML" | "XML";
}

// CONFIGURE query
export type ConfigureScope = "SESSION" | "DATABASE" | "INSTANCE" | "SYSTEM";
export type ConfigureAction = "SET" | "RESET";

export interface ConfigureQuery extends EdgeQLNode {
  kind: "ConfigureQuery";
  scope: ConfigureScope;
  action: ConfigureAction;
  key: string;
  value?: Expression;
}

// Clauses
export interface OrderByClause extends EdgeQLNode {
  kind: "OrderByClause";
  expr: Expression;
  direction?: "ASC" | "DESC";
  emptyOrder?: "EMPTY FIRST" | "EMPTY LAST";
}

export interface ConflictClause extends EdgeQLNode {
  kind: "ConflictClause";
  on: Expression;
  else?: Query | Expression;
}

// Shape expression
export interface Shape extends EdgeQLNode {
  kind: "Shape";
  elements: ShapeElement[];
}

export interface ShapeElement extends EdgeQLNode {
  kind: "ShapeElement";
  expr: Expression;
  name?: Identifier;
  computable?: boolean;
  cardinality?: Cardinality;
  shape?: Shape;
  /** Type filter for polymorphic shape fields: [IS Type].property */
  typeFilter?: string;
  /**
   * Splat marker for `{ * }` — expand to all scalar properties of the
   * containing type at compile time. The `expr` field is a placeholder
   * (an Identifier with name "*"); consumers should branch on `splat`
   * before reading `expr`.
   */
  splat?: boolean;
}

export interface Cardinality extends EdgeQLNode {
  kind: "Cardinality";
  required?: boolean;
  multi?: boolean;
}

// Expressions
export type Expression =
  | Literal
  | Parameter
  | Identifier
  | Path
  | TypeCast
  | FunctionCall
  | WindowFunctionCall
  | BinaryOp
  | UnaryOp
  | IfElse
  | CaseExpression
  | SetExpr
  | ArrayExpr
  | TupleExpr
  | NamedTuple
  | TupleAccessExpr
  | Introspection
  | Detached
  | GlobalRef
  | TypeName
  | Subquery
  | ShapeExpr
  | IndexExpression
  | SliceExpression;

// Literals
export interface Literal extends EdgeQLNode {
  kind: "Literal";
  type: "string" | "integer" | "float" | "boolean" | "bytes" | "uuid" | "empty";
  value: string | number | boolean | null;
}

// Parameter
export interface Parameter extends EdgeQLNode {
  kind: "Parameter";
  name: string;
  type?: TypeName;
}

// Identifier
export interface Identifier extends EdgeQLNode {
  kind: "Identifier";
  name: string;
  quoted?: boolean;
}

// Path expression
export interface Path extends EdgeQLNode {
  kind: "Path";
  steps: PathStep[];
}

export interface PathStep extends EdgeQLNode {
  kind: "PathStep";
  type: "property" | "link" | "backlink" | "type_intersection";
  name: string;
  optional?: boolean;
  filter?: Expression;
  linkProps?: string; // @prop_name
}

// Type cast
export interface TypeCast extends EdgeQLNode {
  kind: "TypeCast";
  type: TypeName;
  expr: Expression;
  cardinality?: Cardinality;
}

// Function call
export interface FunctionCall extends EdgeQLNode {
  kind: "FunctionCall";
  name: QualifiedName;
  args: FunctionArg[];
}

export interface FunctionArg extends EdgeQLNode {
  kind: "FunctionArg";
  name?: string;
  value: Expression;
}

// Binary operation
export interface BinaryOp extends EdgeQLNode {
  kind: "BinaryOp";
  op: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "//"
  | "%"
  | "**"
  | "++"
  | "??"
  | "="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "?="
  | "?!="
  | "AND"
  | "OR"
  | "LIKE"
  | "ILIKE"
  | "IN"
  | "NOT IN"
  | "IS"
  | "IS NOT"
  | "UNION"
  | "INTERSECT"
  | "EXCEPT"
  | "@>"
  | "<@"
  | "&&"
  | "-|-"
  | "&"
  | "|"
  | "^"
  | "<<"
  | ">>"
  | "~"
  | "!~"
  | "~*"
  | "!~*";

// Unary operation
export interface UnaryOp extends EdgeQLNode {
  kind: "UnaryOp";
  op: UnaryOperator;
  operand: Expression;
}

export type UnaryOperator =
  | "+"
  | "-"
  | "NOT"
  | "DISTINCT"
  | "EXISTS"
  | "DETACHED"
  | "~";

// Conditional
export interface IfElse extends EdgeQLNode {
  kind: "IfElse";
  condition: Expression;
  then: Expression;
  else: Expression;
}

/**
 * Multi-branch CASE expression (P1-05). `case when c1 then v1 when c2 then v2
 * ... else v end`. Searched form only — simple `case subject when ...` is not
 * yet supported (fold via equality comparisons in each when-clause).
 */
export interface CaseExpression extends EdgeQLNode {
  kind: "CaseExpression";
  whenClauses: Array<{ condition: Expression; result: Expression; }>;
  elseResult?: Expression;
}

// Set expression
export interface SetExpr extends EdgeQLNode {
  kind: "SetExpr";
  elements: Expression[];
}

// Array expression
export interface ArrayExpr extends EdgeQLNode {
  kind: "ArrayExpr";
  elements: Expression[];
}

// Tuple expression
export interface TupleExpr extends EdgeQLNode {
  kind: "TupleExpr";
  elements: Expression[];
}

// Named tuple
export interface NamedTuple extends EdgeQLNode {
  kind: "NamedTuple";
  elements: NamedTupleElement[];
}

export interface NamedTupleElement extends EdgeQLNode {
  kind: "NamedTupleElement";
  name: string;
  value: Expression;
}

// Tuple element access (numeric index or named field)
export interface TupleAccessExpr extends EdgeQLNode {
  kind: "TupleAccessExpr";
  tuple: Expression;
  accessType: "index" | "name";
  index?: number;
  fieldName?: string;
}

// Index expression: expr[n]
export interface IndexExpression extends EdgeQLNode {
  kind: "IndexExpression";
  expr: Expression;
  index: Expression;
}

// Slice expression: expr[a:b]
export interface SliceExpression extends EdgeQLNode {
  kind: "SliceExpression";
  expr: Expression;
  start?: Expression;
  end?: Expression;
}

// Introspection
export interface Introspection extends EdgeQLNode {
  kind: "Introspection";
  type: TypeName;
}

// Detached expression
export interface Detached extends EdgeQLNode {
  kind: "Detached";
  expr: Expression;
}

// Global reference
export interface GlobalRef extends EdgeQLNode {
  kind: "GlobalRef";
  name: string;
  module?: string;
}

// Shape as expression
export interface ShapeExpr extends EdgeQLNode {
  kind: "ShapeExpr";
  expr: Expression;
  shape: Shape;
}

// Subquery
export interface Subquery extends EdgeQLNode {
  kind: "Subquery";
  query: Query;
}

// Type name
export interface TypeName extends EdgeQLNode {
  kind: "TypeName";
  name: QualifiedName;
  subtypes?: TypeName[];
}

// Qualified name
export interface QualifiedName extends EdgeQLNode {
  kind: "QualifiedName";
  parts: string[];
}

// Window function call
export interface WindowFunctionCall extends EdgeQLNode {
  kind: "WindowFunctionCall";
  name: QualifiedName;
  args: FunctionArg[];
  over: WindowOverClause;
}

export interface WindowOverClause extends EdgeQLNode {
  kind: "WindowOverClause";
  partitionBy?: Expression[];
  orderBy?: OrderByClause[];
  frame?: WindowFrameClause;
}

export interface WindowFrameClause extends EdgeQLNode {
  kind: "WindowFrameClause";
  mode: "ROWS" | "RANGE" | "GROUPS";
  start: FrameBound;
  end?: FrameBound;
  exclude?: "CURRENT ROW" | "GROUP" | "TIES" | "NO OTHERS";
}

export interface FrameBound extends EdgeQLNode {
  kind: "FrameBound";
  type: "UNBOUNDED PRECEDING" | "CURRENT ROW" | "UNBOUNDED FOLLOWING" | string;
  offset?: Expression;
}

// Helper functions for creating AST nodes
export function createIdentifier(name: string, quoted = false): Identifier {
  return { kind: "Identifier", name, quoted };
}

export function createQualifiedName(parts: string[]): QualifiedName {
  return { kind: "QualifiedName", parts };
}

export function createTypeName(parts: string[]): TypeName {
  return { kind: "TypeName", name: createQualifiedName(parts) };
}

export function createLiteral(
  type: Literal["type"],
  value: string | number | boolean | null
): Literal {
  return { kind: "Literal", type, value };
}

export function createPath(steps: PathStep[]): Path {
  return { kind: "Path", steps };
}

export function createBinaryOp(
  op: BinaryOperator,
  left: Expression,
  right: Expression
): BinaryOp {
  return { kind: "BinaryOp", op, left, right };
}

export function createUnaryOp(
  op: UnaryOperator,
  operand: Expression
): UnaryOp {
  return { kind: "UnaryOp", op, operand };
}

export function createParameter(name: string, type?: TypeName): Parameter {
  return { kind: "Parameter", name, type };
}

export function createFunctionCall(
  name: QualifiedName,
  args: FunctionArg[]
): FunctionCall {
  return { kind: "FunctionCall", name, args };
}

export function createShape(elements: ShapeElement[]): Shape {
  return { kind: "Shape", elements };
}

export function createShapeElement(
  expr: Expression,
  options?: {
    name?: Identifier;
    computable?: boolean;
    cardinality?: Cardinality;
    shape?: Shape;
  }
): ShapeElement {
  return {
    kind: "ShapeElement",
    expr,
    ...options
  };
}

export function createIndexExpression(
  expr: Expression,
  index: Expression
): IndexExpression {
  return { kind: "IndexExpression", expr, index };
}

export function createSliceExpression(
  expr: Expression,
  start?: Expression,
  end?: Expression
): SliceExpression {
  return { kind: "SliceExpression", expr, start, end };
}

export function createGlobalRef(name: string, module?: string): GlobalRef {
  return { kind: "GlobalRef", name, module };
}

export function createSetGlobalQuery(
  name: string,
  value: Expression,
  module?: string
): SetGlobalQuery {
  return { kind: "SetGlobalQuery", name, module, value };
}
