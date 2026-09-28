/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL Abstract Syntax Tree (AST) node definitions
 */

import { EdgeQLLexer } from "../edgeql/lexer.ts";
import { TokenType as EdgeQLTokenType } from "../edgeql/tokens.ts";
import { Span } from "../lib/types.ts";
import { sdlExpressionToEdgeQL } from "./expression-printer.ts";

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
  | LinkDeclaration
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
  /*** `using`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  usingSource?: string;
}

// Function declaration
export interface FunctionDeclaration extends SDLNode {
  kind: "FunctionDeclaration";
  name: Identifier;
  parameters: FunctionParameter[];
  returnType: TypeRef;
  /*** `-> optional T` (may be empty) or `-> set of T` (may be several). ***/
  returnTypemod?: "optional" | "setof";
  using?: Expression;
  /*** The body's EdgeQL source, as written between `using (` and `)`. ***/
  usingSource?: string;
  volatility?: FunctionVolatility;
  annotations?: Annotation[];
  overloaded?: boolean;
}

/*** A function's `volatility := '…'`, lowercased. ***/
export type FunctionVolatility = "immutable" | "stable" | "volatile" | "modifying";

// Global declaration
export interface GlobalDeclaration extends SDLNode {
  kind: "GlobalDeclaration";
  name: Identifier;
  type: TypeRef;
  required?: boolean;
  multi?: boolean;
  default?: Expression;
  /*** `default`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  defaultSource?: string;
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
  /*** Declared `single` (a computed pointer only: Gel rejects it on an expression that may yield several). ***/
  single?: boolean;
  abstract?: boolean;
  overloaded?: boolean;
  readonly?: boolean;
  computed?: Expression;
  /*** A computed's expression as written: the EdgeQL it compiles from (`computed` is its SDL form). ***/
  computedSource?: string;
  default?: Expression;
  /*** `default`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  defaultSource?: string;
  constraints?: Constraint[];
  annotations?: Annotation[];
  rewrites?: RewriteDeclaration[];
  /**
   * Link properties declared in the body of a colon-form pointer whose target
   * is an object type (`multi members: User { role: str; }`). The pointer is a
   * link; `normalizeObjectPropertiesToLinks` moves these onto the
   * `LinkDeclaration.properties` it builds.
   */
  properties?: PropertyDeclaration[];
  /*** Delete policies of a colon-form link (`program: Program { on target delete allow; }`), moved onto its LinkDeclaration the same way. ***/
  onTargetDelete?: LinkDeclaration["onTargetDelete"];
  onSourceDelete?: LinkDeclaration["onSourceDelete"];
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
  /*** `default`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  defaultSource?: string;
  extending?: TypeRef[];
  properties?: PropertyDeclaration[];
  constraints?: Constraint[];
  annotations?: Annotation[];
  onTargetDelete?:
    | "restrict"
    | "cascade"
    | "allow"
    | "deferred restrict"
    | "set empty"
    | "delete source";
  onSourceDelete?: "allow" | "delete target" | "delete target if orphan";
}

// Constraint
export interface Constraint extends SDLNode {
  kind: "Constraint";
  name?: Identifier;
  delegated?: boolean;
  on?: Expression;
  /*** `on`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  onSource?: string;
  args?: Expression[];
  /*** Each of `args`' EdgeQL as written (absent from schemas an older Disc stored). ***/
  argSources?: string[];
  annotations?: Annotation[];
  errmessage?: string;
}

// Index
export interface Index extends SDLNode {
  kind: "Index";
  name?: Identifier;
  on: Expression;
  /*** `on`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  onSource?: string;
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
  /*** `condition`'s (`using`'s) EdgeQL as written (absent from schemas an older Disc stored). ***/
  conditionSource?: string;
  /**
   * Optional `with check (...)` expression. When present, runs as an
   * INSERT/UPDATE post-condition: the candidate row must satisfy the
   * expression after the write or the operation is rejected. (P1-37)
   */
  withCheck?: Expression;
  /*** `withCheck`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  withCheckSource?: string;
  annotations?: Annotation[];
  /**
   * Optional custom error message surfaced when this policy denies an
   * operation. Set via `errmessage := '...';` in SDL. Falls back to a
   * generic deny reason at runtime when omitted. (Gel #4095)
   */
  errmessage?: string;
  /**
   * Gel's `when (...)`: which objects the policy applies to at all. An object
   * it does not hold for is neither allowed nor denied by the policy.
   */
  when?: Expression;
  /*** `when`'s EdgeQL as written (absent from schemas an older Disc stored). ***/
  whenSource?: string;
}

export interface AccessAction extends SDLNode {
  kind: "AccessAction";
  allow: boolean;
  operations: AccessOperation[];
}

/**
 * `update` is `update read` (which objects an update may reach) plus
 * `update write` (the check on the objects it wrote), as in Gel.
 */
export type AccessOperation = "select" | "insert" | "update" | "update read" | "update write" | "delete" | "all";

// Function parameter
export interface FunctionParameter extends SDLNode {
  kind: "FunctionParameter";
  name: Identifier;
  type: TypeRef;
  typemod?: "optional" | "setof" | "singleton";
  default?: Expression;
  /*** Declared `named only`: passed by name (`f(x := 1)`), never by position. ***/
  namedOnly?: boolean;
}

// Type references
export interface TypeRef extends SDLNode {
  kind: "TypeRef";
  name: QualifiedName;
  array?: boolean;
  optional?: boolean;
  params?: TypeRef[];
  // Element name for named-tuple fields: the `icon` in
  // `tuple<icon: str, title: str>`. Only set on tuple parameter slots.
  fieldName?: string;
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
  | ConditionalExpression
  | TupleExpression
  | NamedTupleExpression;

export interface Literal extends SDLNode {
  kind: "Literal";
  type: "string" | "integer" | "float" | "boolean";
  value: string | number | boolean;
}

export interface PathExpression extends SDLNode {
  kind: "PathExpression";
  path: string[];
  /*** A query (`select …`) kept as tokens in `path`: its EdgeQL source text. ***/
  source?: string;
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

// Tuple expression: `(.a, .b, .c)`. Used in composite-index `on` clauses
// (and other multi-element parenthesized expression slots in EdgeQL).
export interface TupleExpression extends SDLNode {
  kind: "TupleExpression";
  elements: Expression[];
}

// Named tuple expression: `(subscribers := count(.subscribers), videos := ...)`.
// Used by computed properties that build a named-tuple shape.
export interface NamedTupleExpression extends SDLNode {
  kind: "NamedTupleExpression";
  elements: { name: string; value: Expression; }[];
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
  params?: TypeRef[]
): TypeRef {
  const ref: TypeRef = { kind: "TypeRef", name, optional, array };
  if (params && params.length > 0) {
    ref.params = params;
  }
  return ref;
}

export function createLiteral(
  type: Literal["type"],
  value: string | number | boolean
): Literal {
  return { kind: "Literal", type, value };
}

/**
 * `expr` with every `__subject__` (a constraint's subject, alone or at the
 * head of a path) replaced by `subject`: `.name` for a property's constraint
 * written on its type, a typed value for a scalar's. Returns a new tree.
 */
export function replaceSubject(expr: Expression, subject: Expression): Expression {
  // EdgeQL kept as its source text: each `__subject__` in it, as EdgeQL.
  const replaceSubjectInSource = (source: string, subject: Expression): string => {
    const text = subject.kind === "PathExpression" ? sdlExpressionToEdgeQL(subject) : `(${sdlExpressionToEdgeQL(subject)})`;
    return new EdgeQLLexer(source)
      .tokenize()
      .filter(token => token.type === EdgeQLTokenType.IDENT && token.value === "__subject__")
      .reverse()
      .reduce((replaced, token) => replaced.slice(0, token.offset) + text + replaced.slice(token.offset + token.value.length), source);
  };
  const walk = (e: Expression): Expression => {
    switch (e.kind) {
      case "PathExpression":
        if (e.source !== undefined) {
          return { ...e, source: replaceSubjectInSource(e.source, subject) };
        }
        if (e.path[0] !== "__subject__") {
          return e;
        }
        if (e.path.length === 1) {
          return subject;
        }
        return subject.kind === "PathExpression" ? { ...e, path: [...subject.path, ...e.path.slice(1)] } : e;
      case "BinaryOp":
        return { ...e, left: walk(e.left), right: walk(e.right) };
      case "UnaryOp":
        return { ...e, operand: walk(e.operand) };
      case "FunctionCall":
        return { ...e, args: e.args.map(walk) };
      case "TypeCast":
        return { ...e, expr: walk(e.expr) };
      case "ConditionalExpression":
        return { ...e, alternate: walk(e.alternate), consequent: walk(e.consequent), test: walk(e.test) };
      case "TupleExpression":
        return { ...e, elements: e.elements.map(walk) };
      case "NamedTupleExpression":
        return { ...e, elements: e.elements.map(element => ({ ...element, value: walk(element.value) })) };
      default:
        return e;
    }
  };
  return walk(expr);
}
