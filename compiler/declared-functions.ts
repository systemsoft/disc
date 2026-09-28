/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Calls of SDL `function`s, inlined.
 *
 * `function full_name(first: str, last: str) -> str using (first ++ ' ' ++
 * last)` creates nothing in PostgreSQL: a call `full_name(.first, 'x')` is
 * replaced, before it is compiled, by the body with each parameter replaced by
 * its argument (`.first ++ ' ' ++ 'x'`). The body then compiles like any
 * expression written in its place — in a shape, a filter, an order by, a
 * computed — and one returning objects (`-> set of Post using (select Post …)`)
 * is a select of them, which takes a shape (`select top_posts(3) { title }`).
 * Arguments stay query parameters; no value is spliced into SQL.
 *
 * A parameter the body uses inside a nested scope of its own (a `select`, a
 * shape) is replaced by its argument only when the argument does not depend on
 * where it is written — a literal, a parameter, `User.name` — since the nested
 * scope rebinds `.`. Otherwise (`posts_by(.author)` with `select Post filter
 * .author = u`) the pre-pass (`inlineDeclaredCalls`) leaves the call, and the
 * compiler inlines it where it compiles the call, binding the argument as the
 * value it compiled there (`InlineOptions.bind`).
 *
 * Overloads are chosen as Gel chooses them: positional arguments fill the
 * parameters not declared `named only`, named arguments the `named only` ones,
 * defaults fill the rest, and the argument types must be the parameters' or
 * implicitly cast to them (the fewest casts win). A call no overload takes is
 * Gel's `function "f(arg0: std::int64)" does not exist`.
 */

import type * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { normalizeStdTypeName } from "../lib/std-types.ts";
import { renderEdgeQLTypeName } from "./compiler-base.ts";
import { lookupFunction, type DeclaredFunction, type DeclaredParameter, type Schema } from "./context.ts";

export interface InlineOptions {
  /**
   * An expression that stands for `value` inside a nested scope of the body,
   * where `value` itself would be read against that scope: the compiler
   * compiles `value` where the call is and binds the result to a name. When
   * absent, a call that needs it is left as it is.
   */
  bind?: (value: EdgeQLAST.Expression) => EdgeQLAST.Expression;
  /*** The EdgeQL type of an argument when known (`str`, `default::User`), else null. ***/
  typeOf?: (expr: EdgeQLAST.Expression) => string | null;
}

/*** Gel's implicit casts between standard scalars, each in order of preference. ***/
const IMPLICIT_CASTS = new Map<string, string[]>([
  ["bigint", ["decimal"]],
  ["float32", ["float64"]],
  ["int16", ["int32", "int64", "float32", "float64", "bigint", "decimal"]],
  ["int32", ["int64", "float64", "bigint", "decimal"]],
  ["int64", ["float64", "bigint", "decimal"]]
]);

const LITERAL_TYPES = new Map<string, string>([
  ["bigint", "bigint"],
  ["boolean", "bool"],
  ["bytes", "bytes"],
  ["decimal", "decimal"],
  ["float", "float64"],
  ["integer", "int64"],
  ["string", "str"],
  ["uuid", "uuid"]
]);

/*** Node kinds that open a scope of their own: `.` inside them is not the caller's. ***/
const SCOPE_KINDS = new Set(["DeleteQuery", "ForQuery", "GroupQuery", "InsertQuery", "SelectQuery", "Shape", "Subquery", "UpdateQuery", "WithBlock"]);

/*** Thrown to abandon an inlining that needs `InlineOptions.bind` when there is none. ***/
class NeedsBinding extends Error {}

/**
 * `node` (a query or an expression) with every call of a declared function
 * inlined where that needs nothing but the AST (see the module comment).
 */
export function inlineDeclaredCalls<T>(node: T, schema: Schema, stack: readonly DeclaredFunction[] = []): T {
  if (![...schema.functions.values()].some(def => def.declared?.length)) {
    return node;
  }
  return rewrite(node, child => {
    if (child.kind !== "FunctionCall") {
      return undefined;
    }
    const call = child as EdgeQLAST.FunctionCall;
    if (!lookupFunction(schema, call.name.parts)?.declared) {
      return undefined;
    }
    const withArgs: EdgeQLAST.FunctionCall = { ...call, args: inlineDeclaredCalls(call.args, schema, stack) };
    return inlineDeclaredCall(withArgs, schema, { typeOf: expr => syntacticType(expr, schema) }, stack) ?? withArgs;
  }) as T;
}

/**
 * `query` with its calls of declared functions inlined, as the compiler
 * compiles it, for what looks at a query before compiling it (the read-only
 * gate, the binary protocol's result descriptor): a modifying function's
 * `insert` is then seen. Unchanged when a call is in error, which compiling
 * the query reports.
 */
export function withDeclaredCallsInlined<T>(query: T, schema: Schema): T {
  try {
    return inlineDeclaredCalls(query, schema);
  } catch {
    return query;
  }
}

/**
 * The body of the declared function `call` calls, in place of the call: its
 * parameters replaced by the arguments, and the calls in it inlined in turn.
 * Null when `call` is not of a declared function, when its overload can't be
 * told from the argument types known, or when the body needs `options.bind`
 * and there is none. Throws Gel's error when no overload takes the arguments.
 */
export function inlineDeclaredCall(
  call: EdgeQLAST.FunctionCall,
  schema: Schema,
  options: InlineOptions,
  stack: readonly DeclaredFunction[] = []
): EdgeQLAST.Expression | null {
  const overloads = lookupFunction(schema, call.name.parts)?.declared;
  if (!overloads || overloads.length === 0) {
    return null;
  }
  const chosen = chooseOverload(call, overloads, schema, options);
  if (!chosen) {
    return null;
  }
  const { args, fn } = chosen;
  if (stack.includes(fn)) {
    throw new CompilationError(`function '${functionSignature(fn, "short")}' is defined recursively`);
  }

  let body: EdgeQLAST.Expression = new EdgeQLParser(fn.body).parseExpressionOnly();
  try {
    body = substitute(body, args, 0, options) as EdgeQLAST.Expression;
  } catch (error) {
    if (error instanceof NeedsBinding) {
      return null;
    }
    throw error;
  }
  const inlined = inlineDeclaredCalls(body, schema, [...stack, fn]);
  // The body's names are its module's (`with module m select …`).
  if (fn.module !== "default") {
    return {
      kind: "Subquery",
      query: { bindings: [], body: { distinct: false, expr: inlined, kind: "SelectQuery" }, kind: "WithBlock", module: fn.module }
    };
  }
  return inlined;
}

/**
 * The overload `call` calls and each parameter's argument (or default), or
 * null when several overloads fit arguments whose types are not all known.
 */
function chooseOverload(
  call: EdgeQLAST.FunctionCall,
  overloads: DeclaredFunction[],
  schema: Schema,
  options: InlineOptions
): { args: Map<string, EdgeQLAST.Expression>; fn: DeclaredFunction; } | null {
  const argTypes = call.args.map(arg => options.typeOf?.(arg.value) ?? null);
  const fits = overloads.flatMap(fn => {
    const args = bindArguments(fn, call.args);
    if (!args) {
      return [];
    }
    let cost = 0;
    for (const [index, arg] of call.args.entries()) {
      const parameter = arg.name !== undefined ?
        fn.parameters.find(p => p.namedOnly && p.name === arg.name)! :
        fn.parameters.filter(p => !p.namedOnly)[positionalIndex(call.args, index)];
      const type = argTypes[index];
      const castCost = type === null ? 0 : implicitCastCost(type, parameter.type, fn.module, schema);
      if (castCost === null) {
        return [];
      }
      cost += castCost;
    }
    return [{ args, cost, fn }];
  });
  if (fits.length === 0) {
    throw noSuchFunction(call, argTypes, overloads, schema);
  }
  const least = Math.min(...fits.map(fit => fit.cost));
  const best = fits.filter(fit => fit.cost === least);
  // Unknown argument types fit anything: only the compiler, which knows them
  // better, may pick one of several.
  if (best.length > 1 && argTypes.includes(null) && !options.bind) {
    return null;
  }
  return best[0];
}

/*** The position of `args[index]` among the positional arguments. ***/
function positionalIndex(args: EdgeQLAST.FunctionArg[], index: number): number {
  return args.slice(0, index).filter(arg => arg.name === undefined).length;
}

/*** Each parameter of `fn` bound to its argument or default, or null when the arguments don't fit its parameters. ***/
function bindArguments(fn: DeclaredFunction, args: EdgeQLAST.FunctionArg[]): Map<string, EdgeQLAST.Expression> | null {
  const positional = fn.parameters.filter(parameter => !parameter.namedOnly);
  const bound = new Map<string, EdgeQLAST.Expression>();
  let position = 0;
  for (const arg of args) {
    if (arg.name === undefined) {
      const parameter = positional[position++];
      if (!parameter) {
        return null;
      }
      bound.set(parameter.name, arg.value);
    } else {
      const parameter = fn.parameters.find(p => p.namedOnly && p.name === arg.name);
      if (!parameter || bound.has(parameter.name)) {
        return null;
      }
      bound.set(parameter.name, arg.value);
    }
  }
  for (const parameter of fn.parameters) {
    if (bound.has(parameter.name)) {
      continue;
    }
    if (parameter.default === undefined) {
      return null;
    }
    bound.set(parameter.name, new EdgeQLParser(parameter.default).parseExpressionOnly());
  }
  return bound;
}

/**
 * The number of implicit casts from `from` to `to` (0 when they are the
 * same type), or null when there is none. An object type goes to any of its
 * ancestors, a user scalar to the type it extends.
 */
function implicitCastCost(from: string, to: string, module: string, schema: Schema): number | null {
  const source = bareTypeName(from);
  const target = bareTypeName(to, module);
  if (source === target) {
    return 0;
  }
  const casts = IMPLICIT_CASTS.get(source);
  if (casts?.includes(target)) {
    return casts.indexOf(target) + 1;
  }
  const typeDef = schema.types.get(source);
  if (typeDef?.kind === "object") {
    const depth = ancestorDepth(source, target, schema, new Set());
    return depth;
  }
  const base = schema.scalars?.get(source);
  if (base !== undefined && base !== source) {
    const cost = implicitCastCost(base, target, module, schema);
    return cost === null ? null : cost + 1;
  }
  return null;
}

/*** How many `extending` steps up from object type `from` `to` is, or null when it is not an ancestor. ***/
function ancestorDepth(from: string, to: string, schema: Schema, seen: Set<string>): number | null {
  if (from === to) {
    return 0;
  }
  if (seen.has(from)) {
    return null;
  }
  seen.add(from);
  const depths = (schema.types.get(from)?.parentTypes ?? [])
    .map(parent => ancestorDepth(bareTypeName(parent), to, schema, seen))
    .filter((depth): depth is number => depth !== null);
  return depths.length > 0 ? Math.min(...depths) + 1 : null;
}

/*** A type name as the schema keys it: no `std::`, and no `default::` (or `module::` when `module` declares it). ***/
function bareTypeName(name: string, module = "default"): string {
  const normalized = normalizeStdTypeName(name);
  for (const prefix of ["default::", `${module}::`]) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

/**
 * `node` with each use of a parameter replaced by its argument: a bare
 * reference by the argument, a path from one (`u.name`) by that path from the
 * argument. `depth` counts the scopes opened since the body's top level.
 */
function substitute(node: unknown, args: Map<string, EdgeQLAST.Expression>, depth: number, options: InlineOptions): unknown {
  if (Array.isArray(node)) {
    return node.map(child => substitute(child, args, depth, options));
  }
  if (node === null || typeof node !== "object" || typeof (node as EdgeQLAST.EdgeQLNode).kind !== "string") {
    return node;
  }
  const expr = node as EdgeQLAST.Expression | EdgeQLAST.EdgeQLNode;
  switch (expr.kind) {
    case "Identifier": {
      const arg = args.get((expr as EdgeQLAST.Identifier).name);
      return arg ? argumentAt(arg, [], depth, options) : expr;
    }
    case "Path": {
      const path = expr as EdgeQLAST.Path;
      const arg = path.rooted ? args.get(path.steps[0].name) : undefined;
      return arg ? argumentAt(arg, path.steps.slice(1), depth, options) : path;
    }
    case "ShapeElement": {
      // A pointer's name is not an expression; a computed's value is.
      const element = expr as EdgeQLAST.ShapeElement;
      const inner = (child: unknown): unknown => child === undefined ? undefined : substitute(child, args, depth, options);
      return {
        ...element,
        expr: element.computable ? inner(element.expr) : element.expr,
        filter: inner(element.filter),
        limit: inner(element.limit),
        offset: inner(element.offset),
        orderBy: inner(element.orderBy),
        shape: inner(element.shape)
      };
    }
    case "WithBinding":
      return { ...expr, value: substitute((expr as EdgeQLAST.WithBinding).value, args, depth, options) };
    case "ForQuery": {
      const query = expr as EdgeQLAST.ForQuery;
      return {
        ...query,
        body: substitute(query.body, args, depth + 1, options),
        iterator: substitute(query.iterator, args, depth + 1, options)
      };
    }
    case "Literal":
    case "Parameter":
    case "GlobalRef":
    case "TypeName":
    case "QualifiedName":
      return expr;
    default: {
      const inner = SCOPE_KINDS.has(expr.kind) ? depth + 1 : depth;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(expr)) {
        result[key] = key === "span" ? value : substitute(value, args, inner, options);
      }
      return result;
    }
  }
}

/*** The argument `arg` where the body uses it, followed by the path `steps` from it. ***/
function argumentAt(arg: EdgeQLAST.Expression, steps: EdgeQLAST.PathStep[], depth: number, options: InlineOptions): EdgeQLAST.Expression {
  const value = steps.length === 0 ? structuredClone(arg) : pathFrom(arg, steps);
  if (depth === 0 || isScopeFree(arg)) {
    return value;
  }
  if (!options.bind) {
    throw new NeedsBinding();
  }
  return options.bind(value);
}

/*** The path `steps` from `arg`: `.author` + `name` is `.author.name`, `(select …)` + `name` is `(select …).name`. ***/
function pathFrom(arg: EdgeQLAST.Expression, steps: EdgeQLAST.PathStep[]): EdgeQLAST.Expression {
  const root = (name: string): EdgeQLAST.Path => ({
    kind: "Path",
    rooted: true,
    steps: [{ kind: "PathStep", name, optional: false, type: "property" }, ...steps]
  });
  switch (arg.kind) {
    case "Path":
      return { ...structuredClone(arg), steps: [...structuredClone(arg.steps), ...steps] };
    case "Identifier":
      return root(arg.name);
    case "TypeName":
      return root(arg.name.parts.join("::"));
    default: {
      // As the parser reads `(select …).name`.
      const binding: EdgeQLAST.WithBinding = { kind: "WithBinding", name: { kind: "Identifier", name: "__path_root__" }, value: structuredClone(arg) };
      return {
        kind: "Subquery",
        query: { bindings: [binding], body: { distinct: false, expr: root("__path_root__"), kind: "SelectQuery" }, kind: "WithBlock" }
      };
    }
  }
}

/**
 * True when `arg` reads the same anywhere: it has no path from the implicit
 * subject (`.name`) outside a scope of its own. A literal, a parameter, a
 * type (`User`), `User.name` or a subquery is; `.name` and `.author ?? x` are not.
 */
function isScopeFree(arg: unknown): boolean {
  if (Array.isArray(arg)) {
    return arg.every(isScopeFree);
  }
  if (arg === null || typeof arg !== "object") {
    return true;
  }
  const node = arg as EdgeQLAST.EdgeQLNode;
  if (node.kind === "Path") {
    return (node as EdgeQLAST.Path).rooted === true;
  }
  if (SCOPE_KINDS.has(node.kind) || node.kind === "Detached") {
    return true;
  }
  return Object.entries(node).every(([key, value]) => key === "span" || isScopeFree(value));
}

/*** The type of `expr` when the AST alone tells it: a literal, a cast, a type, a declared or built-in call. ***/
export function syntacticType(expr: EdgeQLAST.Expression, schema: Schema): string | null {
  switch (expr.kind) {
    case "Literal":
      return LITERAL_TYPES.get(expr.type) ?? null;
    case "TypeCast":
      return renderEdgeQLTypeName(expr.type);
    case "TypeName": {
      const name = expr.name.parts.join("::");
      return schema.types.get(bareTypeName(name))?.kind === "object" ? name : null;
    }
    case "UnaryOp":
      return expr.op === "-" || expr.op === "+" ? syntacticType(expr.operand, schema) : expr.op === "NOT" ? "bool" : null;
    case "FunctionCall": {
      const def = lookupFunction(schema, expr.name.parts);
      const type = def?.declared?.length === 1 ? def.declared[0].returnType : def?.declared ? null : def?.returnType;
      return type && !/any/.test(type) ? type : null;
    }
    default:
      return null;
  }
}

/**
 * The schema's function declarations Gel rejects, as Gel words it, one
 * `  • …` line each; null when there are none: a `set of` parameter, two
 * overloads of one signature, and a function that calls itself, directly or
 * through others (inlining one would not end).
 */
export function detectFunctionErrors(schema: Schema): string | null {
  const errors: string[] = [];
  const declared = [...schema.functions.values()].flatMap(def => def.declared ?? []);
  const signatures = new Set<string>();
  for (const fn of declared) {
    if (fn.parameters.some(parameter => parameter.typemod === "setof")) {
      errors.push(
        `cannot create the \`${functionSignature(fn, "long", schema)}\` function: SET OF parameters in user-defined EdgeQL functions are not supported`
      );
    }
    const signature = `${fn.name}(${fn.parameters.map(p => `${p.namedOnly ? `${p.name}:` : ""}${bareTypeName(p.type, fn.module)}`).join(",")})`;
    if (signatures.has(signature)) {
      errors.push(`cannot create the \`${functionSignature(fn, "long", schema)}\` function: a function with the same signature is already defined`);
    }
    signatures.add(signature);
  }

  // Each function's callees; a cycle through them is reported once, at the first function on it.
  const callees = new Map(declared.map(fn => [fn, calledFunctions(fn, schema)]));
  const reported = new Set<DeclaredFunction>();
  for (const fn of declared) {
    const cycle = findCycle(fn, callees, [fn]);
    if (!cycle || cycle.some(member => reported.has(member))) {
      continue;
    }
    cycle.forEach(member => reported.add(member));
    errors.push(
      cycle.length === 1 ?
        `function '${functionSignature(fn, "short")}' is defined recursively` :
        `definition dependency cycle between function '${functionSignature(cycle[cycle.length - 1], "short")}' and function '${functionSignature(fn, "short")}'`
    );
  }
  return errors.length > 0 ? errors.map(error => `  • ${error}`).join("\n") : null;
}

/*** The functions on a path of calls from `path`'s last back to `path[0]`, or null when there is none. ***/
function findCycle(start: DeclaredFunction, callees: Map<DeclaredFunction, DeclaredFunction[]>, path: DeclaredFunction[]): DeclaredFunction[] | null {
  for (const callee of callees.get(path[path.length - 1]) ?? []) {
    if (callee === start) {
      return path;
    }
    if (!path.includes(callee)) {
      const cycle = findCycle(start, callees, [...path, callee]);
      if (cycle) {
        return cycle;
      }
    }
  }
  return null;
}

/*** The declared functions `fn`'s body calls (every overload of each name it calls). ***/
function calledFunctions(fn: DeclaredFunction, schema: Schema): DeclaredFunction[] {
  const called: DeclaredFunction[] = [];
  rewrite(new EdgeQLParser(fn.body).parseExpressionOnly(), node => {
    if (node.kind === "FunctionCall") {
      called.push(...lookupFunction(schema, (node as EdgeQLAST.FunctionCall).name.parts)?.declared ?? []);
    }
    return undefined;
  });
  return called;
}

/*** Gel's error for a call no overload takes, with the overloads as its hint. ***/
function noSuchFunction(
  call: EdgeQLAST.FunctionCall,
  argTypes: (string | null)[],
  overloads: DeclaredFunction[],
  schema: Schema
): CompilationError {
  const args = call.args.map((arg, index) => {
    const type = qualifiedTypeName(argTypes[index] ?? "anytype", "default", schema);
    return arg.name !== undefined ? `NAMED ONLY ${arg.name}: ${type}` : `arg${positionalIndex(call.args, index)}: ${type}`;
  });
  const candidates = overloads.map(fn => `${fn.name}(${fn.parameters.map(p => parameterSignature(p, fn.module, schema)).join(", ")})`);
  const hint = candidates.length === 1 ?
    `Did you want "${candidates[0]}"?` :
    `Did you want one of the following functions instead:\n${candidates.toReversed().join("\n")}`;
  return new CompilationError(`function "${call.name.parts.join("::")}(${args.join(", ")})" does not exist`, { hint });
}

/*** `sep: std::str`, `NAMED ONLY sep: std::str=','`, `name: OPTIONAL std::str='world'`. ***/
function parameterSignature(parameter: DeclaredParameter, module: string, schema: Schema): string {
  const qualifier = parameter.namedOnly ? "NAMED ONLY " : "";
  const typemod = parameter.typemod === "optional" ? "OPTIONAL " : parameter.typemod === "setof" ? "SET OF " : "";
  const fallback = parameter.default !== undefined ? `=${parameter.default}` : "";
  return `${qualifier}${parameter.name}: ${typemod}${qualifiedTypeName(parameter.type, module, schema)}${fallback}`;
}

/**
 * A function's signature as Gel writes it in a schema error: `short` is the
 * DDL's (`default::f(x: int64)`), `long` the one naming each type's module
 * (`default::f(x: std::int64)`).
 */
export function functionSignature(fn: DeclaredFunction, form: "long" | "short", schema?: Schema): string {
  const parameters = fn.parameters.map(parameter => {
    if (form === "short") {
      return `${parameter.name}: ${parameter.type}`;
    }
    const typemod = parameter.typemod === "setof" ? "SET OF " : parameter.typemod === "optional" ? "OPTIONAL " : "";
    return `${parameter.name}: ${typemod}${qualifiedTypeName(parameter.type, fn.module, schema)}`;
  });
  return `${fn.name}(${parameters.join(", ")})`;
}

/*** `str` as `std::str`, `User` as `default::User`, `array<str>` as `array<std::str>`. ***/
function qualifiedTypeName(type: string, module: string, schema?: Schema): string {
  return type.replace(/[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*/g, name => {
    if (name.includes("::") || name === "array" || name === "tuple" || name === "range" || name === "multirange" || name === "anytype") {
      return name;
    }
    const declared = schema?.types.get(name) ?? schema?.types.get(`${module}::${name}`);
    if (declared || schema?.scalars?.has(name)) {
      return `${declared?.module ?? module}::${name}`;
    }
    return `std::${name}`;
  });
}

/**
 * `node` with each node `replace` returns a replacement for replaced (not
 * visited further), and the others rebuilt from their rewritten children —
 * or kept as they are when none of those changed.
 */
function rewrite(node: unknown, replace: (node: EdgeQLAST.EdgeQLNode) => unknown): unknown {
  if (Array.isArray(node)) {
    const children = node.map(child => rewrite(child, replace));
    return children.every((child, index) => child === node[index]) ? node : children;
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  if (typeof (node as EdgeQLAST.EdgeQLNode).kind === "string") {
    const replaced = replace(node as EdgeQLAST.EdgeQLNode);
    if (replaced !== undefined) {
      return replaced;
    }
  }
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = key === "span" ? value : rewrite(value, replace);
    changed ||= result[key] !== value;
  }
  return changed ? result : node;
}
