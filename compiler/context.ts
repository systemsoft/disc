/**
 * Compilation context and schema information
 */

import type { AccessPolicy } from "../access/types.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import * as SQL from "./sql.ts";

/**
 * Abstract polymorphic types used in EdgeQL function signatures.
 *
 * These allow generic function definitions where a parameter accepts
 * any concrete type (e.g., `anytype` matches `str`, `int64`, `float64`, etc.).
 */
export const POLYMORPHIC_TYPES = new Set([
  "anytype",
  "anyscalar",
  "anyenum",
  "anytuple",
  "anyobject",
  "anyreal",
  "anyint",
  "anyfloat",
  "anynumeric"
]);

/**
 * Check whether a type name is an abstract polymorphic type.
 *
 * Polymorphic types match any concrete type during function overload
 * resolution. For example, a function parameter typed `anytype` will
 * accept `str`, `int64`, `float64`, or any other concrete type.
 */
export function isPolymorphicType(typeName: string): boolean {
  return POLYMORPHIC_TYPES.has(typeName);
}

export interface CompilationContext {
  schema: Schema;
  aliasCounter: number;
  currentScope: Scope;
  scopes: Scope[];
  /** Maps CTE binding names to their resolved type info */
  cteAliases: Map<string, CTEAlias>;
  /** Module scope set by WITH MODULE <name> for unqualified type resolution */
  moduleScope?: string;
}

export interface CTEAlias {
  /** The CTE name used in SQL (e.g., "active") */
  cteName: string;
  /** The underlying schema type name, if the CTE wraps a typed query */
  typeName?: string;
  /** The resolved TypeDef for shape compilation, if available */
  typeDef?: TypeDef;
}

export interface AbstractAnnotationDef {
  name: string;
  type?: string;
}

export interface Schema {
  types: Map<string, TypeDef>;
  functions: Map<string, FunctionDef>;
  aliases?: Map<string, AliasDef>;
  globals?: Map<string, GlobalDef>;
  abstractAnnotations?: Map<string, AbstractAnnotationDef>;
}

export interface TriggerDef {
  name: string;
  timing: "before" | "after";
  events: ("insert" | "update" | "delete")[];
  scope: "each" | "all";
  body: string;
}

export interface RewriteDef {
  events: ("insert" | "update")[];
  body: string;
}

export interface AliasDef {
  name: string;
  expression: string;
  targetType?: string;
}

export interface GlobalDef {
  name: string;
  module: string;
  type: string;
  pgType: string;
  required: boolean;
  multi: boolean;
  default?: string;
  readonly: boolean;
  pgSettingName: string;
}

export interface TypeDef {
  name: string;
  kind: "object" | "scalar" | "enum";
  properties: Map<string, PropertyDef>;
  links: Map<string, LinkDef>;
  tableName: string;
  accessPolicies?: AccessPolicy[];
  /** Trigger definitions attached to this type */
  triggers?: TriggerDef[];
  /** Enum member values for scalar enum types */
  enumValues?: string[];
  /** Whether this is an abstract type (cannot be instantiated directly) */
  abstract?: boolean;
  /** Names of parent types (e.g., ["Shape"] or ["Timestamped", "Authored"] for multiple inheritance) */
  parentTypes?: string[];
  /** Names of direct child types (e.g., ["Circle", "Rectangle"]) */
  subtypes?: string[];
  /** Column name for type discrimination (e.g., "__type__") */
  discriminatorColumn?: string;
  /** Annotations (e.g., description) from SDL */
  annotations?: Record<string, string>;
  /** Module this type belongs to (e.g., "default", "payment") */
  module?: string;
  /** Indexes declared on this type (e.g., `index on (.name)`) */
  indexes?: IndexDef[];
}

export interface IndexDef {
  /** Optional named index — e.g., `index name_idx on (.name)` */
  name?: string;
  /** Stringified index expression — e.g., ".name" or "(.firstName, .lastName)" */
  expression: string;
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
  /** Rewrite rules for insert/update operations */
  rewrites?: RewriteDef[];
  /** Annotations (e.g., description) from SDL */
  annotations?: Record<string, string>;
}

export interface LinkDef {
  name: string;
  target: string;
  required: boolean;
  multi: boolean;
  columnName?: string; // For foreign keys
  backlink?: string;
  junctionTable?: string; // For many-to-many via junction table
  junctionSourceColumn?: string; // Column referencing this type (default: "source_id")
  junctionTargetColumn?: string; // Column referencing target type (default: "target_id")
  /** Whether this link is computed (no physical column / not stored). */
  computed?: boolean;
  /** Annotations (e.g., description) from SDL */
  annotations?: Record<string, string>;
}

export interface FunctionDef {
  name: string;
  args: ArgDef[];
  returnType: string;
  sqlName?: string;
  windowOnly?: boolean; // true for functions that REQUIRE an OVER clause (row_number, rank, etc.)
  windowCompatible?: boolean; // true for functions that CAN use an OVER clause (count, sum, etc.)
  introspection?: boolean; // true for schema:: functions resolved at compile time
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
    cteAliases: new Map()
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
  type: string
): string {
  const alias = generateAlias(ctx, name);
  ctx.currentScope.aliases.set(name, { table, alias, type });
  return alias;
}

export function getTableAlias(
  ctx: CompilationContext,
  name: string
): TableAlias | undefined {
  // Check current scope first
  let alias = ctx.currentScope.aliases.get(name);
  if (alias)
    return alias;

  // Check parent scopes
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    alias = ctx.scopes[i].aliases.get(name);
    if (alias)
      return alias;
  }

  return undefined;
}

export function getTypeDef(
  ctx: CompilationContext,
  name: string
): TypeDef | undefined {
  return ctx.schema.types.get(name);
}

/**
 * Resolve a type name respecting the current module scope.
 *
 * Resolution order:
 * 1. Exact name (already qualified or known at top level)
 * 2. If unqualified and moduleScope is set: try moduleScope::name
 * 3. If unqualified: try default::name
 */
export function resolveTypeName(
  ctx: CompilationContext,
  name: string
): TypeDef | undefined {
  // 1. Exact match
  let typeDef = ctx.schema.types.get(name);
  if (typeDef)
    return typeDef;

  // Only try qualified lookups for unqualified names
  if (!name.includes("::")) {
    // 2. Module scope (set by WITH MODULE)
    if (ctx.moduleScope) {
      typeDef = ctx.schema.types.get(`${ctx.moduleScope}::${name}`);
      if (typeDef)
        return typeDef;
    }

    // 3. Default module
    typeDef = ctx.schema.types.get(`default::${name}`);
    if (typeDef)
      return typeDef;
  } else if (name.startsWith("default::")) {
    // 4. Strip the default:: prefix — types in the default module are stored
    // under their bare name (see migration/schema-manager.ts:621), so a
    // query like `select default::Item` must fall back to looking up `Item`
    // when the qualified key isn't present.
    typeDef = ctx.schema.types.get(name.slice("default::".length));
    if (typeDef)
      return typeDef;
  }

  return undefined;
}

/**
 * Resolve an alias name respecting module scope.
 *
 * Resolution order:
 * 1. Exact name (already qualified or known at top level)
 * 2. If unqualified and moduleScope is set: try moduleScope::name
 * 3. If unqualified: try default::name
 */
export function resolveAlias(
  schema: Schema,
  name: string,
  moduleScope?: string
): AliasDef | undefined {
  if (!schema.aliases)
    return undefined;

  // 1. Exact match
  let aliasDef = schema.aliases.get(name);
  if (aliasDef)
    return aliasDef;

  // Only try qualified lookups for unqualified names
  if (!name.includes("::")) {
    // 2. Module scope
    if (moduleScope) {
      aliasDef = schema.aliases.get(`${moduleScope}::${name}`);
      if (aliasDef)
        return aliasDef;
    }

    // 3. Default module
    aliasDef = schema.aliases.get(`default::${name}`);
    if (aliasDef)
      return aliasDef;
  }

  return undefined;
}

/**
 * Resolve a global name respecting module scope.
 *
 * Resolution order:
 * 1. Exact name (already qualified or known at top level)
 * 2. If unqualified and moduleScope is set: try moduleScope::name
 * 3. If unqualified: try default::name
 */
export function resolveGlobal(
  schema: Schema,
  name: string,
  moduleScope?: string
): GlobalDef | undefined {
  if (!schema.globals)
    return undefined;

  // 1. Exact match
  let globalDef = schema.globals.get(name);
  if (globalDef)
    return globalDef;

  // Only try qualified lookups for unqualified names
  if (!name.includes("::")) {
    // 2. Module scope
    if (moduleScope) {
      globalDef = schema.globals.get(`${moduleScope}::${name}`);
      if (globalDef)
        return globalDef;
    }

    // 3. Default module
    globalDef = schema.globals.get(`default::${name}`);
    if (globalDef)
      return globalDef;
  }

  return undefined;
}

export function getProperty(
  ctx: CompilationContext,
  typeName: string,
  propName: string
): PropertyDef | undefined {
  const type = resolveTypeName(ctx, typeName);
  return type?.properties.get(propName);
}

export function getLink(
  ctx: CompilationContext,
  typeName: string,
  linkName: string
): LinkDef | undefined {
  const type = resolveTypeName(ctx, typeName);
  return type?.links.get(linkName);
}

export function addCTEAlias(
  ctx: CompilationContext,
  name: string,
  alias: CTEAlias
): void {
  ctx.cteAliases.set(name, alias);
}

export function getCTEAlias(
  ctx: CompilationContext,
  name: string
): CTEAlias | undefined {
  return ctx.cteAliases.get(name);
}

export function removeCTEAlias(
  ctx: CompilationContext,
  name: string
): void {
  ctx.cteAliases.delete(name);
}

/** Check if a name refers to an enum type in the schema */
export function isEnumType(schema: Schema, name: string): boolean {
  const typeDef = schema.types.get(name);
  return !!typeDef && Array.isArray(typeDef.enumValues) &&
    typeDef.enumValues.length > 0;
}

/**
 * Convert an EdgeQL enum type name to the PostgreSQL enum type name
 * created by the migration engine. Mirrors `enumTypeName()` in
 * `migration/ddl.ts`: `disc_enum_<lowercased simplename>`. Strips any
 * `module::` qualifier so cross-module references like `logger::LogLevel`
 * resolve to the same PG type as a bare `LogLevel`. The `disc_enum_`
 * prefix avoids colliding with user-supplied PG enums.
 */
export function getEnumSqlType(name: string): string {
  const simpleName = name.includes("::")
    ? name.slice(name.lastIndexOf("::") + 2)
    : name;
  return `disc_enum_${simpleName.toLowerCase()}`;
}

/**
 * Get all subtypes transitively (breadth-first).
 *
 * For example, if Circle extends Shape and Ellipse extends Circle,
 * getAllSubtypes(schema, "Shape") returns ["Circle", "Ellipse"].
 */
export function getAllSubtypes(
  schema: Schema,
  typeName: string
): string[] {
  const typeDef = schema.types.get(typeName);
  if (!typeDef?.subtypes || typeDef.subtypes.length === 0)
    return [];

  const result: string[] = [];
  const queue = [...typeDef.subtypes];
  while (queue.length > 0) {
    const name = queue.shift()!;
    result.push(name);
    const sub = schema.types.get(name);
    if (sub?.subtypes) {
      queue.push(...sub.subtypes);
    }
  }
  return result;
}

/**
 * Get type hierarchy ancestry (from type up to root).
 *
 * For example, getTypeHierarchy(schema, "Ellipse") might return
 * ["Ellipse", "Circle", "Shape"] if Ellipse extends Circle extends Shape.
 */
export function getTypeHierarchy(
  schema: Schema,
  typeName: string
): string[] {
  const result: string[] = [typeName];
  const visited = new Set<string>([typeName]);
  const queue = [...(schema.types.get(typeName)?.parentTypes ?? [])];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name))
      continue;
    visited.add(name);
    result.push(name);
    const parentDef = schema.types.get(name);
    if (parentDef?.parentTypes) {
      queue.push(...parentDef.parentTypes);
    }
  }
  return result;
}

export function mergeSchemaAdditions(
  base: Schema,
  additionalFunctions: FunctionDef[],
  additionalTypes: TypeDef[]
): Schema {
  const functions = new Map(base.functions);
  for (const fn of additionalFunctions) {
    functions.set(fn.name, fn);
  }

  const types = new Map(base.types);
  for (const type of additionalTypes) {
    types.set(type.name, type);
  }

  const result: Schema = { types, functions };
  if (base.aliases) {
    result.aliases = new Map(base.aliases);
  }
  if (base.globals) {
    result.globals = new Map(base.globals);
  }
  if (base.abstractAnnotations) {
    result.abstractAnnotations = new Map(base.abstractAnnotations);
  }
  return result;
}

// Default schema with basic types for testing
export function createTestSchema(): Schema {
  const statusType: TypeDef = {
    name: "Status",
    kind: "enum",
    tableName: "status",
    properties: new Map(),
    links: new Map(),
    enumValues: ["active", "inactive", "pending"]
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
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
        constraints: [{ name: "max_length", args: ["255"] }]
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }]
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: false,
        multi: false,
        columnName: "active",
        edgeqlType: "bool"
      }],
      ["age", {
        name: "age",
        type: "int32",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32"
      }],
      ["postCount", {
        name: "postCount",
        type: "int32",
        required: false,
        multi: false,
        columnName: "post_count",
        edgeqlType: "int32",
        computed: true
      }]
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        backlink: "author"
      }]
    ])
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
        hasDefault: true
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str"
      }],
      ["body", {
        name: "body",
        type: "str",
        required: true,
        multi: false,
        columnName: "body",
        edgeqlType: "str"
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "created_at",
        edgeqlType: "datetime",
        readonly: true,
        hasDefault: true
      }]
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        columnName: "author_id"
      }]
    ])
  };

  return {
    types: new Map([
      ["Status", statusType],
      ["User", userType],
      ["Post", postType]
    ]),
    functions: getBuiltinFunctions(),
    aliases: new Map(),
    globals: new Map([
      ["default::current_user_id", {
        name: "current_user_id",
        module: "default",
        type: "uuid",
        pgType: "uuid",
        required: false,
        multi: false,
        readonly: false,
        pgSettingName: "disc.global_default__current_user_id"
      }]
    ])
  };
}

/**
 * Create a multi-module test schema for testing module-aware codegen.
 * Mimics a real-world project with default, api, and payment modules.
 */
export function createMultiModuleTestSchema(): Schema {
  // default module types
  const merchantStatusType: TypeDef = {
    name: "MerchantStatus",
    kind: "enum",
    tableName: "merchant_status",
    properties: new Map(),
    links: new Map(),
    enumValues: ["active", "suspended", "pending"],
    module: "default"
  };

  const merchantType: TypeDef = {
    name: "Merchant",
    kind: "object",
    tableName: "merchants",
    module: "default",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }],
      ["status", {
        name: "status",
        type: "str",
        required: false,
        multi: false,
        columnName: "status",
        edgeqlType: "str"
      }]
    ]),
    links: new Map([
      ["apiKeys", {
        name: "apiKeys",
        target: "api::ApiKey",
        required: false,
        multi: true,
        backlink: "merchant"
      }],
      ["payments", {
        name: "payments",
        target: "payment::Payment",
        required: false,
        multi: true,
        backlink: "merchant"
      }]
    ])
  };

  // api module types
  const apiKeyType: TypeDef = {
    name: "ApiKey",
    kind: "object",
    tableName: "api_keys",
    module: "api",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["key", {
        name: "key",
        type: "str",
        required: true,
        multi: false,
        columnName: "key",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }]
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: true,
        multi: false,
        columnName: "active",
        edgeqlType: "bool",
        hasDefault: true
      }]
    ]),
    links: new Map([
      ["merchant", {
        name: "merchant",
        target: "Merchant",
        required: true,
        multi: false,
        columnName: "merchant_id"
      }]
    ])
  };

  // payment module types
  const paymentStatusType: TypeDef = {
    name: "PaymentStatus",
    kind: "enum",
    tableName: "payment_status",
    properties: new Map(),
    links: new Map(),
    enumValues: ["pending", "completed", "failed", "refunded"],
    module: "payment"
  };

  const paymentType: TypeDef = {
    name: "Payment",
    kind: "object",
    tableName: "payments",
    module: "payment",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["amount", {
        name: "amount",
        type: "decimal",
        required: true,
        multi: false,
        columnName: "amount",
        edgeqlType: "decimal"
      }],
      ["currency", {
        name: "currency",
        type: "str",
        required: true,
        multi: false,
        columnName: "currency",
        edgeqlType: "str"
      }],
      ["status", {
        name: "status",
        type: "str",
        required: false,
        multi: false,
        columnName: "status",
        edgeqlType: "str"
      }]
    ]),
    links: new Map([
      ["merchant", {
        name: "merchant",
        target: "Merchant",
        required: true,
        multi: false,
        columnName: "merchant_id"
      }]
    ])
  };

  return {
    types: new Map([
      // default module: bare keys
      ["MerchantStatus", merchantStatusType],
      ["Merchant", merchantType],
      // api module: qualified keys
      ["api::ApiKey", apiKeyType],
      // payment module: qualified keys
      ["payment::PaymentStatus", paymentStatusType],
      ["payment::Payment", paymentType]
    ]),
    functions: getBuiltinFunctions()
  };
}
