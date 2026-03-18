/**
 * Compilation context and schema information
 */

import { getBuiltinFunctions } from "./builtin-functions.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import * as SQL from "./sql.ts";
import type { AccessPolicy } from "../access/types.ts";

export interface CompilationContext {
  schema: Schema;
  aliasCounter: number;
  currentScope: Scope;
  scopes: Scope[];
  /** Maps CTE binding names to their resolved type info */
  cteAliases: Map<string, CTEAlias>;
}

export interface CTEAlias {
  /** The CTE name used in SQL (e.g., "active") */
  cteName: string;
  /** The underlying schema type name, if the CTE wraps a typed query */
  typeName?: string;
  /** The resolved TypeDef for shape compilation, if available */
  typeDef?: TypeDef;
}

export interface Schema {
  types: Map<string, TypeDef>;
  functions: Map<string, FunctionDef>;
}

export interface TypeDef {
  name: string;
  kind: "object" | "scalar" | "enum";
  properties: Map<string, PropertyDef>;
  links: Map<string, LinkDef>;
  tableName: string;
  accessPolicies?: AccessPolicy[];
  /** Enum member values for scalar enum types */
  enumValues?: string[];
}

export interface PropertyConstraint {
  name: string;
  args?: string[];
}

export interface PropertyDef {
  name: string;
  type: string;
  required: boolean;
  multi: boolean;
  columnName: string;
  /** Original EdgeQL type name (e.g., "str", "int32", "bool") before SQL mapping */
  edgeqlType?: string;
  /** Whether this property is readonly (cannot be set after creation) */
  readonly?: boolean;
  /** Whether this property has a default value expression */
  hasDefault?: boolean;
  /** Whether this property is a computed expression (not stored) */
  computed?: boolean;
  /** Constraints applied to this property (e.g., exclusive, max_length) */
  constraints?: PropertyConstraint[];
}

export interface LinkDef {
  name: string;
  target: string;
  required: boolean;
  multi: boolean;
  columnName?: string; // For foreign keys
  backlink?: string;
}

export interface FunctionDef {
  name: string;
  args: ArgDef[];
  returnType: string;
  sqlName?: string;
  windowOnly?: boolean; // true for functions that REQUIRE an OVER clause (row_number, rank, etc.)
  windowCompatible?: boolean; // true for functions that CAN use an OVER clause (count, sum, etc.)
}

export interface ArgDef {
  name: string;
  type: string;
  required: boolean;
}

export interface Scope {
  aliases: Map<string, TableAlias>;
  variables: Map<string, VariableDef>;
}

export interface TableAlias {
  table: string;
  alias: string;
  type: string;
}

export interface VariableDef {
  name: string;
  type: string;
  expression: EdgeQLAST.Expression;
  sqlOverride?: SQL.SQLExpression;
}

export function createContext(schema: Schema): CompilationContext {
  return {
    schema,
    aliasCounter: 0,
    currentScope: { aliases: new Map(), variables: new Map() },
    scopes: [],
    cteAliases: new Map(),
  };
}

export function pushScope(ctx: CompilationContext): void {
  ctx.scopes.push(ctx.currentScope);
  ctx.currentScope = { aliases: new Map(), variables: new Map() };
}

export function popScope(ctx: CompilationContext): void {
  const scope = ctx.scopes.pop();
  if (scope) {
    ctx.currentScope = scope;
  }
}

export function generateAlias(ctx: CompilationContext, base: string): string {
  return `${base}_${++ctx.aliasCounter}`;
}

export function addTableAlias(
  ctx: CompilationContext,
  name: string,
  table: string,
  type: string,
): string {
  const alias = generateAlias(ctx, name);
  ctx.currentScope.aliases.set(name, { table, alias, type });
  return alias;
}

export function getTableAlias(
  ctx: CompilationContext,
  name: string,
): TableAlias | undefined {
  // Check current scope first
  let alias = ctx.currentScope.aliases.get(name);
  if (alias) return alias;

  // Check parent scopes
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    alias = ctx.scopes[i].aliases.get(name);
    if (alias) return alias;
  }

  return undefined;
}

export function getTypeDef(
  ctx: CompilationContext,
  name: string,
): TypeDef | undefined {
  return ctx.schema.types.get(name);
}

export function getProperty(
  ctx: CompilationContext,
  typeName: string,
  propName: string,
): PropertyDef | undefined {
  const type = getTypeDef(ctx, typeName);
  return type?.properties.get(propName);
}

export function getLink(
  ctx: CompilationContext,
  typeName: string,
  linkName: string,
): LinkDef | undefined {
  const type = getTypeDef(ctx, typeName);
  return type?.links.get(linkName);
}

export function addCTEAlias(
  ctx: CompilationContext,
  name: string,
  alias: CTEAlias,
): void {
  ctx.cteAliases.set(name, alias);
}

export function getCTEAlias(
  ctx: CompilationContext,
  name: string,
): CTEAlias | undefined {
  return ctx.cteAliases.get(name);
}

export function removeCTEAlias(
  ctx: CompilationContext,
  name: string,
): void {
  ctx.cteAliases.delete(name);
}

export function mergeSchemaAdditions(
  base: Schema,
  additionalFunctions: FunctionDef[],
  additionalTypes: TypeDef[],
): Schema {
  const functions = new Map(base.functions);
  for (const fn of additionalFunctions) {
    functions.set(fn.name, fn);
  }

  const types = new Map(base.types);
  for (const type of additionalTypes) {
    types.set(type.name, type);
  }

  return { types, functions };
}

// Default schema with basic types for testing
export function createTestSchema(): Schema {
  const statusType: TypeDef = {
    name: "Status",
    kind: "enum",
    tableName: "status",
    properties: new Map(),
    links: new Map(),
    enumValues: ["active", "inactive", "pending"],
  };

  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
        constraints: [{ name: "max_length", args: ["255"] }],
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }],
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true,
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: false,
        multi: false,
        columnName: "active",
        edgeqlType: "bool",
      }],
      ["age", {
        name: "age",
        type: "int32",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32",
      }],
      ["postCount", {
        name: "postCount",
        type: "int32",
        required: false,
        multi: false,
        columnName: "post_count",
        edgeqlType: "int32",
        computed: true,
      }],
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        backlink: "author",
      }],
    ]),
  };

  const postType: TypeDef = {
    name: "Post",
    kind: "object",
    tableName: "posts",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str",
      }],
      ["body", {
        name: "body",
        type: "str",
        required: true,
        multi: false,
        columnName: "body",
        edgeqlType: "str",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true,
      }],
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        columnName: "author_id",
      }],
    ]),
  };

  return {
    types: new Map([
      ["Status", statusType],
      ["User", userType],
      ["Post", postType],
    ]),
    functions: getBuiltinFunctions(),
  };
}
