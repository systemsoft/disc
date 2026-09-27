/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A user scalar's constraints as Gel checks them: each as an EdgeQL boolean
 * over the subject, and the violation Gel reports. Shared by the migration
 * differ, which makes them the CHECKs of the columns holding the scalar, and
 * the runtime schema, whose `scalarChecks` a cast to the scalar checks
 * (compiler `scalarCastCheck`).
 */

import { SUBJECT_PARAMETER } from "../compiler/compiler.ts";
import type { ScalarCheck } from "../compiler/context.ts";
import * as AST from "../schema/ast.ts";
import { sdlExpressionToEdgeQL } from "../schema/expression-printer.ts";

/*** The parameter each scalar constraint's `errmessage` names (Gel's: `{min}`, `{pattern}`, …). ***/
const SCALAR_CONSTRAINT_PARAMS = new Map([
  ["max_ex_value", "max"],
  ["max_len_value", "max"],
  ["max_value", "max"],
  ["min_ex_value", "min"],
  ["min_len_value", "min"],
  ["min_value", "min"],
  ["one_of", "vals"],
  ["regexp", "pattern"]
]);

/*** The constraints `scalarConstraintEdgeQL` reads. ***/
const CHECKABLE = new Set([...SCALAR_CONSTRAINT_PARAMS.keys(), "expression"]);

/*** A constraint argument as Gel shows it in a message: `0`, `-1`, `'a'`. ***/
function argRepr(arg: AST.Expression): string {
  if (arg.kind === "Literal") {
    return arg.type === "string" ? `'${arg.value}'` : String(arg.value);
  }
  if (arg.kind === "UnaryOp" && arg.op === "-" && arg.operand.kind === "Literal") {
    return `-${arg.operand.value}`;
  }
  return sdlExpressionToEdgeQL(arg);
}

/*** Gel's default message for a violated scalar constraint (`shown` is its parameter as `argRepr` shows it). ***/
function defaultMessage(kind: string, scalar: string, shown: string): string {
  switch (kind) {
    case "min_value":
      return `Minimum allowed value for ${scalar} is ${shown}.`;
    case "max_value":
      return `Maximum allowed value for ${scalar} is ${shown}.`;
    case "min_ex_value":
      return `${scalar} must be greater than ${shown}.`;
    case "max_ex_value":
      return `${scalar} must be less than ${shown}.`;
    case "min_len_value":
      return `${scalar} must be no shorter than ${shown} characters.`;
    case "max_len_value":
      return `${scalar} must be no longer than ${shown} characters.`;
    case "one_of":
      return `${scalar} must be one of: ${shown}.`;
    default:
      return `invalid ${scalar}`;
  }
}

/*** The message Gel reports when `constraint` of the scalar named `scalar` fails: its `errmessage`, filled in, or Gel's default. ***/
export function scalarConstraintMessage(constraint: AST.Constraint, scalar: string): string {
  const kind = constraint.name?.value ?? "unnamed";
  const args = constraint.args ?? [];
  const param = SCALAR_CONSTRAINT_PARAMS.get(kind);
  const shown = kind === "one_of" ? `[${args.map(argRepr).join(", ")}]` : args[0] ? argRepr(args[0]) : "";
  return constraint.errmessage === undefined ?
    defaultMessage(kind, scalar, shown) :
    constraint.errmessage.replaceAll("{__subject__}", () => scalar).replaceAll(`{${param}}`, () => shown);
}

/**
 * A scalar constraint as an EdgeQL boolean over the subject `$__subject__`
 * (cast to the scalar's `base` type), as Gel defines each: `min_value(m)` is
 * `__subject__ >= m`, `regexp(p)` is `re_test(p, __subject__)`, … .
 */
export function scalarConstraintEdgeQL(constraint: AST.Constraint, base: string): string {
  const subject = `<${base}>$${SUBJECT_PARAMETER}`;
  const args = (constraint.args ?? []).map(sdlExpressionToEdgeQL);

  switch (constraint.name?.value) {
    case "min_value":
      return `${subject} >= ${args[0]}`;
    case "max_value":
      return `${subject} <= ${args[0]}`;
    case "min_ex_value":
      return `${subject} > ${args[0]}`;
    case "max_ex_value":
      return `${subject} < ${args[0]}`;
    case "min_len_value":
      return `len(${subject}) >= ${args[0]}`;
    case "max_len_value":
      return `len(${subject}) <= ${args[0]}`;
    case "regexp":
      return `re_test(${args[0]}, ${subject})`;
    case "one_of":
      return `${subject} in {${args.join(", ")}}`;
    case "expression":
      return sdlExpressionToEdgeQL(
        AST.replaceSubject(constraint.on!, {
          expr: { kind: "Parameter", name: SUBJECT_PARAMETER },
          kind: "TypeCast",
          type: AST.createTypeRef(AST.createQualifiedName(base.split("::")))
        })
      );
    default:
      throw new Error(`constraint '${constraint.name?.value}' is not supported on a scalar type`);
  }
}

/**
 * The checks of each non-enum user scalar in `modules` that has constraints,
 * its own and those of the scalars it extends, nearest first (Gel reports a
 * constraint as its declaring scalar's). Keyed as `Schema.scalars` is:
 * qualified, and bare for the default module's (or a name only one module
 * declares). A scalar with a constraint `scalarConstraintEdgeQL` does not
 * read is left out; the migration reports it.
 */
export function scalarChecksOf(modules: { name: string; items: AST.Declaration[]; }[]): Map<string, ScalarCheck[]> {
  const decls = new Map<string, { decl: AST.ScalarTypeDeclaration; module: string; }>();
  for (const module of modules) {
    for (const item of module.items) {
      if (item.kind === "ScalarTypeDeclaration") {
        decls.set(`${module.name}::${(item as AST.ScalarTypeDeclaration).name.value}`, { decl: item as AST.ScalarTypeDeclaration, module: module.name });
      }
    }
  }

  const checks = new Map<string, ScalarCheck[]>();
  for (const [key, { module }] of decls) {
    const chain: { decl: AST.ScalarTypeDeclaration; key: string; module: string; }[] = [];
    let next: string | undefined = key;
    while (next !== undefined && decls.has(next) && !chain.some(entry => entry.key === next)) {
      const entry: { decl: AST.ScalarTypeDeclaration; module: string; } = decls.get(next)!;
      chain.push({ ...entry, key: next });
      const base: string | undefined = entry.decl.extending?.[0]?.name.parts.join("::");
      next = base === undefined ?
        undefined :
        base.includes("::") ?
        base :
        [`${entry.module}::${base}`, `default::${base}`].find(candidate => decls.has(candidate));
    }
    const root = chain.at(-1)?.decl.extending?.[0]?.name.parts.join("::");
    if (!root || root === "sequence" || root.startsWith("enum") || decls.has(root)) {
      continue;
    }
    const constraints = chain.flatMap(({ decl, key: scalarKey, module: scalarModule }) =>
      (decl.constraints ?? []).map(constraint => ({ constraint, decl, scalarKey, scalarModule }))
    );
    if (constraints.length === 0 || constraints.some(({ constraint }) => !CHECKABLE.has(constraint.name?.value ?? ""))) {
      continue;
    }
    const own = constraints.map(({ constraint, decl, scalarKey, scalarModule }) => ({
      detail: `violated constraint 'std::${constraint.name!.value}' on scalar type '${scalarKey}'`,
      edgeql: scalarConstraintEdgeQL(constraint, root),
      message: scalarConstraintMessage(constraint, decl.name.value),
      module: scalarModule
    }));
    const name = key.slice(module.length + 2);
    checks.set(key, own);
    if (module === "default" || !checks.has(name)) {
      checks.set(name, own);
    }
  }
  return checks;
}
