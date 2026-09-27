/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Path layer: a path over links as the set of objects it reaches.
 *
 * `User.posts`, `.posts.comments` and `.<author[is Post]` each stand for a
 * set of distinct objects. The set is compiled to the SQL that selects their
 * ids, one hop at a time from where the path starts:
 *
 *   User.posts.comments
 *   → SELECT j2.target_id FROM post_comments j2 WHERE j2.source_id IN
 *       (SELECT j1.target_id FROM user_posts j1 WHERE j1.source_id IN
 *         (SELECT u.id FROM "user" u))
 *
 * Membership (`IN`) rather than joins keeps each object once, however many
 * paths reach it, which is Gel's semantics for a path over links. A select
 * of the path reads the reached type's table filtered to those ids, so a
 * shape, filter, order by and limit apply to the objects themselves.
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError, InvalidReferenceError } from "../lib/errors.ts";
import { backlinkIntersectionName, locationOf } from "./compiler-base.ts";
import { ExpressionCompilerLayer } from "./compiler-expressions.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

/*** Where a path starts: one row whose columns are an object's, or a set of objects. ***/
type PathStart =
  | { kind: "row"; row: Context.TableAlias; }
  | { kind: "type"; }
  | { kind: "binding"; cte: Context.CTEAlias; };

/*** One step of a path from one object type to another. ***/
interface PathHop {
  /** A link of the step's source type (`.posts`), or of the target type pointing back (`.<author[is Post]`). */
  kind: "link" | "backlink";
  link: Context.LinkDef;
  target: Context.TypeDef;
}

/*** A path resolved against the schema and the scope, before any SQL is emitted. ***/
export interface ResolvedPath {
  start: PathStart;
  /** The type the path starts from. */
  startType: Context.TypeDef;
  hops: PathHop[];
  /** The type of the objects the path reaches. */
  typeDef: Context.TypeDef;
  /** The property of those objects the path ends in (`.posts.title`), if any. */
  property?: Context.PropertyDef;
  /** More than one object (or value) per start row: the start is a set, or a hop is multi. */
  multi: boolean;
}

/*** The ids of a path's objects: one value (compared with `=`) or a select of them (`IN`). ***/
type PathIds = { value: SQL.SQLExpression; } | { select: SQL.SelectStatement; };

/*** A path's objects as a row source: its FROM and the condition keeping the path's rows. ***/
export interface PathSource {
  alias: string;
  from: SQL.TableReference[];
  where?: SQL.SQLExpression;
}

export abstract class PathCompilerLayer extends ExpressionCompilerLayer {
  /**
   * Resolve `path` to where it starts and the links it follows, or null when
   * it is not a path over objects this layer compiles: no object to start
   * from, a step that is neither a link nor (last) a property, a link
   * property, or a tuple field.
   */
  protected resolvePath(path: EdgeQLAST.Path): ResolvedPath | null {
    path = this.spliceExpressionLinks(path);
    if (path.steps.length === 0 || path.steps.some(step => step.type === "link_property")) {
      return null;
    }
    const origin = this.pathOrigin(path);
    if (!origin) {
      return null;
    }

    const hops: PathHop[] = [];
    let typeDef = origin.startType;
    let multi = origin.start.kind !== "row";
    for (const [index, step] of origin.steps.entries()) {
      const last = index === origin.steps.length - 1;
      if (step.type === "property" && last) {
        const property = typeDef.properties.get(step.name);
        if (property) {
          return { hops, multi: multi || property.multi, property, start: origin.start, startType: origin.startType, typeDef };
        }
      }
      const hop = this.resolveHop(typeDef, step);
      if (!hop) {
        return null;
      }
      hops.push(hop);
      multi = multi || hop.kind === "backlink" || hop.link.multi || !hop.link.columnName;
      typeDef = hop.target;
    }
    return { hops, multi, start: origin.start, startType: origin.startType, typeDef };
  }

  /**
   * `path` with each step through a computed link whose expression is a
   * relative path (`auth := .author`, `bf := .author.best_friend`) replaced
   * by that path's steps, so `.auth.name` compiles as `.author.name`. Other
   * computed links (`(select …)`) stay as they are.
   */
  protected spliceExpressionLinks(path: EdgeQLAST.Path): EdgeQLAST.Path {
    const origin = this.pathOrigin(path);
    if (!origin) {
      return path;
    }
    const steps = this.spliceSteps(origin.startType, origin.steps);
    return steps === origin.steps ? path : { ...path, steps: [...path.steps.slice(0, path.steps.length - origin.steps.length), ...steps] };
  }

  private spliceSteps(start: Context.TypeDef, steps: EdgeQLAST.PathStep[]): EdgeQLAST.PathStep[] {
    const out: EdgeQLAST.PathStep[] = [];
    let typeDef: Context.TypeDef | undefined = start;
    for (const step of steps) {
      const link: Context.LinkDef | undefined = step.type === "property" ? typeDef?.links.get(step.name) : undefined;
      const expr = link && Context.isExpressionLink(link) ? new EdgeQLParser(link.computedExpr).parseExpressionOnly() : undefined;
      if (typeDef && expr?.kind === "Path" && !expr.rooted) {
        out.push(...this.spliceSteps(typeDef, expr.steps));
      } else {
        out.push(step);
      }
      const next: string | null | undefined = step.type === "type_intersection" ?
        step.name :
        step.type === "backlink" ?
        backlinkIntersectionName(step.filter) :
        link?.target;
      typeDef = next ? Context.resolveTypeName(this.ctx, next) : undefined;
    }
    return out.length === steps.length && out.every((step, index) => step === steps[index]) ? steps : out;
  }

  /*** True when `path` reaches objects through at least one link, or from a type or a binding (not a property, not just the current row). ***/
  protected isObjectPath(path: EdgeQLAST.Path): boolean {
    const resolved = this.resolvePath(path);
    return resolved !== null && !resolved.property && (resolved.hops.length > 0 || resolved.start.kind !== "row");
  }

  /**
   * True when `expr` is a path whose value is a set with no column of its own
   * — a path over multi links or backlinks, or a path from a type or a `with`
   * binding — so an aggregate or `exists` over it reads the rows of a select
   * of the path.
   */
  protected isSetPath(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind !== "Path") {
      return false;
    }
    const resolved = this.resolvePath(expr);
    return resolved !== null && resolved.multi;
  }

  /*** The property `path` ends in, when it resolves to a path over objects ending in one. ***/
  protected pathProperty(path: EdgeQLAST.Path): Context.PropertyDef | undefined {
    return this.resolvePath(path)?.property;
  }

  /**
   * The rows a select of `resolved` reads, registered in the current scope
   * under the reached type so the select's shape, filter and order by resolve
   * against them. A path that follows no link from a row is that row itself
   * (no FROM); one from a type or a binding with no link is its table.
   */
  protected compilePathSource(resolved: ResolvedPath): PathSource {
    const { start, typeDef } = resolved;
    // A path through an abstract type reads its table (and the junctions of
    // its multi links) like any other; the reads become ones of its concrete
    // subtypes' tables, where its objects live (see restrictObjectReads).
    let source: PathSource;
    if (resolved.hops.length === 0 && start.kind === "row") {
      source = { alias: start.row.alias, from: [] };
    } else if (resolved.hops.length === 0 && start.kind === "binding") {
      start.cte.referenced = true;
      const alias = Context.generateAlias(this.ctx, start.cte.cteName);
      source = { alias, from: [SQL.createTableReference(start.cte.cteName, alias)] };
    } else {
      const alias = Context.generateAlias(this.ctx, typeDef.tableName);
      source = { alias, from: [SQL.createTableReference(typeDef.tableName, alias)] };
      if (resolved.hops.length > 0) {
        source.where = this.idIn(SQL.createColumnReference("id", alias), this.compilePathIds(resolved));
      }
    }
    this.ctx.currentScope.aliases.set(typeDef.name.replace(/::/g, "_").toLowerCase(), {
      alias: source.alias,
      table: typeDef.tableName,
      type: typeDef.name
    });
    return source;
  }

  /**
   * Bind the object prefix of a selected path (`Order.items` of
   * `select Order.items.name`, `Item` of `select Item.name`) to the objects
   * the select reads from `alias` (see `bindSubject`). A relative path, or
   * one through a backlink or a type intersection, binds nothing.
   */
  protected bindPathSubject(path: EdgeQLAST.Path, resolved: ResolvedPath, alias: string): void {
    const steps = resolved.property ? path.steps.slice(0, -1) : path.steps;
    if (!path.rooted || steps.slice(1).some(step => step.type !== "property") || (resolved.start.kind === "row" && resolved.hops.length === 0)) {
      return;
    }
    this.bindSubject([steps.map(step => step.name).join(".")], { alias, table: resolved.typeDef.tableName, type: resolved.typeDef.name });
  }

  /**
   * The select of the ids or values the right operand of `in` stands for,
   * when it is a set with no one SQL value: a type's objects (`x in Item`),
   * or a path to several objects or values (`x in o.items`,
   * `n in o.items.name`). Else null.
   */
  protected membershipSelect(expr: EdgeQLAST.Expression): SQL.SelectStatement | null {
    if (expr.kind === "TypeName") {
      const name = expr.name.parts.join("::");
      const typeDef = this.scopeVariable(name) ? undefined : Context.resolveTypeName(this.ctx, name);
      return typeDef?.kind === "object" ? this.selectColumn(typeDef.tableName, Context.generateAlias(this.ctx, typeDef.tableName), "id") : null;
    }
    const resolved = expr.kind === "Path" ? this.resolvePath(expr) : null;
    if (!resolved?.multi || resolved.property?.computed) {
      return null;
    }
    Context.pushScope(this.ctx);
    try {
      const source = this.compilePathSource(resolved);
      const { property } = resolved;
      let value: SQL.SQLExpression = SQL.createColumnReference(property ? property.columnName : "id", source.alias);
      let where = source.where;
      if (property?.multi) {
        value = SQL.createFunctionCall("unnest", [value]);
      } else if (property && !property.required) {
        // An object without the property adds no element (`NOT IN` a NULL is never true).
        where = where ? SQL.createBinaryExpression("AND", where, SQL.isNotNull(value)) : SQL.isNotNull(value);
      }
      return SQL.createSelectStatement({
        from: SQL.createFromClause(source.from),
        select: SQL.createSelectClause([SQL.createSelectItem(value)]),
        where: where ? SQL.createWhereClause(where) : undefined
      });
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /*** The ids of the objects `resolved` reaches, built hop by hop from its start. ***/
  private compilePathIds(resolved: ResolvedPath): PathIds {
    let ids: PathIds;
    let row: string | undefined;
    const { start } = resolved;
    if (start.kind === "row") {
      ids = { value: SQL.createColumnReference("id", start.row.alias) };
      row = start.row.alias;
    } else if (start.kind === "binding") {
      start.cte.referenced = true;
      ids = { select: this.selectColumn(start.cte.cteName, Context.generateAlias(this.ctx, start.cte.cteName), "id") };
    } else {
      ids = { select: this.selectColumn(resolved.startType.tableName, Context.generateAlias(this.ctx, resolved.startType.tableName), "id") };
    }

    let source = resolved.startType;
    for (const [index, hop] of resolved.hops.entries()) {
      ids = this.compileHop(source, hop, ids, row);
      // A hop yields its targets' ids from a link column or a junction row,
      // without reading the targets. Before the next hop, keep only those the
      // select policy shows: a hidden object passes nothing on. (The last
      // hop's objects are read from their table, where the policy applies.)
      if (index < resolved.hops.length - 1 && this.selectPolicyFilter(hop.target)) {
        const alias = Context.generateAlias(this.ctx, hop.target.tableName);
        const visible = this.selectColumn(hop.target.tableName, alias, "id");
        visible.where = SQL.createWhereClause(this.idIn(SQL.createColumnReference("id", alias), ids));
        ids = { select: visible };
      }
      row = undefined;
      source = hop.target;
    }
    return ids;
  }

  /*** The ids one hop reaches from the objects `ids` of type `source` (the row `row`, when the path starts at one). ***/
  private compileHop(source: Context.TypeDef, hop: PathHop, ids: PathIds, row: string | undefined): PathIds {
    const { link } = hop;
    if (hop.kind === "backlink") {
      if (link.junctionTable) {
        const alias = Context.generateAlias(this.ctx, `__bj_${link.name}`);
        return this.junctionHop(link.junctionTable, alias, link.junctionTargetColumn ?? "target_id", link.junctionSourceColumn ?? "source_id", ids);
      }
      const alias = Context.generateAlias(this.ctx, `__b_${link.name}`);
      return this.tableHop(hop.target.tableName, alias, link.columnName!, "id", ids);
    }

    if (link.columnName) {
      // A single link is a column of the source row: read it there when the
      // path starts at that row, else through the source's table.
      if (row) {
        return { value: SQL.createColumnReference(link.columnName, row) };
      }
      const alias = Context.generateAlias(this.ctx, `__f_${link.name}`);
      return this.tableHop(source.tableName, alias, "id", link.columnName, ids);
    }
    if (link.junctionTable) {
      const alias = Context.generateAlias(this.ctx, `__j_${link.name}`);
      return this.junctionHop(link.junctionTable, alias, link.junctionSourceColumn ?? "source_id", link.junctionTargetColumn ?? "target_id", ids);
    }
    // A computed backlink (`multi posts := .<author[is Post]`): the target's
    // forward link holds the source's id.
    const forward = link.backlink ? hop.target.links.get(link.backlink) : undefined;
    if (forward?.columnName) {
      const alias = Context.generateAlias(this.ctx, `__b_${link.name}`);
      return this.tableHop(hop.target.tableName, alias, forward.columnName, "id", ids);
    }
    throw new CompilationError(`Link '${source.name}.${link.name}' cannot be followed in a path: it has no column, junction table or backlink`);
  }

  /*** `SELECT a.<out> FROM <table> a WHERE a.<match> IN/= <ids>`. ***/
  private tableHop(table: string, alias: string, match: string, out: string, ids: PathIds): PathIds {
    const select = this.selectColumn(table, alias, out);
    select.where = SQL.createWhereClause(this.idIn(SQL.createColumnReference(match, alias), ids));
    return { select };
  }

  private junctionHop(junction: string, alias: string, from: string, to: string, ids: PathIds): PathIds {
    return this.tableHop(junction, alias, from, to, ids);
  }

  private selectColumn(table: string, alias: string, column: string): SQL.SelectStatement {
    return SQL.createSelectStatement({
      from: SQL.createFromClause([SQL.createTableReference(table, alias)]),
      select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference(column, alias))])
    });
  }

  private idIn(column: SQL.SQLExpression, ids: PathIds): SQL.SQLExpression {
    return "value" in ids ?
      SQL.createBinaryExpression("=", column, ids.value) :
      SQL.createBinaryExpression("IN", column, SQL.createSubqueryExpression(ids.select));
  }

  /**
   * Where `path` starts and the steps that follow. A rooted path
   * (`User.posts`, `u.posts`, `x.name`) starts at a `for` variable over
   * objects, an object `with` binding or an object type, in that order; a
   * relative one (`.posts`) at the implicit subject.
   */
  private pathOrigin(path: EdgeQLAST.Path): { start: PathStart; startType: Context.TypeDef; steps: EdgeQLAST.PathStep[]; } | null {
    if (path.rooted) {
      const [root, ...steps] = path.steps;
      // A `for` variable, or a bound subject (`Item`, `Order.items`).
      const bound = this.boundPrefix(path);
      if (bound) {
        const startType = Context.resolveTypeName(this.ctx, bound.row.type);
        return startType ? { start: { kind: "row", row: bound.row }, startType, steps: bound.steps } : null;
      }
      if (this.scopeVariable(root.name)) {
        return null;
      }
      const cte = Context.getCTEAlias(this.ctx, root.name);
      if (cte) {
        return cte.typeDef ? { start: { cte, kind: "binding" }, startType: cte.typeDef, steps } : null;
      }
      const typeDef = Context.resolveTypeName(this.ctx, root.name);
      return typeDef?.kind === "object" ? { start: { kind: "type" }, startType: typeDef, steps } : null;
    }

    const subject = this.implicitSubject(path.steps[0]);
    const startType = subject ? Context.resolveTypeName(this.ctx, subject.type) : undefined;
    return subject && startType ? { start: { kind: "row", row: subject }, startType, steps: path.steps } : null;
  }

  /**
   * The row a relative path starts from: in the innermost scope that has
   * one, the table alias whose type has `step` as a link or property (the
   * first alias for a backlink, or when none has it). A select of a
   * relative path pushes an empty scope, so its path starts from the
   * enclosing shape's or statement's row.
   */
  protected implicitSubject(step: EdgeQLAST.PathStep): Context.TableAlias | undefined {
    for (const scope of [this.ctx.currentScope, ...[...this.ctx.scopes].reverse()]) {
      const aliases = [...scope.aliases.values()];
      if (aliases.length === 0) {
        continue;
      }
      if (step.type === "property") {
        const owner = aliases.find(alias => {
          const typeDef = Context.resolveTypeName(this.ctx, alias.type);
          return typeDef?.links.has(step.name) || typeDef?.properties.has(step.name);
        });
        if (owner) {
          return owner;
        }
      }
      return aliases[0];
    }
    return undefined;
  }

  /*** The hop `step` takes from objects of type `source`, or null when it is not a link step. ***/
  private resolveHop(source: Context.TypeDef, step: EdgeQLAST.PathStep): PathHop | null {
    if (step.type === "property") {
      const link = source.links.get(step.name);
      const target = link ? Context.resolveTypeName(this.ctx, link.target) : undefined;
      return link && target ? { kind: "link", link, target } : null;
    }
    if (step.type !== "backlink") {
      return null;
    }

    const intersection = backlinkIntersectionName(step.filter);
    if (!intersection) {
      throw new CompilationError(
        `Backlink '.<${step.name}' without a type intersection (e.g. \`.<${step.name}[is SomeType]\`) is not yet supported`,
        locationOf(step)
      );
    }
    const target = Context.resolveTypeName(this.ctx, intersection);
    if (!target) {
      throw new InvalidReferenceError(`Backlink intersection target '${intersection}' not found in schema`, locationOf(step));
    }
    const link = target.links.get(step.name);
    if (!link || (!link.columnName && !link.junctionTable)) {
      throw new CompilationError(
        `Type '${target.name}' has no stored link '${step.name}' for the backlink '.<${step.name}[is ${intersection}]'`,
        locationOf(step)
      );
    }
    // The link leads back when it can hold objects of `source`: it targets
    // `source`, a type `source` extends (a policy inherited from an abstract
    // type, compiled for each subtype), or a subtype of it.
    const linkTarget = Context.resolveTypeName(this.ctx, link.target);
    const related = (from: string, to: string): boolean => Context.getTypeHierarchy(this.ctx.schema, from).includes(to);
    if (linkTarget && !related(source.name, linkTarget.name) && !related(linkTarget.name, source.name)) {
      throw new CompilationError(
        `Link '${target.name}.${step.name}' targets '${linkTarget.name}', not '${source.name}' — the backlink does not lead back from '${source.name}'`,
        locationOf(step)
      );
    }
    return { kind: "backlink", link, target };
  }
}
