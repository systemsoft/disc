/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Expression aliases (`alias Name := <expression>`), which Gel defines as
 * their expression.
 *
 * An alias of a type's objects, shaped or not (`alias People := User`,
 * `alias Named := User { name, loud := str_upper(.name) }`), is an object
 * type of its own — Gel's view type: `User`'s objects, read from its table,
 * with each computed of the shape (`loud`) a computed property, so `select
 * Named { loud } filter .loud = 'A'` compiles as on a type declaring it.
 *
 * Any other alias (`alias Tiers := User.tier union 'none'`, `alias Active :=
 * (select User filter .active)`) is bound where a query names it: a `with`
 * binding of its expression ahead of the query, so it compiles as that
 * expression written there would — its values, or its objects. An alias
 * naming another is bound after it.
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import type { PropertyDef, Schema, TypeDef } from "./context.ts";

/*** A query with the aliases it names bound, and the schema it compiles in: the one given plus those aliases' view types. ***/
export interface AliasesBound {
  query: EdgeQLAST.Query;
  schema: Schema;
}

/*** The binding an alias is bound to in a query (see the module comment). ***/
function bindingName(key: string): string {
  return `__alias_${key.replace(/::/g, "__")}`;
}

/**
 * `query` with the aliases it names bound (see the module comment): each
 * alias of values or of a query is a `with` binding ahead of it, which the
 * names are replaced by, and each alias of a type's objects a view type in
 * the schema returned. A name a `with` binding or `for` variable of the
 * query binds is not an alias's. `query` and `schema` are returned as they
 * are when it names no alias.
 */
export function bindAliases(query: EdgeQLAST.Query, schema: Schema): AliasesBound {
  const aliases = schema.aliases;
  if (!aliases || aliases.size === 0) {
    return { query, schema };
  }
  const shadowed = boundNames(query);
  const views = new Map<string, TypeDef>();
  const bindings: EdgeQLAST.WithBinding[] = [];
  const bound = new Set<string>();
  const binding = new Set<string>();

  /*** The key of the alias `name` names, if it names one. ***/
  const aliasKey = (name: string): string | undefined => {
    if (shadowed.has(name) || schema.types.has(name)) {
      return undefined;
    }
    const bare = name.startsWith("default::") ? name.slice("default::".length) : name;
    return [name, bare, `default::${bare}`].find(key => aliases.has(key));
  };

  /*** Makes the alias `key` a view type or a binding, once; true for a binding. ***/
  const bind = (key: string): boolean => {
    if (views.has(key) || bound.has(key)) {
      return bound.has(key);
    }
    if (binding.has(key)) {
      throw new CompilationError(`alias '${key}' is defined recursively`);
    }
    const aliasDef = aliases.get(key)!;
    const select = aliasSelect(aliasDef.expression);
    const view = aliasDef.view ?? (select && viewType(key, select, schema.types));
    if (view) {
      views.set(key, view);
      return false;
    }
    binding.add(key);
    const value = rewrite(select ?? new EdgeQLParser(aliasDef.expression).parseExpressionOnly());
    binding.delete(key);
    bindings.push({
      kind: "WithBinding",
      name: EdgeQLAST.createIdentifier(bindingName(key)),
      value: value.kind === "SelectQuery" ? { kind: "Subquery", query: value as EdgeQLAST.SelectQuery } : value as EdgeQLAST.Expression
    });
    bound.add(key);
    return true;
  };

  /*** `node` with each name of an alias bound replaced by its binding. ***/
  const rewrite = (node: EdgeQLAST.EdgeQLNode): EdgeQLAST.EdgeQLNode =>
    replaceNames(node, name => {
      const key = aliasKey(name);
      return key === undefined ? undefined : bind(key) ? bindingName(key) : null;
    }) as EdgeQLAST.EdgeQLNode;

  const rewritten = rewrite(query) as EdgeQLAST.Query;
  if (views.size === 0 && bindings.length === 0) {
    return { query, schema };
  }
  return {
    query: bindings.length === 0 ?
      rewritten :
      rewritten.kind === "WithBlock" && !rewritten.module ?
      { ...rewritten, bindings: [...bindings, ...rewritten.bindings] } :
      { bindings, body: rewritten, kind: "WithBlock" },
    schema: views.size === 0 ? schema : { ...schema, types: new Map([...schema.types, ...views]) }
  };
}

/**
 * The view type of the alias `key` of `expression` when it selects a type's
 * objects as they are (see `viewType`), else undefined — also when
 * `expression` doesn't parse, which binding it reports where it is used.
 * `modulesToSchema` keeps it on the alias (`AliasDef.view`), with its
 * computeds typed as a type's are.
 */
export function aliasViewType(key: string, expression: string, types: Map<string, TypeDef>): TypeDef | undefined {
  let select: EdgeQLAST.SelectQuery | null;
  try {
    select = aliasSelect(expression);
  } catch {
    return undefined;
  }
  return select ? viewType(key, select, types) : undefined;
}

/*** The select an alias's expression is, or null for another query (an insert, a `with` block, …). ***/
function aliasSelect(expression: string): EdgeQLAST.SelectQuery | null {
  const expr = new EdgeQLParser(expression).parseExpressionOnly();
  if (expr.kind === "Subquery") {
    return expr.query.kind === "SelectQuery" ? expr.query : null;
  }
  return expr.kind === "ShapeExpr" ? { expr: expr.expr, kind: "SelectQuery", shape: expr.shape } : { expr, kind: "SelectQuery" };
}

/**
 * The view type of the alias `key` when `select`, its expression, selects a
 * type's objects as they are (`User`, `User { name, loud := … }`: no filter,
 * order, offset or limit): that type with each computed of the shape a
 * computed property, of a type yet to be inferred (`auto`, as an SDL
 * computed's). Undefined for any other alias.
 */
function viewType(key: string, select: EdgeQLAST.SelectQuery, types: Map<string, TypeDef>): TypeDef | undefined {
  if (select.expr.kind !== "TypeName" || select.filter || select.orderBy || select.offset || select.limit || select.distinct) {
    return undefined;
  }
  const module = key.includes("::") ? key.slice(0, key.lastIndexOf("::")) : "default";
  const name = select.expr.name.parts.join("::");
  const bare = name.startsWith("default::") ? name.slice("default::".length) : name;
  const base = [`${module}::${bare}`, bare, `default::${bare}`].map(candidate => types.get(candidate)).find(typeDef => typeDef !== undefined);
  if (base?.kind !== "object") {
    return undefined;
  }
  const computeds = (select.shape?.elements ?? []).flatMap((element): [string, PropertyDef][] =>
    element.computable && element.name && element.source && !element.linkProperty ?
      [[element.name.name, {
        columnName: element.name.name,
        computed: true,
        computedExpr: element.source,
        edgeqlType: "auto",
        multi: false,
        name: element.name.name,
        required: false,
        type: "text"
      }]] :
      []
  );
  // Its own pointers: schema building may type a computed as a link (see modulesToSchema).
  return { ...base, links: new Map(base.links), module, name: key, properties: new Map([...base.properties, ...computeds]) };
}

/*** The names the `with` bindings and `for` variables of `node` bind. ***/
function boundNames(node: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach(child => boundNames(child, names));
  } else if (node !== null && typeof node === "object") {
    const kind = (node as EdgeQLAST.EdgeQLNode).kind;
    if (kind === "WithBinding") {
      names.add((node as EdgeQLAST.WithBinding).name.name);
    } else if (kind === "ForQuery") {
      names.add((node as EdgeQLAST.ForQuery).variable.name);
    }
    Object.values(node).forEach(child => boundNames(child, names));
  }
  return names;
}

/**
 * `node` with each type name, identifier and path root in expression
 * position replaced as `replace` says for its name: by the identifier it
 * returns, unchanged for null or undefined — except that an identifier for
 * which it returns null becomes a type name (a view type's). Names that
 * aren't expressions are left alone: a shape element's, binding's or `for`
 * variable's own name, a plain shape element (a property), a cast's or
 * statement's type.
 */
function replaceNames(node: unknown, replace: (name: string) => string | null | undefined): unknown {
  if (Array.isArray(node)) {
    const children = node.map(child => replaceNames(child, replace));
    return children.every((child, index) => child === node[index]) ? node : children;
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const kind = (node as EdgeQLAST.EdgeQLNode).kind;
  if (kind === "TypeName") {
    const replaced = replace((node as EdgeQLAST.TypeName).name.parts.join("::"));
    return replaced ? EdgeQLAST.createIdentifier(replaced) : node;
  }
  if (kind === "Identifier") {
    const replaced = replace((node as EdgeQLAST.Identifier).name);
    return replaced ?
      EdgeQLAST.createIdentifier(replaced) :
      replaced === null ?
      EdgeQLAST.createTypeName((node as EdgeQLAST.Identifier).name.split("::")) :
      node;
  }
  if (kind === "Path" && (node as EdgeQLAST.Path).rooted) {
    const path = node as EdgeQLAST.Path;
    const replaced = replace(path.steps[0].name);
    if (replaced) {
      return { ...path, steps: [{ ...path.steps[0], name: replaced }, ...path.steps.slice(1)] };
    }
  }
  const plainElement = kind === "ShapeElement" && !(node as EdgeQLAST.ShapeElement).computable;
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const kept = key === "span" || key === "name" || key === "variable" || key === "type" || (plainElement && key === "expr");
    result[key] = kept ? value : replaceNames(value, replace);
    changed ||= result[key] !== value;
  }
  return changed ? result : node;
}
