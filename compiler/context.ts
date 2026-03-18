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
}

export interface PropertyDef {
  name: string;
  type: string;
  required: boolean;
  multi: boolean;
  columnName: string;
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

// Default schema with basic types for testing
export function createTestSchema(): Schema {
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
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "createdAt",
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: false,
        multi: false,
        columnName: "active",
      }],
      ["age", {
        name: "age",
        type: "int32",
        required: false,
        multi: false,
        columnName: "age",
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
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
      }],
      ["body", {
        name: "body",
        type: "str",
        required: true,
        multi: false,
        columnName: "body",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "createdAt",
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
      ["User", userType],
      ["Post", postType],
    ]),
    functions: getBuiltinFunctions(),
  };
}
