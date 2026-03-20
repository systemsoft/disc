/**
 * SDL Abstract Syntax Tree (AST) node definitions
 */

import { Span } from "../lib/types.ts";

// Base AST node interface
export interface SDLNode {
  kind: string;
  span?: Span;
}

// Document root
export interface SDLDocument extends SDLNode {
  kind: "SDLDocument";
  declarations: Declaration[];
}

// Top-level declarations
export type Declaration =
  | ModuleDeclaration
  | TypeDeclaration
  | ScalarTypeDeclaration
  | AliasDeclaration
  | FunctionDeclaration
  | GlobalDeclaration
  | AnnotationDeclaration;

// Module declaration
export interface ModuleDeclaration extends SDLNode {
  kind: "ModuleDeclaration";
  name: QualifiedName;
  declarations: Declaration[];
}

// Type declaration
export interface TypeDeclaration extends SDLNode {
  kind: "TypeDeclaration";
  abstract?: boolean;
  name: Identifier;
  extending?: TypeRef[];
  members: TypeMember[];
}

// Scalar type declaration
export interface ScalarTypeDeclaration extends SDLNode {
  kind: "ScalarTypeDeclaration";
  abstract?: boolean;
  name: Identifier;
  extending?: TypeRef[];
  constraints?: Constraint[];
  annotations?: Annotation[];
}

// Alias declaration
export interface AliasDeclaration extends SDLNode {
  kind: "AliasDeclaration";
  name: Identifier;
  using: Expression;
}

// Function declaration
export interface FunctionDeclaration extends SDLNode {
  kind: "FunctionDeclaration";
  name: Identifier;
  parameters: FunctionParameter[];
  returnType: TypeRef;
  using?: Expression;
  volatility?: "stable" | "volatile" | "immutable";
  overloaded?: boolean;
}

// Global declaration
export interface GlobalDeclaration extends SDLNode {
  kind: "GlobalDeclaration";
  name: Identifier;
  type: TypeRef;
  required?: boolean;
  multi?: boolean;
  default?: Expression;
  readonly?: boolean;
}

// Annotation declaration
export interface AnnotationDeclaration extends SDLNode {
  kind: "AnnotationDeclaration";
  abstract?: boolean;
  name: Identifier;
  type?: TypeRef;
}

// Trigger types
export type TriggerTiming = "before" | "after";
export type TriggerEvent = "insert" | "update" | "delete";
export type TriggerScope = "each" | "all";

export interface TriggerDeclaration extends SDLNode {
  kind: "TriggerDeclaration";
  name: Identifier;
  timing: TriggerTiming;
  events: TriggerEvent[];
  scope: TriggerScope;
  body: Expression;
}

// Rewrite types
export type RewriteEvent = "insert" | "update";

export interface RewriteDeclaration extends SDLNode {
  kind: "RewriteDeclaration";
  events: RewriteEvent[];
  using: string;
}

// Type members
export type TypeMember =
  | PropertyDeclaration
  | LinkDeclaration
  | Constraint
  | Index
  | Annotation
  | AccessPolicy
  | TriggerDeclaration;

// Property declaration
export interface PropertyDeclaration extends SDLNode {
  kind: "PropertyDeclaration";
  name: Identifier;
  type: TypeRef;
  required?: boolean;
  multi?: boolean;
  abstract?: boolean;
  overloaded?: boolean;
  readonly?: boolean;
  computed?: Expression;
  default?: Expression;
  constraints?: Constraint[];
  annotations?: Annotation[];
  rewrites?: RewriteDeclaration[];
}

// Link declaration
export interface LinkDeclaration extends SDLNode {
  kind: "LinkDeclaration";
  name: Identifier;
  target: TypeRef;
  required?: boolean;
  multi?: boolean;
  abstract?: boolean;
  overloaded?: boolean;
  readonly?: boolean;
  computed?: Expression;
  default?: Expression;
  properties?: PropertyDeclaration[];
  constraints?: Constraint[];
  annotations?: Annotation[];
  onTargetDelete?: "restrict" | "cascade" | "allow" | "deferred restrict";
}

// Constraint
export interface Constraint extends SDLNode {
  kind: "Constraint";
  name?: Identifier;
  delegated?: boolean;
  on?: Expression;
  args?: Expression[];
  annotations?: Annotation[];
  errmessage?: string;
}

// Index
export interface Index extends SDLNode {
  kind: "Index";
  name?: Identifier;
  on: Expression;
  annotations?: Annotation[];
}

// Annotation
export interface Annotation extends SDLNode {
  kind: "Annotation";
  name: QualifiedName;
  value?: Expression;
}

// Access Policy
export interface AccessPolicy extends SDLNode {
  kind: "AccessPolicy";
  name: Identifier;
  actions: AccessAction[];
  condition?: Expression;
  annotations?: Annotation[];
}

export interface AccessAction extends SDLNode {
  kind: "AccessAction";
  allow: boolean;
  operations: AccessOperation[];
}

export type AccessOperation = "select" | "insert" | "update" | "delete" | "all";

// Function parameter
export interface FunctionParameter extends SDLNode {
  kind: "FunctionParameter";
  name: Identifier;
  type: TypeRef;
  typemod?: "optional" | "setof" | "singleton";
  default?: Expression;
}

// Type references
export interface TypeRef extends SDLNode {
  kind: "TypeRef";
  name: QualifiedName;
  array?: boolean;
  optional?: boolean;
  params?: TypeRef[];
}

// Names
export interface Identifier extends SDLNode {
  kind: "Identifier";
  value: string;
  quoted?: boolean; // For backtick identifiers
}

export interface QualifiedName extends SDLNode {
  kind: "QualifiedName";
  parts: string[];
}

// Expressions (simplified for SDL context)
export type Expression =
  | Literal
  | PathExpression
  | BinaryOp
  | UnaryOp
  | FunctionCall
  | TypeCast
  | Parameter
  | ConditionalExpression;

export interface Literal extends SDLNode {
  kind: "Literal";
  type: "string" | "integer" | "float" | "boolean";
  value: string | number | boolean;
}

export interface PathExpression extends SDLNode {
  kind: "PathExpression";
  path: string[];
}

export interface BinaryOp extends SDLNode {
  kind: "BinaryOp";
  op: string;
  left: Expression;
  right: Expression;
}

export interface UnaryOp extends SDLNode {
  kind: "UnaryOp";
  op: string;
  operand: Expression;
}

export interface FunctionCall extends SDLNode {
  kind: "FunctionCall";
  name: QualifiedName;
  args: Expression[];
}

export interface TypeCast extends SDLNode {
  kind: "TypeCast";
  expr: Expression;
  type: TypeRef;
}

export interface Parameter extends SDLNode {
  kind: "Parameter";
  name: string;
}

export interface ConditionalExpression extends SDLNode {
  kind: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

// Helper functions for creating AST nodes
export function createIdentifier(value: string, quoted = false): Identifier {
  return { kind: "Identifier", value, quoted };
}

export function createQualifiedName(parts: string[]): QualifiedName {
  return { kind: "QualifiedName", parts };
}

export function createTypeRef(
  name: QualifiedName,
  optional = false,
  array = false,
  params?: TypeRef[],
): TypeRef {
  const ref: TypeRef = { kind: "TypeRef", name, optional, array };
  if (params && params.length > 0) {
    ref.params = params;
  }
  return ref;
}

export function createLiteral(
  type: Literal["type"],
  value: string | number | boolean,
): Literal {
  return { kind: "Literal", type, value };
}
