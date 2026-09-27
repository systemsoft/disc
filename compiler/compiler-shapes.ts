/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Shape compilation layer: select queries and expressions, shapes, splats,
 * polymorphic selects, link references, and path expression compilation
 * for the EdgeQL compiler.
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError, InvalidReferenceError } from "../lib/errors.ts";
import { propNameToColumnName } from "../lib/identifiers.ts";
import {
  backlinkIntersectionName,
  compileEmptyOrder,
  detachedOperand,
  edgeqlTypeToPgType,
  flattenSetElements,
  isMutationQuery,
  locationOf,
  renderEdgeQLTypeName
} from "./compiler-base.ts";
import { PathCompilerLayer } from "./compiler-paths.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

/*** A path as written, for error messages: `User.posts`, `.<author[is Post].title`. ***/
function renderPath(path: EdgeQLAST.Path): string {
  return path
    .steps
    .map((step, index) => {
      if (step.type === "backlink") {
        const intersection = backlinkIntersectionName(step.filter);
        return `.<${step.name}${intersection ? `[is ${intersection}]` : ""}`;
      }
      if (step.type === "link_property") {
        return `@${step.name}`;
      }
      if (step.type === "type_intersection") {
        return `[is ${step.name}]`;
      }
      return index === 0 && path.rooted ? step.name : `.${step.name}`;
    })
    .join("");
}

/**
 * The nodes under `node` naming one of `names`, each with the longest name it
 * names: a type (`Order`), a `with` binding (`o`), or the leading steps of a
 * rooted path (`Order.items` of `Order.items.name`). Inside `detached`, a
 * cast's or a mutation's type and a backlink's `[is T]`, a name is not a
 * reference.
 */
function namedPaths(node: unknown, names: Set<string>): { name: string; node: EdgeQLAST.EdgeQLNode; }[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => namedPaths(item, names));
  }
  const candidate = node as { kind?: string; name?: unknown; rooted?: boolean; steps?: EdgeQLAST.PathStep[]; };
  if (candidate.kind === "UnaryOp" && (node as EdgeQLAST.UnaryOp).op === "DETACHED") {
    return [];
  }
  switch (candidate.kind) {
    case "Detached":
    case "PathStep":
      return [];
    case "Identifier": {
      const name = candidate.name as string;
      return names.has(name) ? [{ name, node: node as EdgeQLAST.EdgeQLNode }] : [];
    }
    case "TypeName": {
      const name = (candidate.name as EdgeQLAST.QualifiedName).parts.join("::");
      return names.has(name) ? [{ name, node: node as EdgeQLAST.EdgeQLNode }] : [];
    }
    case "Path": {
      const steps = candidate.steps ?? [];
      for (let length = candidate.rooted ? steps.length : 0; length >= 1; length--) {
        const name = steps.slice(0, length).map(step => step.name).join(".");
        if (names.has(name)) {
          return [{ name, node: node as EdgeQLAST.EdgeQLNode }];
        }
      }
      return [];
    }
  }
  return Object.entries(node).flatMap(([key, value]) => key === "type" ? [] : namedPaths(value, names));
}

/*** CTE name for the anonymous binding of `select (insert|update|delete …) { shape }`. ***/
const MUTATION_CTE_NAME = "m";

export abstract class ShapeCompilerLayer extends PathCompilerLayer {
  // Implemented by the top compiler layer (compiler.ts).
  protected abstract compileSelectQueryRaw(
    query: EdgeQLAST.SelectQuery
  ): SQL.SelectStatement;

  protected compileSelectQuery(
    query: EdgeQLAST.SelectQuery
  ): SQL.SQLStatement {
    // Handle set operations (UNION, INTERSECT, EXCEPT) at the query level
    if (query.expr.kind === "BinaryOp" && this.isSetOperator(query.expr.op)) {
      return this.compileSetOperation(query.expr);
    }

    // `select (insert|update|delete …) { shape }` is the with-form with an
    // anonymous binding: `with m := (…) select m { shape }`. One path, so both
    // spellings get the same data-modifying CTE, the same shape projection over
    // it, and the mutation is compiled by the mutation compilers (policy
    // included) either way.
    // The binding is `m` unless another CTE of the query already has that name.
    if (query.expr.kind === "Subquery" && isMutationQuery(query.expr.query)) {
      const name = this.claimCteName(MUTATION_CTE_NAME);
      return this.compileQuery({
        kind: "WithBlock",
        bindings: [{
          kind: "WithBinding",
          name: { kind: "Identifier", name },
          value: query.expr
        }],
        body: { ...query, expr: { kind: "Identifier", name } }
      });
    }

    // A select of a mutation's result (`select m { … }`, `m.items`,
    // `count(m.items)`) reads the tables the mutation writes as it leaves them.
    const writes = this.writesReadBy(query.expr).filter(write => !this.mutationWrites?.includes(write));
    if (writes.length > 0) {
      return this.readingMutation([...this.mutationWrites ?? [], ...writes], () => this.compileSelectQuery(query));
    }
    // Inside a select of a mutation's result, a select of a type
    // (`select o { n := count((select Item)) }`) reads it as it was before the statement.
    if (this.mutationWrites && this.isTypeRoot(query.expr)) {
      return this.readingSnapshot(() => this.compileSelectQuery(query));
    }

    Context.pushScope(this.ctx);

    try {
      // Handle the main expression and generate appropriate FROM clause
      const { selectItems, fromClause, where } = this.compileSelectExpression(
        query.expr,
        query.shape
      );

      // Compile WHERE clause: the source's own condition (a path's objects)
      // and the filter.
      let whereClause: SQL.WhereClause | undefined;
      const condition = this.compileSubjectFilter(query);
      if (condition) {
        whereClause = SQL.createWhereClause(where ? SQL.createBinaryExpression("AND", where, condition) : condition);
      } else if (where) {
        whereClause = SQL.createWhereClause(where);
      }

      // Compile ORDER BY clause
      let orderByClause: SQL.OrderByClause | undefined;
      if (query.orderBy && query.orderBy.length > 0) {
        const items = query.orderBy.map(item => ({
          kind: "OrderByItem" as const,
          expression: this.compileOrderExpression(item.expr),
          direction: item.direction || "ASC" as "ASC" | "DESC",
          ...compileEmptyOrder(item, this.isNeverEmpty(item.expr))
        }));
        orderByClause = { kind: "OrderByClause", items };
      }

      // Compile LIMIT and OFFSET
      let limitClause: SQL.LimitClause | undefined;
      if (query.limit) {
        limitClause = {
          kind: "LimitClause",
          count: this.compileExpression(query.limit)
        };
      }

      let offsetClause: SQL.OffsetClause | undefined;
      if (query.offset) {
        offsetClause = {
          kind: "OffsetClause",
          count: this.compileExpression(query.offset)
        };
      }

      const selectClause = SQL.createSelectClause(selectItems, query.distinct);

      return SQL.createSelectStatement({
        select: selectClause,
        from: fromClause,
        where: whereClause,
        orderBy: orderByClause,
        limit: limitClause,
        offset: offsetClause
      });
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /**
   * The filter of `query`, compiled after its subject. When the subject is a
   * path through links from a type or a `with` binding and the filter names
   * where it starts (`select Order.items filter Order.code = 'o1'`), the
   * start is, as in Gel's path scoping, the object each element is reached
   * from: the element is kept when some such object passes the filter.
   *
   *   select Order.items filter Order.code = 'o1'
   *   → … WHERE <item_1 is an item of some order> AND EXISTS (SELECT 1 FROM "order" AS order_3
   *        WHERE item_1.id IN (<ids of order_3.items>) AND order_3.code = 'o1')
   *
   * Naming the start in the shape or the order by, or naming a step between
   * the start and the selected objects (`Order.items` of
   * `select Order.items.tags`) anywhere, is not supported yet: a compile
   * error rather than a filter over every order.
   */
  protected compileSubjectFilter(query: EdgeQLAST.SelectQuery): SQL.SQLExpression | undefined {
    const { expr, filter } = query;
    // Where the path starts, as written: not the subject it has just bound.
    const resolved = expr.kind === "Path" && expr.rooted ? this.withDetached(() => this.resolvePath(expr)) : null;
    const steps = expr.kind === "Path" && resolved ? (resolved.property ? expr.steps.slice(0, -1) : expr.steps) : [];
    if (!resolved || resolved.hops.length === 0 || resolved.start.kind === "row" || steps.slice(1).some(step => step.type !== "property")) {
      return filter ? this.compileFilter(filter) : undefined;
    }

    const prefix = (length: number): string => steps.slice(0, length).map(step => step.name).join(".");
    const root = prefix(1);
    const names = new Set(steps.map((_, index) => prefix(index + 1)));
    const clauses: [unknown, string][] = [[query.shape, "shape"], [query.orderBy, "order by"], [filter, "filter"]];
    for (const [node, clause] of clauses) {
      const unsupported = namedPaths(node, names).find(named => named.name !== prefix(steps.length) && (clause !== "filter" || named.name !== root));
      if (unsupported) {
        throw new CompilationError(
          `Naming '${unsupported.name}' in the ${clause} of a select of '${renderPath(expr as EdgeQLAST.Path)}' ` +
            `(a step before the selected objects) is not supported yet; select from it instead ` +
            `(\`select ${root} { … } filter …\`, or a \`for\` over it)`,
          locationOf(unsupported.node) ?? locationOf((unsupported.node as Partial<EdgeQLAST.Path>).steps?.[0])
        );
      }
    }
    if (!filter || !namedPaths(filter, names).some(named => named.name === root)) {
      return filter ? this.compileFilter(filter) : undefined;
    }

    const start = resolved.start;
    const alias = this.scopeVariable(prefix(steps.length))!.row!.alias;
    if (start.kind === "binding") {
      start.cte.referenced = true;
    }
    const table = start.kind === "binding" ? start.cte.cteName : resolved.startType.tableName;
    const row: Context.TableAlias = { alias: Context.generateAlias(this.ctx, table), table, type: resolved.startType.name };
    const variables = this.ctx.currentScope.variables;
    const outer = variables.get(root);
    this.bindSubject([root], row);
    try {
      const reaches = this.pathReaches(resolved, row, alias);
      return {
        kind: "UnaryExpression",
        operand: SQL.createSubqueryExpression(SQL.createSelectStatement({
          from: SQL.createFromClause([SQL.createTableReference(table, row.alias)]),
          select: SQL.createSelectClause([SQL.createSelectItem(SQL.createLiteral("number", 1))]),
          where: SQL.createWhereClause(SQL.createBinaryExpression("AND", reaches, this.compileFilter(filter)))
        })),
        operator: "EXISTS"
      };
    } finally {
      if (outer) {
        variables.set(root, outer);
      } else {
        variables.delete(root);
      }
    }
  }

  /**
   * The data-modifying CTEs of the mutation bindings `expr` reads by name
   * (`m`, `m.items`, `count(m.items)`); none when it reads none. A name a
   * scope variable takes (a `for` variable) is not the binding.
   */
  private writesReadBy(expr: EdgeQLAST.Expression): Context.MutationWrite[] {
    const writes = new Set<Context.MutationWrite>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== "object") {
        return;
      }
      const candidate = node as Partial<EdgeQLAST.Identifier> & Partial<EdgeQLAST.Path>;
      const name = candidate.kind === "Identifier" ?
        candidate.name :
        candidate.kind === "Path" && candidate.rooted ?
        candidate.steps?.[0]?.name :
        undefined;
      const cte = name === undefined ? undefined : Context.getCTEAlias(this.ctx, name);
      const variable = name === undefined ? undefined : this.scopeVariable(name);
      if (cte?.writes && (!variable || variable.row?.table === cte.cteName)) {
        cte.writes.forEach(write => writes.add(write));
      }
      Object.values(node).forEach(visit);
    };
    visit(expr);
    return [...writes];
  }

  private compileSelectExpression(
    expr: EdgeQLAST.Expression,
    shape?: EdgeQLAST.Shape
  ): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
    /** A condition of the source itself, ANDed with the filter: which of the type's rows a path reaches. */
    where?: SQL.SQLExpression;
  } {
    // `select detached T`: T is every object of T, even where T is bound,
    // and naming T in the filter still means the T bound outside.
    const detached = detachedOperand(expr);
    if (detached) {
      const variables = this.ctx.currentScope.variables;
      const outer = new Set(variables.keys());
      const compiled = this.withDetached(() => this.compileSelectExpression(detached, shape));
      [...variables.entries()].filter(([name, variable]) => variable.subject && !outer.has(name)).forEach(([name]) => variables.delete(name));
      return compiled;
    }

    if (expr.kind === "TypeName") {
      // SELECT User -> SELECT * FROM users
      const typeName = expr.name.parts.join("::");
      // The subject of an enclosing statement (`(select Item { … })` inside
      // `select Item { … }`) is its current object, as a `for` variable is.
      const bound = this.scopeVariable(typeName)?.row;
      if (bound) {
        return this.compileSelectExpression(EdgeQLAST.createIdentifier(typeName), shape);
      }
      const typeDef = Context.resolveTypeName(this.ctx, typeName);

      if (!typeDef) {
        // Type not found — check if this is an expression alias
        const aliasDef = Context.resolveAlias(
          this.ctx.schema,
          typeName,
          this.ctx.moduleScope
        );
        if (aliasDef) {
          return this.compileAliasExpression(aliasDef, shape);
        }
        throw new InvalidReferenceError(`Type '${typeName}' not found`);
      }

      // `select <Enum>` enumerates the enum's members as a set of scalars
      // (matching Gel), lowered to `unnest(enum_range(NULL::<pg_enum>))`.
      // There's no physical table, so this must be handled before the
      // object-table path that would emit `FROM account_login_method`.
      if (typeDef.kind === "enum") {
        const sqlType = Context.enumSqlType(typeDef);
        return {
          selectItems: [
            SQL.createSelectItem(
              {
                kind: "RawSQLExpression",
                sql: `unnest(enum_range(NULL::${sqlType}))`
              },
              "value"
            )
          ],
          fromClause: SQL.createFromClause([])
        };
      }

      // A non-enum scalar type has no instances to select.
      if (typeDef.kind !== "object") {
        throw new CompilationError(
          `Cannot select '${typeName}': it is a scalar type, not an object ` +
            `type — there are no rows to select.`
        );
      }

      // Use the canonical name from the resolved TypeDef for property/link
      // lookups, since the schema may store the type under its qualified name
      // (e.g., "other::Foo") even though the query used "Foo".
      const resolvedName = typeDef.name;

      // Polymorphic SELECT: abstract types have no physical table in
      // Disc (the migration engine skips them — see
      // `engine.ts:891`). Lower `SELECT <Abstract>` to a UNION ALL
      // across the concrete subtypes' tables so the FROM clause
      // references real relations. Each branch projects the abstract's
      // own properties; the outer shape and select items reference
      // them via the abstract's alias as if it were a real table.
      if (typeDef.abstract) {
        const polymorphic = this.compilePolymorphicSelect(
          typeDef,
          resolvedName,
          shape,
          [typeName, resolvedName]
        );
        if (polymorphic) {
          return polymorphic;
        }
        // No concrete subtypes — fall through to the regular path which
        // will raise a clearer error than emitting a SELECT against a
        // non-existent abstract table.
      }

      // Use the bare resolved name for the alias key, not the raw input —
      // `default::Item` would otherwise leak `::` into a SQL alias and
      // produce a syntax error.
      const tableAlias = Context.addTableAlias(
        this.ctx,
        resolvedName.toLowerCase(),
        typeDef.tableName,
        resolvedName
      );
      const fromClause = SQL.createFromClause([
        SQL.createTableReference(typeDef.tableName, tableAlias)
      ]);
      this.bindSubject([typeName, resolvedName], { alias: tableAlias, table: typeDef.tableName, type: resolvedName });

      let selectItems: SQL.SelectItem[];
      if (shape) {
        selectItems = this.compileShape(shape, resolvedName, tableAlias);
      } else {
        // Select all columns as JSON object
        selectItems = this.compileImplicitShape(typeDef, tableAlias);
      }

      return { selectItems, fromClause };
    }

    if (expr.kind === "Identifier") {
      // A `for` variable over objects is the iterator's current row: no FROM
      // of its own, the shape reads the row's columns.
      const row = this.scopeVariable(expr.name)?.row;
      const rowType = row ? Context.resolveTypeName(this.ctx, row.type) : undefined;
      if (row && rowType) {
        this.ctx.currentScope.aliases.set(rowType.name.replace(/::/g, "_").toLowerCase(), row);
        return {
          fromClause: SQL.createFromClause([]),
          selectItems: shape ? this.compileShape(shape, rowType.name, row.alias) : this.compileImplicitShape(rowType, row.alias)
        };
      }

      // Check if this identifier references a CTE alias
      const cteAlias = Context.getCTEAlias(this.ctx, expr.name);
      if (cteAlias) {
        cteAlias.referenced = true;

        // The CTE name acts as a virtual table — SELECT FROM the CTE name
        const tableAlias = Context.addTableAlias(
          this.ctx,
          cteAlias.cteName,
          cteAlias.cteName,
          cteAlias.typeName || cteAlias.cteName
        );
        const fromClause = SQL.createFromClause([
          SQL.createTableReference(cteAlias.cteName, tableAlias)
        ]);

        // A binding of values (`with a := array_unpack(…) select a filter a > 1`,
        // `a := (select …)`) stands for the current row's value in this
        // select's filter and order, not for its expression or all its rows
        // again: `UNNEST(…) > 1` in a WHERE is rejected, and `(SELECT * FROM a)`
        // is more than one row. A binding of objects stands for the current
        // object (`select u { name } filter u.name = …`), like a `for` variable.
        const variable = this.scopeVariable(expr.name);
        if (variable && !variable.sqlOverride && !variable.row) {
          this.ctx.currentScope.variables.set(expr.name, { ...variable, sqlOverride: SQL.createColumnReference("value", tableAlias) });
        } else if (!variable && cteAlias.values) {
          this.ctx.currentScope.variables.set(expr.name, {
            expression: expr,
            name: expr.name,
            sqlOverride: SQL.createColumnReference("value", tableAlias),
            type: "any"
          });
        } else if (!variable && cteAlias.typeDef?.kind === "object") {
          this.ctx.currentScope.variables.set(expr.name, {
            expression: expr,
            name: expr.name,
            row: { alias: tableAlias, table: cteAlias.cteName, type: cteAlias.typeDef.name },
            sqlOverride: SQL.createColumnReference("id", tableAlias),
            type: cteAlias.typeDef.name
          });
        }

        let selectItems: SQL.SelectItem[];
        if (shape && cteAlias.typeName && cteAlias.typeDef) {
          // Use the underlying type's schema to compile the shape. The CTE's
          // table alias registered above is the only alias in this select's
          // scope, so the shape's paths (nested links included) resolve
          // against the CTE row — for a select binding and a mutation binding
          // (`RETURNING *`) alike.
          selectItems = this.compileShape(
            shape,
            cteAlias.typeName,
            tableAlias
          );
        } else if (cteAlias.typeDef && !cteAlias.mutation) {
          // No explicit shape — select all columns as JSON object
          selectItems = this.compileImplicitShape(cteAlias.typeDef, tableAlias);
        } else {
          // No type info — select all columns
          selectItems = [
            SQL.createSelectItem(SQL.createColumnReference("*", tableAlias))
          ];
        }

        return { selectItems, fromClause };
      }

      // Check if this identifier references an expression alias
      const aliasDef = Context.resolveAlias(
        this.ctx.schema,
        expr.name,
        this.ctx.moduleScope
      );
      if (aliasDef) {
        return this.compileAliasExpression(aliasDef, shape);
      }
    }

    if (expr.kind === "Path") {
      return this.compilePathExpression(expr, shape);
    }

    if (expr.kind === "SetExpr") {
      return this.compileSetLiteralSource(expr, shape);
    }

    if (expr.kind === "Subquery") {
      // A mutation operand never gets here (see compileSelectQuery). For any
      // other subquery the shape would be dropped without a trace.
      if (shape) {
        throw new CompilationError(
          "A shape on a parenthesized query is only supported for insert, update and delete. " +
            "Put the shape inside the parentheses: select (select T { … } filter …)"
        );
      }

      // `select (select …)` is the inner select's rows, each its own row:
      // as one value (a scalar subquery), more than one row would fail.
      if (expr.query.kind === "SelectQuery") {
        const alias = Context.generateAlias(this.ctx, "__sub");
        return {
          fromClause: SQL.createFromClause([{ alias, kind: "TableReference", name: "", subquery: this.compileQuery(expr.query) }]),
          selectItems: [SQL.createSelectItem(SQL.createColumnReference("*", alias))]
        };
      }

      // Handle subquery
      const subquery = this.compileQuery(expr.query) as SQL.SelectStatement;
      const selectItems = [SQL.createSelectItem({
        kind: "SubqueryExpression",
        query: subquery
      })];

      // Empty FROM clause for subqueries
      const fromClause = SQL.createFromClause([]);
      return { selectItems, fromClause };
    }

    // An element-wise operator, cast or function over a set (`{1, 2} + 1`,
    // `User.name ++ '!'`, `str_upper(User.name)`) is applied to each element:
    // the sets are this select's FROM.
    const sets = this.elementWiseSets(expr);
    if (sets) {
      const { from, value, where } = this.compileElementWise(expr, sets);
      return { fromClause: SQL.createFromClause(from), selectItems: [SQL.createSelectItem(value)], where };
    }

    // `<Type><uuid>expr` compiles to the uuid (it stands for a link target), so
    // there is no row to project a shape from; dropping the shape silently
    // would answer with the wrong thing.
    if (shape && expr.kind === "TypeCast") {
      const castType = expr.type.name.parts.join("::");
      if (Context.resolveTypeName(this.ctx, castType)?.kind === "object") {
        throw new CompilationError(
          `A shape cannot be applied to the object cast <${castType}>…: the cast is only the object's id. ` +
            `Use: select ${castType} { … } filter .id = <uuid>…`
        );
      }
    }

    // For other expressions, compile directly
    const compiledExpr = this.compileExpression(expr);
    const selectItems = [SQL.createSelectItem(compiledExpr)];
    const fromClause = SQL.createFromClause([]); // No FROM clause needed

    return { selectItems, fromClause };
  }

  /**
   * `select {a, b, …}` is the set of its elements — one row each, duplicates
   * kept, nested set literals flattened, `{}` no rows — not one row holding a
   * `(a, b, …)` record. Each element is selected on its own and the selects
   * are joined by UNION ALL in the literal's order, so an element that is a
   * set (`(select User { name } filter …)`) contributes all of its rows and
   * keeps its column (`jsonb_build_object` for a shape). The union is a
   * derived table the outer select's filter, order by, limit and offset apply
   * to as a whole:
   *
   *   select {1, 2} limit 1
   *   → SELECT set_1.* FROM (SELECT 1 UNION ALL SELECT 2) AS set_1 LIMIT 1
   */
  private compileSetLiteralSource(
    set: EdgeQLAST.SetExpr,
    shape?: EdgeQLAST.Shape
  ): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
  } {
    const elements = flattenSetElements(set);
    // Gel has no implicit cast between floats and bigint or decimal, so no
    // common type for the set's elements.
    const numericTypes = elements.map(element => this.staticNumericType(element));
    const float = numericTypes.find(type => type === "float32" || type === "float64");
    const exact = numericTypes.find(type => type === "bigint" || type === "decimal");
    if (float && exact) {
      throw new CompilationError(
        `set constructor has arguments of incompatible types 'std::${float}' and 'std::${exact}'`,
        locationOf(set)
      );
    }
    const branches: SQL.SQLStatement[] = elements.map(element => this.compileSetLiteralElement(element, shape));
    if (branches.length === 0) {
      branches.push(SQL.createSelectStatement({
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createLiteral("null", null))]),
        where: SQL.createWhereClause(SQL.createLiteral("boolean", false))
      }));
    }

    const alias = Context.generateAlias(this.ctx, "set");
    return {
      fromClause: SQL.createFromClause([{
        alias,
        kind: "TableReference",
        name: "",
        subquery: branches.length === 1 ? branches[0] : SQL.unionAll(branches)
      }]),
      selectItems: [SQL.createSelectItem(SQL.createColumnReference("*", alias))]
    };
  }

  /**
   * One element of a selected set literal as a UNION ALL branch. A
   * parenthesized query is used as it is (all of its rows); anything else is
   * `select <element>`. A branch that orders, limits or is not a plain SELECT
   * is wrapped as a derived table, since a bare UNION ALL operand cannot carry
   * its own ORDER BY / LIMIT or WITH.
   */
  private compileSetLiteralElement(
    element: EdgeQLAST.Expression,
    shape?: EdgeQLAST.Shape
  ): SQL.SQLStatement {
    const statement = element.kind === "Subquery" && !shape ?
      this.compileQuery(element.query) :
      this.compileSelectQuery({ expr: element, kind: "SelectQuery", shape });
    const plain = statement.kind === "SelectStatement" && !statement.orderBy && !statement.limit && !statement.offset;
    if (plain) {
      return statement;
    }
    const alias = Context.generateAlias(this.ctx, "set_element");
    return SQL.createSelectStatement({
      from: SQL.createFromClause([{ alias, kind: "TableReference", name: "", subquery: statement }]),
      select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("*", alias))])
    });
  }

  /**
   * Compile an expression alias as a derived table (subquery in FROM).
   *
   * Given an alias like:
   *   alias ActiveUsers := (select User filter .active = true);
   *
   * And a query:
   *   select ActiveUsers { name, email }
   *
   * Produces:
   *   SELECT jsonb_build_object('name', activeusers_1.name, 'email', activeusers_1.email)
   *   FROM (SELECT * FROM users AS user_2 WHERE user_2.active = true) AS activeusers_1
   */
  private compileAliasExpression(
    aliasDef: Context.AliasDef,
    shape?: EdgeQLAST.Shape
  ): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
  } {
    // Strip optional surrounding parentheses from the alias expression
    let exprText = aliasDef.expression.trim();
    if (exprText.startsWith("(") && exprText.endsWith(")")) {
      exprText = exprText.slice(1, -1).trim();
    }

    // Determine whether the expression is a query (starts with a query keyword)
    // or a simple type/path reference.
    const queryKeywords = /^(select|insert|update|delete|with|for|group)\b/i;
    const isQuery = queryKeywords.test(exprText);

    if (isQuery) {
      // Parse and compile the alias expression as an EdgeQL query
      const parser = new EdgeQLParser(exprText);
      const innerQuery = parser.parse();

      // Compile the inner query to get a SQL statement.  Use a fresh scope so
      // the inner compilation doesn't leak table aliases into the outer query.
      Context.pushScope(this.ctx);
      let innerStatement: SQL.SQLStatement;
      try {
        innerStatement = this.compileQuery(innerQuery);
      } finally {
        Context.popScope(this.ctx);
      }

      // Build a derived-table reference: (inner SQL) AS alias_N
      const aliasBase = aliasDef.name.replace(/::/g, "_").toLowerCase();
      const subqueryAlias = Context.generateAlias(this.ctx, aliasBase);

      // For the subquery to work as a derived table we need the raw rows, not
      // JSON-wrapped output.  If the inner statement is a SELECT that wraps
      // results in jsonb_build_object, re-compile as a raw SELECT * query
      // instead so outer shape compilation can reference individual columns.
      let derivedStatement: SQL.SQLStatement;
      if (innerQuery.kind === "SelectQuery") {
        Context.pushScope(this.ctx);
        try {
          derivedStatement = this.compileSelectQueryRaw(innerQuery);
        } finally {
          Context.popScope(this.ctx);
        }
      } else {
        derivedStatement = innerStatement;
      }

      const tableRef: SQL.TableReference = {
        kind: "TableReference",
        name: subqueryAlias,
        alias: subqueryAlias,
        subquery: derivedStatement
      };

      const fromClause = SQL.createFromClause([tableRef]);

      // If a target type is known, use it to compile the shape
      let selectItems: SQL.SelectItem[];
      if (shape && aliasDef.targetType) {
        const targetTypeDef = Context.resolveTypeName(
          this.ctx,
          aliasDef.targetType
        );
        if (targetTypeDef) {
          // Register the alias in scope so shape compilation can resolve columns
          this.ctx.currentScope.aliases.set(
            aliasDef.name.replace(/::/g, "_").toLowerCase(),
            {
              table: subqueryAlias,
              alias: subqueryAlias,
              type: targetTypeDef.name
            }
          );
          selectItems = this.compileShape(
            shape,
            targetTypeDef.name,
            subqueryAlias
          );
        } else {
          // Target type not found — fall back to SELECT *
          selectItems = [
            SQL.createSelectItem(SQL.createColumnReference("*", subqueryAlias))
          ];
        }
      } else if (shape && !aliasDef.targetType) {
        // Shape provided but no target type — select columns by name from
        // the shape elements, referencing the derived table alias directly.
        const fields: SQL.JsonField[] = [];
        for (const element of shape.elements) {
          const propName = element.name?.name ||
            (element.expr.kind === "Identifier" ? element.expr.name : null);
          if (propName) {
            fields.push(
              SQL.createJsonField(
                propName,
                SQL.createColumnReference(propName, subqueryAlias)
              )
            );
          }
        }
        if (fields.length > 0) {
          selectItems = [
            SQL.createSelectItem(SQL.createJsonBuildObject(fields))
          ];
        } else {
          selectItems = [
            SQL.createSelectItem(SQL.createColumnReference("*", subqueryAlias))
          ];
        }
      } else {
        // No shape — if target type is known, use implicit shape; else SELECT *
        if (aliasDef.targetType) {
          const targetTypeDef = Context.resolveTypeName(
            this.ctx,
            aliasDef.targetType
          );
          if (targetTypeDef) {
            selectItems = this.compileImplicitShape(
              targetTypeDef,
              subqueryAlias
            );
          } else {
            selectItems = [
              SQL.createSelectItem(
                SQL.createColumnReference("*", subqueryAlias)
              )
            ];
          }
        } else {
          selectItems = [
            SQL.createSelectItem(
              SQL.createColumnReference("*", subqueryAlias)
            )
          ];
        }
      }

      return { selectItems, fromClause };
    } else {
      // The alias expression is a simple type or path reference (e.g., User).
      // Resolve the referenced type and compile as a regular type select.
      const targetName = aliasDef.targetType || exprText;
      const typeDef = Context.resolveTypeName(this.ctx, targetName);
      if (!typeDef) {
        throw new CompilationError(
          `Alias '${aliasDef.name}' references unknown type '${targetName}'`
        );
      }

      const resolvedName = typeDef.name;
      const tableAlias = Context.addTableAlias(
        this.ctx,
        aliasDef.name.replace(/::/g, "_").toLowerCase(),
        typeDef.tableName,
        resolvedName
      );
      const fromClause = SQL.createFromClause([
        SQL.createTableReference(typeDef.tableName, tableAlias)
      ]);

      let selectItems: SQL.SelectItem[];
      if (shape) {
        selectItems = this.compileShape(shape, resolvedName, tableAlias);
      } else {
        selectItems = this.compileImplicitShape(typeDef, tableAlias);
      }

      return { selectItems, fromClause };
    }
  }

  /**
   * Lower `SELECT <AbstractType>` to a UNION ALL across concrete
   * subtypes' tables. Each UNION branch projects the abstract type's
   * own properties (each subtype inherited them under the same
   * column names), so the outer SELECT can reference the abstract's
   * alias as if it were a regular table.
   *
   * Returns `null` when no concrete subtypes exist — caller falls
   * back to the regular path which will fail at compile-time with
   * a clearer message than emitting a query against a non-existent
   * physical table.
   */
  /**
   * Walk a SELECT shape collecting every (column-name → pg-type) pair
   * referenced via a polymorphic shape field `[IS Type].property`.
   * Used by `compilePolymorphicSelect` to extend each UNION branch's
   * projection so the outer CASE expression can reference the column
   * by name (subtypes that don't own the column project a typed NULL).
   *
   * Skips columns already inherited from the abstract type (caller
   * passes `inheritedColumns` as the dedupe set), and silently ignores
   * polymorphic refs whose type or property doesn't resolve — those
   * errors surface from `compilePolymorphicShapeElement` with a better
   * message.
   */
  private collectPolymorphicShapeColumns(
    shape: EdgeQLAST.Shape,
    inheritedColumns: ReadonlyArray<string>
  ): Map<string, string> {
    const cols = new Map<string, string>();
    for (const element of shape.elements) {
      if (!element.typeFilter) {
        continue;
      }
      const propName = element.name?.name ||
        (element.expr.kind === "Identifier" ? element.expr.name : "");
      if (!propName) {
        continue;
      }
      const filterTypeDef = Context.resolveTypeName(
        this.ctx,
        element.typeFilter
      );
      if (!filterTypeDef) {
        continue;
      }

      // Property path (Bundle BB).
      const property = filterTypeDef.properties.get(propName);
      if (property) {
        const colName = property.columnName ?? property.name;
        if (inheritedColumns.includes(colName)) {
          continue;
        }
        if (cols.has(colName)) {
          continue;
        }
        const pgType = property.multi && !property.computed ?
          this.multiPropertyArrayType(property) :
          edgeqlTypeToPgType(property.edgeqlType ?? property.type, this.ctx.schema.scalars);
        cols.set(colName, pgType);
        continue;
      }

      // Bundle EEE: single-FK link path. The FK column lives on the
      // subtype's row, so it needs the same "project from owning
      // branch, NULL from others" treatment as polymorphic
      // properties. Junction-table multi links don't need a column
      // projected here (the eventual subquery references parent.id
      // directly), so we just skip them.
      const link = filterTypeDef.links.get(propName);
      if (link && link.columnName) {
        const colName = link.columnName;
        if (inheritedColumns.includes(colName)) {
          continue;
        }
        if (cols.has(colName)) {
          continue;
        }
        // FK columns are uuid in Disc's schema (id is uuid).
        cols.set(colName, "uuid");
      }
    }
    return cols;
  }

  private compilePolymorphicSelect(
    typeDef: Context.TypeDef,
    resolvedName: string,
    shape: EdgeQLAST.Shape | undefined,
    subjectNames: string[]
  ): { selectItems: SQL.SelectItem[]; fromClause: SQL.FromClause; } | null {
    const concreteSubs = this.concreteSubtypes(typeDef);

    if (concreteSubs.length === 0) {
      return null;
    }

    // Phase 1 — abstract type's columns: `id`, `__type__`, and those of its
    // properties and single links, inherited (same column name) by every
    // subtype, so projecting them is safe regardless of which subtype's
    // table backs the row.
    const inheritedColumns = this.abstractColumns(typeDef);

    // Phase 2 — subtype-specific columns referenced via polymorphic
    // shape fields like `[IS Circle].radius`. Without this projection
    // the outer CASE expression in `compilePolymorphicShapeElement`
    // resolves `<alias>.radius` against the union, which doesn't have
    // the column → "column shape_1.radius does not exist". Each branch
    // now projects either the actual column (when the subtype owns it)
    // or `NULL::<pg-type> AS <colName>` (when it doesn't), so PG's
    // UNION column-resolution sees a consistent shape across branches.
    const polymorphicColumns = shape ?
      this.collectPolymorphicShapeColumns(shape, inheritedColumns) :
      new Map<string, string>();
    const allBranchColumns = [
      ...inheritedColumns,
      ...polymorphicColumns.keys()
    ];

    // Build one SELECT per concrete subtype.
    const branches: SQL.SelectStatement[] = concreteSubs.map(sub => {
      const items: SQL.SelectItem[] = allBranchColumns.map(col => {
        // Inherited columns: every subtype has them.
        if (inheritedColumns.includes(col)) {
          return SQL.createSelectItem(SQL.createColumnReference(col));
        }
        // Subtype-specific column. Check if THIS subtype owns it as
        // a property (Bundle BB) or as a single-FK link (Bundle EEE).
        const ownsAsProperty = [...sub.properties.values()].some(
          p => (p.columnName ?? p.name) === col
        );
        const ownsAsLink = [...sub.links.values()].some(
          l => l.columnName === col
        );
        if (ownsAsProperty || ownsAsLink) {
          return SQL.createSelectItem(SQL.createColumnReference(col));
        }
        // Project NULL with a type cast so PG infers the union column's
        // type from the typed NULL rather than failing to unify branches.
        const pgType = polymorphicColumns.get(col)!;
        return SQL.createSelectItem(
          { kind: "RawSQLExpression" as const, sql: `NULL::${pgType}` },
          col
        );
      });
      return SQL.createSelectStatement({
        select: SQL.createSelectClause(items),
        from: SQL.createFromClause([
          SQL.createTableReference(sub.tableName)
        ])
      });
    });

    const subquery: SQL.SQLStatement = branches.length === 1 ?
      branches[0] :
      SQL.unionAll(branches);

    const tableAlias = Context.addTableAlias(
      this.ctx,
      resolvedName.toLowerCase(),
      typeDef.tableName ?? resolvedName.toLowerCase(),
      resolvedName
    );

    const fromClause = SQL.createFromClause([
      {
        kind: "TableReference",
        name: "(polymorphic)",
        alias: tableAlias,
        subquery
      } as SQL.TableReference
    ]);
    this.bindSubject(subjectNames, { alias: tableAlias, table: typeDef.tableName, type: resolvedName });

    let selectItems: SQL.SelectItem[];
    if (shape) {
      selectItems = this.compileShape(shape, resolvedName, tableAlias);
    } else {
      selectItems = this.compileImplicitShape(typeDef, tableAlias);
    }

    return { selectItems, fromClause };
  }

  private compileShape(
    shape: EdgeQLAST.Shape,
    typeName: string,
    tableAlias: string
  ): SQL.SelectItem[] {
    const fields: SQL.JsonField[] = [];

    // Expand any splat (`{ * }`) elements to one ShapeElement per scalar
    // property of the type. Following Gel semantics, `*` covers properties
    // only — links require explicit selection.
    const expanded = this.expandSplats(shape.elements, typeName);

    for (const element of expanded) {
      const field = this.compileShapeElement(element, typeName, tableAlias);
      if (field) {
        fields.push(field);
      }
    }

    const jsonObject = SQL.createJsonBuildObject(fields);
    return [SQL.createSelectItem(jsonObject)];
  }

  private expandSplats(
    elements: EdgeQLAST.ShapeElement[],
    typeName: string
  ): EdgeQLAST.ShapeElement[] {
    const out: EdgeQLAST.ShapeElement[] = [];
    for (const element of elements) {
      if (!element.splat) {
        out.push(element);
        continue;
      }
      // `typeName` is bare for a type outside the default module, which
      // the schema keys `module::Name`.
      const typeDef = Context.resolveTypeName(this.ctx, typeName);
      if (!typeDef) {
        throw new CompilationError(
          `splat shape '*' on unknown type '${typeName}'`
        );
      }
      // Always include `id` first so consumers can rely on it; iterate
      // properties (Map preserves insertion order from the schema parser).
      const seen = new Set<string>();
      const pushIfNew = (name: string) => {
        if (seen.has(name)) {
          return;
        }
        seen.add(name);
        out.push({
          kind: "ShapeElement",
          expr: EdgeQLAST.createIdentifier(name)
        });
      };
      pushIfNew("id");
      for (const [propName, prop] of typeDef.properties) {
        // Splat covers stored columns only. Computed properties (e.g.
        // `counts := count(...)`) have no physical column, so emitting them
        // here produced `column <table>.<name> does not exist`. They remain
        // available via explicit selection.
        if (prop.computed) {
          continue;
        }
        pushIfNew(propName);
      }
    }
    return out;
  }

  /**
   * Resolve a property reference inside a shape. Stored properties emit a
   * column reference; computed properties re-parse their captured EdgeQL
   * expression (`PropertyDef.computedExpr`) and compile that in place, so
   * `select X { computedThing }` doesn't reference a non-existent column.
   */
  private compilePropertyReference(property: Context.PropertyDef, tableAlias: string, typeName: string): SQL.SQLExpression {
    if (property.computed && property.computedExpr) {
      const parser = new EdgeQLParser(property.computedExpr);
      const expr = parser.parseExpressionOnly();
      return this.bytesAsBase64(this.compileExpression(expr), this.bytesTypeOf(expr, typeName));
    }
    return this.bytesAsBase64(SQL.createColumnReference(property.columnName, tableAlias), this.bytesTypeOfProperty(property, typeName));
  }

  /**
   * The wire form of `bytes` inside a shape. `jsonb_build_object` would render
   * a bytea as PostgreSQL hex text (`"\\x1f8b…"`); JSON carries `bytes` as
   * base64 (RFC 4648), and `encode` breaks lines every 76 characters, hence the
   * `translate`. An `array<bytes>` is encoded element by element, in order;
   * NULL stays NULL and `{}` stays `[]`.
   *
   * The value stays a SQL AST node (for the array, in the `IS NULL` test) so
   * that a parameter inside it — `x := <bytes>$p` — is still found by
   * `buildParameterTypeMap`, which is how the server knows to decode it.
   */
  private bytesAsBase64(value: SQL.SQLExpression, bytesType: "bytea" | "bytea[]" | null): SQL.SQLExpression {
    const newline: SQL.RawSQLExpression = { kind: "RawSQLExpression", sql: "E'\\n'" };
    const encoded = (bytes: SQL.SQLExpression): SQL.SQLExpression =>
      SQL.createFunctionCall("translate", [
        SQL.createFunctionCall("encode", [bytes, SQL.createLiteral("string", "base64")]),
        newline,
        SQL.createLiteral("string", "")
      ]);

    if (bytesType === "bytea") {
      return encoded(value);
    }
    if (bytesType === "bytea[]") {
      const elements = `ARRAY(SELECT ${this.renderSqlExpr(encoded(SQL.createColumnReference("b")))} FROM unnest(${
        this.renderSqlExpr(value)
      }) WITH ORDINALITY AS u(b, ord) ORDER BY ord)`;
      return SQL.createCaseExpression(
        [SQL.createWhenClause(SQL.createBinaryExpression("IS", value, SQL.createLiteral("null", null)), SQL.createLiteral("null", null))],
        { kind: "RawSQLExpression", sql: elements }
      );
    }
    return value;
  }

  private bytesTypeOfProperty(property: Context.PropertyDef, typeName: string): "bytea" | "bytea[]" | null {
    if (property.computed && property.computedExpr) {
      return this.bytesTypeOf(new EdgeQLParser(property.computedExpr).parseExpressionOnly(), typeName);
    }
    return property.type === "bytea" || property.type === "bytea[]" ? property.type : null;
  }

  /**
   * `"bytea"` / `"bytea[]"` when a shape element's expression yields `bytes` /
   * `array<bytes>`, else null. There is no expression type inference in the
   * compiler; this reads the forms whose type is stated: a path ending in a
   * property, a cast, a bytes literal, a call to a function registered as
   * returning bytes. Anything else (`.a ++ .b`, `.a if … else .b`) is not
   * recognized and ships as PostgreSQL renders it.
   */
  private bytesTypeOf(expr: EdgeQLAST.Expression, typeName: string): "bytea" | "bytea[]" | null {
    let pgType: string | undefined;

    if (expr.kind === "TypeCast") {
      pgType = edgeqlTypeToPgType(renderEdgeQLTypeName(expr.type), this.ctx.schema.scalars);
    } else if (expr.kind === "Literal") {
      pgType = expr.type === "bytes" ? "bytea" : undefined;
    } else if (expr.kind === "FunctionCall") {
      const funcDef = Context.lookupFunction(this.ctx.schema, expr.name.parts);
      pgType = funcDef?.returnType ? edgeqlTypeToPgType(funcDef.returnType) : undefined;
    } else if (expr.kind === "Path") {
      let owner: string | undefined = typeName;
      for (const step of expr.steps.slice(0, -1)) {
        owner = step.type === "backlink" || !owner ? undefined : Context.getLink(this.ctx, owner, step.name)?.target;
      }
      const last = expr.steps.at(-1);
      const property = owner && last && last.type !== "backlink" ? Context.getProperty(this.ctx, owner, last.name) : undefined;
      return property && owner ? this.bytesTypeOfProperty(property, owner) : null;
    }

    return pgType === "bytea" || pgType === "bytea[]" ? pgType : null;
  }

  /**
   * Compile `.<computedProp>.<field>` where `computedProp` is a computed
   * named-tuple property (e.g. `counts := (videos := count(...), ...)`).
   * Pulls the named field's sub-expression out of the parsed tuple and
   * compiles it in the current scope, so `.counts.videos` becomes the same
   * SQL as the underlying `count(...)`. Returns null when the property
   * isn't a computed named tuple or has no such field.
   */
  private compileComputedTupleField(
    propName: string,
    fieldName: string
  ): SQL.SQLExpression | null {
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const property = td?.properties.get(propName);
      if (!property?.computed || !property.computedExpr) {
        continue;
      }
      const expr = new EdgeQLParser(property.computedExpr).parseExpressionOnly();
      if (expr.kind !== "NamedTuple") {
        return null;
      }
      const element = expr.elements.find(e => e.name === fieldName);
      if (!element) {
        return null;
      }
      return this.compileExpression(element.value);
    }
    return null;
  }

  private compileShapeElement(
    element: EdgeQLAST.ShapeElement,
    typeName: string,
    tableAlias: string
  ): SQL.JsonField | null {
    // Handle polymorphic shape fields: [IS Type].property
    if (element.typeFilter) {
      return this.compilePolymorphicShapeElement(element, typeName, tableAlias);
    }

    // `@role` / `@r := expr` in a link's sub-shape: the expression reads the
    // junction row (see compileLinkPropertyPath); Gel keys it `@<name>`.
    if (element.linkProperty && element.name) {
      return SQL.createJsonField(`@${element.name.name}`, this.compileExpression(element.expr));
    }

    let key: string;
    let value: SQL.SQLExpression;

    if (element.name) {
      // Named element (alias or computed property)
      key = element.name.name;
      if (element.computable) {
        // Computed property: name := expression. A path set is its select's
        // rows as an array.
        const pathSelect = this.shapePathSelect(element);
        value = pathSelect ?
          this.compileJsonArray(pathSelect) :
          this.bytesAsBase64(this.compileExpression(element.expr), this.bytesTypeOf(element.expr, typeName));
      } else if (element.shape) {
        // Link with nested shape: posts: { title, createdAt }
        const linkName = element.name.name;
        const link = Context.getLink(this.ctx, typeName, linkName);
        if (link) {
          value = this.compileLinkWithShape(
            link,
            element.shape,
            tableAlias,
            element.orderBy,
            element.filter
          );
        } else {
          // Try as a property reference
          const property = Context.getProperty(this.ctx, typeName, linkName);
          if (property) {
            value = SQL.createColumnReference(property.columnName, tableAlias);
          } else {
            throw new CompilationError(
              `Property or link '${linkName}' not found on type '${typeName}'`
            );
          }
        }
      } else {
        // Aliased property: look up in schema
        const propName = element.name.name;
        const property = Context.getProperty(this.ctx, typeName, propName);
        if (property) {
          value = this.compilePropertyReference(property, tableAlias, typeName);
        } else {
          // Fall back to compiling the expression
          value = this.compileExpression(element.expr);
        }
      }
    } else if (element.expr.kind === "Identifier") {
      // Simple property reference
      const propName = element.expr.name;
      key = propName;

      const property = Context.getProperty(this.ctx, typeName, propName);
      if (property) {
        value = this.compilePropertyReference(property, tableAlias, typeName);
      } else {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link) {
          // Handle link - this would need a subquery or join
          value = this.compileLinkReference(link, tableAlias);
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      }
    } else {
      // Expression without explicit name
      key = "result";
      value = this.compileExpression(element.expr);
    }

    return SQL.createJsonField(key, value);
  }

  /**
   * The select a computed shape element stands for when its value is a set
   * of a path's objects or values, else null (compiled as an expression):
   *
   *   titles := .posts.title                    → select .posts.title
   *   r := .<manager[is Person] { name } filter … order by …
   *                                             → select .<manager[is Person] { name } filter … order by …
   *   r := (select .<manager[is Person] { name } filter …)
   *
   * Objects are always an array, like a link's sub-shape; values only when
   * the path is multi (`boss := .manager.name` stays one value). A bare path
   * to objects answers their ids (`[{ "id": … }]`). A lone backlink keeps its
   * own compilation (compileBacklinkWithIntersection), which answers the same.
   */
  private shapePathSelect(element: EdgeQLAST.ShapeElement): EdgeQLAST.SelectQuery | null {
    const { expr } = element;
    // An expression that is a set (`x := {1, 2}`, `z := .name ++ {'a', 'b'}`,
    // `up := str_upper(.posts.title)`, `n := array_unpack(…)`) is its rows as
    // an array too: as one value it would be a record, or repeat the object's
    // row once per element. A one-element set literal is one value.
    const singleton = expr.kind === "SetExpr" && flattenSetElements(expr).length === 1;
    if (!singleton && this.setQuery(expr)) {
      return { distinct: false, expr, filter: element.filter, kind: "SelectQuery", orderBy: element.orderBy };
    }
    // A type's objects (`x := Item`, `x := Item { name }`, `x := (select Item { name } filter …)`)
    // are an array too, unless the select keeps at most one object.
    const idShape = EdgeQLAST.createShape([EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("id"))]);
    const subject = expr.kind === "ShapeExpr" ? expr.expr : expr;
    if (this.typeOfObjectSet(subject)) {
      const shape = expr.kind === "ShapeExpr" ? expr.shape : idShape;
      return { distinct: false, expr: subject, filter: element.filter, kind: "SelectQuery", orderBy: element.orderBy, shape };
    }
    if (expr.kind === "Subquery" && expr.query.kind === "SelectQuery") {
      const typeDef = this.typeOfObjectSet(expr.query.expr);
      if (typeDef && !this.selectsAtMostOne(expr.query, typeDef)) {
        return expr.query;
      }
    }
    if (expr.kind === "ShapeExpr" && expr.expr.kind === "Path") {
      const resolved = this.resolvePath(expr.expr);
      return resolved && !resolved.property ?
        { distinct: false, expr: expr.expr, filter: element.filter, kind: "SelectQuery", orderBy: element.orderBy, shape: expr.shape } :
        null;
    }
    if (expr.kind === "Subquery" && expr.query.kind === "SelectQuery" && expr.query.expr.kind === "Path") {
      const resolved = this.resolvePath(expr.query.expr);
      return resolved && (resolved.multi || !resolved.property) ? expr.query : null;
    }
    if (expr.kind !== "Path") {
      return null;
    }
    const resolved = this.resolvePath(expr);
    const loneBacklink = resolved?.start.kind === "row" && resolved.hops.length === 1 && resolved.hops[0].kind === "backlink" &&
      !resolved.property;
    if (!resolved?.multi || loneBacklink) {
      return null;
    }
    return { distinct: false, expr, kind: "SelectQuery", shape: resolved.property ? undefined : idShape };
  }

  /*** The object type `expr` is every object of (`Item`, `detached Item`), or undefined: a bound subject is one object. ***/
  private typeOfObjectSet(expr: EdgeQLAST.Expression): Context.TypeDef | undefined {
    const detached = detachedOperand(expr);
    if (detached) {
      return this.withDetached(() => this.typeOfObjectSet(detached));
    }
    if (expr.kind !== "TypeName") {
      return undefined;
    }
    const name = expr.name.parts.join("::");
    const typeDef = this.scopeVariable(name) ? undefined : Context.resolveTypeName(this.ctx, name);
    return typeDef?.kind === "object" ? typeDef : undefined;
  }

  /**
   * True when a select of `typeDef`'s objects keeps at most one, as Gel
   * infers it: `limit 1`, or a filter requiring `.id` or an exclusive
   * property to equal one value.
   */
  private selectsAtMostOne(query: EdgeQLAST.SelectQuery, typeDef: Context.TypeDef): boolean {
    if (query.limit?.kind === "Literal" && Number(query.limit.value) <= 1) {
      return true;
    }
    const conjuncts = (expr: EdgeQLAST.Expression): EdgeQLAST.Expression[] =>
      expr.kind === "BinaryOp" && expr.op === "AND" ? [...conjuncts(expr.left), ...conjuncts(expr.right)] : [expr];
    const isUnique = (expr: EdgeQLAST.Expression): boolean => {
      if (expr.kind !== "Path" || expr.rooted || expr.steps.length !== 1 || expr.steps[0].type !== "property") {
        return false;
      }
      const name = expr.steps[0].name;
      return name === "id" || (typeDef.properties.get(name)?.constraints?.some(constraint => constraint.name === "exclusive") ?? false);
    };
    const isOneValue = (expr: EdgeQLAST.Expression): boolean =>
      ["GlobalRef", "Identifier", "Literal", "Parameter"].includes(expr.kind) || (expr.kind === "TypeCast" && isOneValue(expr.expr));
    return query.filter !== undefined && conjuncts(query.filter).some(condition =>
      condition.kind === "BinaryOp" && condition.op === "=" &&
      ((isUnique(condition.left) && isOneValue(condition.right)) || (isUnique(condition.right) && isOneValue(condition.left)))
    );
  }

  /*** A select's rows as one JSON array, in the select's order (`[]` for none). ***/
  private compileJsonArray(query: EdgeQLAST.SelectQuery): SQL.SQLExpression {
    const rows = this.compileSelectQuery(query);
    return SQL.createSubqueryExpression(SQL.createSelectStatement({
      from: SQL.createFromClause([{ alias: "__agg", columnAliases: ["v"], kind: "TableReference", name: "", subquery: rows }]),
      select: SQL.createSelectClause([
        SQL.createSelectItem(
          SQL.createFunctionCall("COALESCE", [
            SQL.createFunctionCall("jsonb_agg", [SQL.createColumnReference("v", "__agg")]),
            { kind: "RawSQLExpression", sql: "'[]'::jsonb" }
          ])
        )
      ])
    }));
  }

  /**
   * Compile a polymorphic shape element: [IS Type].property
   *
   * Generates:
   *   CASE WHEN __type__ IN ('Type', subtypes...) THEN column_value ELSE NULL END
   */
  private compilePolymorphicShapeElement(
    element: EdgeQLAST.ShapeElement,
    _parentTypeName: string,
    tableAlias: string
  ): SQL.JsonField | null {
    const filterTypeName = element.typeFilter!;
    const filterTypeDef = Context.resolveTypeName(this.ctx, filterTypeName);
    if (!filterTypeDef) {
      throw new CompilationError(
        `Type '${filterTypeName}' not found for polymorphic shape field`
      );
    }

    // Resolve the property from the filtered type
    const propName = element.name?.name ||
      (element.expr.kind === "Identifier" ? element.expr.name : "");
    if (!propName) {
      throw new CompilationError(
        "Polymorphic shape element must reference a property"
      );
    }

    const property = Context.getProperty(
      this.ctx,
      filterTypeDef.name,
      propName
    );
    // Bundle EEE: links resolve via the type's `links` map (not the
    // property accessor). Single-FK links project the FK column from
    // the owning subtype's branch — same shape as Bundle BB's
    // property path. Junction-table multi links are deferred (they
    // need a correlated subquery wrapped in CASE; future work).
    const link = property ? null : filterTypeDef.links.get(propName);
    if (!property && !link) {
      throw new CompilationError(
        `Property or link '${propName}' not found on type '${filterTypeDef.name}'`
      );
    }
    if (link && !link.columnName) {
      throw new CompilationError(
        `Polymorphic shape on multi-cardinality link '${filterTypeDef.name}.${propName}' is not yet supported (junction tables / backlinks). Single-cardinality links work today.`
      );
    }

    // Build the type check condition
    const allTypes = [
      filterTypeDef.name,
      ...Context.getAllSubtypes(this.ctx.schema, filterTypeDef.name)
    ];
    let condition: SQL.SQLExpression;

    if (allTypes.length === 1) {
      condition = SQL.createBinaryExpression(
        "=",
        SQL.createColumnReference("__type__", tableAlias),
        SQL.createLiteral("string", allTypes[0])
      );
    } else {
      const typeList = allTypes.map(t => `'${t}'`).join(", ");
      condition = {
        kind: "RawSQLExpression" as const,
        sql: `${tableAlias}.__type__ IN (${typeList})`
      };
    }

    // CASE WHEN condition THEN column ELSE NULL END.
    // For property: `tableAlias.column_name`.
    // For single-FK link: `tableAlias.<fk_column>` (returns the
    // target's id; clients can drill in via a follow-up SELECT).
    const targetColumn = property ? property.columnName : link!.columnName!;
    const columnRef = this.bytesAsBase64(
      SQL.createColumnReference(targetColumn, tableAlias),
      property ? this.bytesTypeOfProperty(property, filterTypeDef.name) : null
    );
    const caseExpr = SQL.createCaseExpression(
      [SQL.createWhenClause(condition, columnRef)],
      SQL.createLiteral("null", null)
    );

    return SQL.createJsonField(propName, caseExpr);
  }

  private compileImplicitShape(
    typeDef: Context.TypeDef,
    tableAlias: string
  ): SQL.SelectItem[] {
    const fields: SQL.JsonField[] = [];

    // Add all stored properties. Computed properties have no physical
    // column, so emitting them as `table.<name>` would reference a column
    // that doesn't exist — skip them (they're available via explicit
    // selection, same as splat).
    for (const [name, property] of typeDef.properties) {
      if (property.computed) {
        continue;
      }
      const value = this.compilePropertyReference(property, tableAlias, typeDef.name);
      fields.push(SQL.createJsonField(name, value));
    }

    const jsonObject = SQL.createJsonBuildObject(fields);
    return [SQL.createSelectItem(jsonObject)];
  }

  private compileLinkReference(
    link: Context.LinkDef,
    parentAlias: string
  ): SQL.SQLExpression {
    // A link to an object the select policy hides is empty, not its id.
    const target = Context.resolveTypeName(this.ctx, link.target);
    if (link.columnName) {
      // Simple foreign key reference
      const column = SQL.createColumnReference(link.columnName, parentAlias);
      return target ? this.readableId(target, column) : column;
    } else if (link.junctionTable) {
      // Many-to-many: subquery returning array of target IDs via junction table
      const jt = link.junctionTable;
      const srcCol = link.junctionSourceColumn || "source_id";
      const tgtCol = link.junctionTargetColumn || "target_id";
      const correlation = SQL.createBinaryExpression(
        "=",
        SQL.createColumnReference(srcCol, jt),
        SQL.createColumnReference("id", parentAlias)
      );
      const readable = target ? this.readableIdCondition(target, SQL.createColumnReference(tgtCol, jt)) : undefined;

      const subquery = SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(
            SQL.createFunctionCall("jsonb_agg", [
              SQL.createColumnReference(tgtCol, jt)
            ])
          )
        ]),
        from: SQL.createFromClause([SQL.createTableReference(jt)]),
        where: SQL.createWhereClause(readable ? SQL.createBinaryExpression("AND", correlation, readable) : correlation)
      });
      return SQL.createSubqueryExpression(subquery);
    } else if (link.backlink) {
      // Reverse link via backlink: subquery returning array of target IDs
      const targetTypeDef = Context.getTypeDef(this.ctx, link.target);
      if (!targetTypeDef) {
        throw new CompilationError(
          `Target type '${link.target}' not found for link '${link.name}'`
        );
      }
      const reverseLink = targetTypeDef.links.get(link.backlink);
      const fkColumn = reverseLink?.columnName ||
        `${propNameToColumnName(link.name)}_id`;
      // Own alias, so a link back to the parent's own type correlates to the
      // parent row rather than to this subquery's.
      const targetAlias = Context.generateAlias(this.ctx, targetTypeDef.tableName);

      const subquery = SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(
            SQL.createFunctionCall("jsonb_agg", [
              SQL.createColumnReference("id", targetAlias)
            ])
          )
        ]),
        from: SQL.createFromClause([
          SQL.createTableReference(targetTypeDef.tableName, targetAlias)
        ]),
        where: SQL.createWhereClause(
          SQL.createBinaryExpression(
            "=",
            SQL.createColumnReference(fkColumn, targetAlias),
            SQL.createColumnReference("id", parentAlias)
          )
        )
      });
      return SQL.createSubqueryExpression(subquery);
    } else {
      throw new CompilationError(
        `Cannot compile link reference without FK, backlink, or junction table: ${link.name}`
      );
    }
  }

  private compileLinkWithShape(
    link: Context.LinkDef,
    shape: EdgeQLAST.Shape,
    parentAlias: string,
    orderBy?: EdgeQLAST.OrderByClause[],
    filter?: EdgeQLAST.Expression
  ): SQL.SQLExpression {
    // Generate a subquery for the linked type with the given shape.
    // Use `resolveTypeName` (not `getTypeDef`) so a link target like
    // "default::Merchant" still resolves when the type is stored under
    // its bare "Merchant" key (see schema-manager.ts:737-740).
    const targetTypeDef = Context.resolveTypeName(this.ctx, link.target);
    if (!targetTypeDef) {
      throw new CompilationError(
        `Target type '${link.target}' not found for link '${link.name}'`
      );
    }

    // Build the JSON fields for the subquery's shape. Expand any splat
    // (`{ * }`) to one element per scalar property of the target type —
    // otherwise a `link: { * }` projects zero fields and each row comes
    // back as `{}` (which a non-null consumer like GraphQL rejects).
    const elements = this.expandSplats(shape.elements, targetTypeDef.name);
    const jsonFields: SQL.JsonField[] = [];
    // Compile the sub-shape with the same machinery as a top-level shape
    // (compileShapeElement handles computed properties, nested links, and
    // aliases — the old hand-rolled loop only emitted plain columns and so
    // turned a computed prop into a nonexistent `<table>.<name>` column).
    // Push a scope aliasing the linked type to this subquery's table so a
    // computed property's backlink/aggregate expressions correlate here, not
    // to the outer query. The table gets its own alias: under the bare table
    // name, a link to the parent's own type (`manager: Person` inside a
    // `Person` update or sub-shape) would capture the parent's reference.
    const targetAlias = Context.generateAlias(this.ctx, targetTypeDef.tableName);
    Context.pushScope(this.ctx);
    this.ctx.currentScope.aliases.set(
      targetTypeDef.name.replace(/::/g, "_").toLowerCase(),
      {
        table: targetTypeDef.tableName,
        alias: targetAlias,
        type: targetTypeDef.name
      }
    );
    // A junction-backed link joins one junction row per target (below);
    // `@prop` in the sub-shape, its filter and its ordering reads that row.
    if (link.junctionTable) {
      this.ctx.currentScope.linkSource = { alias: link.junctionTable, link };
    }
    // Compile the optional sub-shape predicate and ordering inside the pushed
    // scope so their path expressions (e.g. `.created`) resolve to the target
    // table's columns, not the outer query's.
    //
    // Compilation order is textual order — fields, then `filter`, then
    // `order by` — because named query parameters are assigned their PG
    // positional index on first compile, and the wire-level variables map is
    // ordered the same way by the SDK's filter compiler.
    let aggOrderBy: SQL.OrderByItem[] | undefined;
    let filterCondition: SQL.SQLExpression | undefined;
    try {
      for (const element of elements) {
        const field = this.compileShapeElement(
          element,
          targetTypeDef.name,
          targetAlias
        );
        if (field) {
          jsonFields.push(field);
        }
      }
      if (filter) {
        filterCondition = this.compileFilter(filter);
      }
      if (orderBy && orderBy.length > 0) {
        aggOrderBy = orderBy.map(item => ({
          kind: "OrderByItem" as const,
          expression: this.compileOrderExpression(item.expr),
          direction: item.direction || "ASC" as "ASC" | "DESC",
          ...compileEmptyOrder(item, this.isNeverEmpty(item.expr))
        }));
      }
    } finally {
      Context.popScope(this.ctx);
    }

    const jsonObject = SQL.createJsonBuildObject(jsonFields);
    const jsonAgg = SQL.createJsonAgg(jsonObject, aggOrderBy);

    // Determine the join condition and FROM clause
    // Three cases:
    // 1. columnName: forward link (source has FK column)
    // 2. backlink: reverse link (target has FK column pointing back)
    // 3. junctionTable: many-to-many via junction table
    let joinCondition: SQL.SQLExpression;
    let fromClause: SQL.FromClause;

    if (link.columnName) {
      // Forward link: parent.link_column = target.id
      joinCondition = SQL.createBinaryExpression(
        "=",
        SQL.createColumnReference("id", targetAlias),
        SQL.createColumnReference(link.columnName, parentAlias)
      );
      fromClause = SQL.createFromClause([
        SQL.createTableReference(targetTypeDef.tableName, targetAlias)
      ]);
    } else if (link.junctionTable) {
      // Many-to-many via junction table:
      // SELECT ... FROM target JOIN junction ON junction.target_col = target.id
      // WHERE junction.source_col = parent.id
      const jt = link.junctionTable;
      const srcCol = link.junctionSourceColumn || "source_id";
      const tgtCol = link.junctionTargetColumn || "target_id";

      joinCondition = SQL.createBinaryExpression(
        "=",
        SQL.createColumnReference(srcCol, jt),
        SQL.createColumnReference("id", parentAlias)
      );

      // JOIN junction table to target table
      const joinExpr = SQL.createBinaryExpression(
        "=",
        SQL.createColumnReference(tgtCol, jt),
        SQL.createColumnReference("id", targetAlias)
      );

      const targetTableRef = SQL.createTableReference(
        targetTypeDef.tableName,
        targetAlias
      );
      targetTableRef.joins = [{
        kind: "JoinClause",
        type: "INNER",
        table: SQL.createTableReference(jt),
        condition: joinExpr
      }];

      fromClause = SQL.createFromClause([targetTableRef]);
    } else {
      // Reverse link (multi): target.fk_column = parent.id
      // Find the reverse link's column name from the target type
      const reverseLink = targetTypeDef.links.get(link.backlink || "");
      const fkColumn = reverseLink?.columnName ||
        `${link.name.toLowerCase()}_id`;
      joinCondition = SQL.createBinaryExpression(
        "=",
        SQL.createColumnReference(fkColumn, targetAlias),
        SQL.createColumnReference("id", parentAlias)
      );
      fromClause = SQL.createFromClause([
        SQL.createTableReference(targetTypeDef.tableName, targetAlias)
      ]);
    }

    // Build the subquery. A sub-shape `filter` narrows the linked set by
    // ANDing onto the join condition, so only matching rows reach jsonb_agg
    // — the parent row itself is still returned (with an empty array when
    // nothing matches), unlike a top-level `.link.prop = …` predicate which
    // filters the parent.
    const whereCondition = filterCondition ?
      SQL.createBinaryExpression("AND", joinCondition, filterCondition) :
      joinCondition;

    const subquery: SQL.SelectStatement = SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(jsonAgg)]),
      from: fromClause,
      where: SQL.createWhereClause(whereCondition)
    });

    const subqueryExpr = SQL.createSubqueryExpression(subquery);

    // Wrap optional multi-links with COALESCE to return empty array instead of null
    if (!link.required && link.multi) {
      return SQL.createFunctionCall("COALESCE", [
        subqueryExpr,
        { kind: "RawSQLExpression" as const, sql: "'[]'::jsonb" }
      ]);
    }

    return subqueryExpr;
  }

  /**
   * `select <path>`: the objects the path reaches (see compiler-paths.ts), or
   * their property when it ends in one. `select User.posts { title }` reads
   * the post table, keeping the posts linked from some user:
   *
   *   SELECT jsonb_build_object('title', post_2.title) FROM post AS post_2
   *   WHERE post_2.id IN (SELECT __j_posts_1.target_id FROM user_posts AS __j_posts_1
   *                       WHERE __j_posts_1.source_id IN (SELECT user_3.id FROM "user" AS user_3))
   *
   * The reached type is the select's subject, so its filter, order by and
   * limit apply to those objects.
   */
  private compilePathExpression(
    path: EdgeQLAST.Path,
    shape?: EdgeQLAST.Shape
  ): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
    where?: SQL.SQLExpression;
  } {
    // Handle simple Type.property paths (e.g., User.email)
    if (path.steps.length === 2) {
      const typeStep = path.steps[0];
      const propStep = path.steps[1];
      if (typeStep.type === "property" && propStep.type === "property") {
        // Check if this is an enum literal (e.g., Status.active)
        const enumDef = Context.resolveTypeName(this.ctx, typeStep.name);
        if (
          enumDef && Array.isArray(enumDef.enumValues) &&
          enumDef.enumValues.length > 0
        ) {
          const enumExpr = this.compileEnumLiteral(
            typeStep.name,
            propStep.name
          );
          const selectItems = [SQL.createSelectItem(enumExpr)];
          const fromClause = SQL.createFromClause([]);
          return { selectItems, fromClause };
        }

        const typeName = typeStep.name;
        // A bound subject or a variable named like the type is not the type.
        const typeDef = this.scopeVariable(typeName) ? undefined : Context.resolveTypeName(this.ctx, typeName);
        const property = typeDef && !shape ?
          Context.getProperty(
            this.ctx,
            typeName,
            propStep.name
          ) :
          undefined;
        // A multi property is a set of values, one row each: the general path below.
        if (typeDef && property && !property.multi) {
          const tableAlias = Context.addTableAlias(
            this.ctx,
            typeName.toLowerCase(),
            typeDef.tableName,
            typeName
          );
          const fromClause = SQL.createFromClause([
            SQL.createTableReference(typeDef.tableName, tableAlias)
          ]);
          this.bindSubject([typeName, typeDef.name], { alias: tableAlias, table: typeDef.tableName, type: typeDef.name });
          const column = SQL.createColumnReference(property.columnName, tableAlias);
          const selectItems = [SQL.createSelectItem(column)];
          // An object without the property adds no element (a set has no NULLs).
          const where = property.required ? undefined : SQL.isNotNull(column);
          return { selectItems, fromClause, where };
        }
      }
    }

    const resolved = this.resolvePath(path);
    const rendered = renderPath(path);
    if (!resolved) {
      const unsupported = path.steps.find(step => step.type === "link_property" || step.type === "type_intersection");
      if (unsupported) {
        throw new CompilationError(
          `Cannot select '${rendered}': ${
            unsupported.type === "link_property" ? "a link property" : "a type intersection"
          } in a selected path is not supported yet`,
          locationOf(path.steps[0])
        );
      }
      throw new CompilationError(
        `Cannot select '${rendered}': it does not start at an object type, a \`with\` binding of objects, a \`for\` variable over objects ` +
          `or the current object, or a step is not a link (or, last, a property) of the type before it`,
        locationOf(path.steps[0])
      );
    }
    if (resolved.property && shape) {
      throw new CompilationError(
        `A shape cannot be applied to '${rendered}': it ends in the property '${resolved.property.name}'`,
        locationOf(path.steps.at(-1))
      );
    }

    const source = this.compilePathSource(resolved);
    this.bindPathSubject(path, resolved, source.alias);
    const typeName = resolved.typeDef.name;
    let selectItems: SQL.SelectItem[];
    let where = source.where;
    if (resolved.property) {
      const value = this.compilePropertyReference(resolved.property, source.alias, typeName);
      // A multi property is a set of values: one row each.
      const multi = resolved.property.multi && !resolved.property.computed;
      selectItems = [SQL.createSelectItem(multi ? SQL.createFunctionCall("unnest", [value]) : value, multi ? resolved.property.name : undefined)];
      // An object without the property adds no element (a set has no NULLs).
      if (!multi && !resolved.property.required) {
        where = where ? SQL.createBinaryExpression("AND", where, SQL.isNotNull(value)) : SQL.isNotNull(value);
      }
    } else {
      selectItems = shape ? this.compileShape(shape, typeName, source.alias) : this.compileImplicitShape(resolved.typeDef, source.alias);
    }
    return { fromClause: SQL.createFromClause(source.from), selectItems, where };
  }

  protected compilePathInExpression(path: EdgeQLAST.Path): SQL.SQLExpression {
    // `x.name`, where `x` is a `for` variable over objects or a bound subject
    // (`Item.name`, `Order.items.name` in a select of `Order.items`): the
    // rest of the path read from the current row, as `.name` is from a
    // shape's. The bound path itself is the object's id.
    const bound = this.boundPrefix(path);
    if (bound) {
      const { row, steps } = bound;
      if (steps.length === 0) {
        return SQL.createColumnReference("id", row.alias);
      }
      Context.pushScope(this.ctx);
      try {
        this.ctx.currentScope.aliases.set(row.type.replace(/::/g, "_").toLowerCase(), row);
        return this.compilePathInExpression({ kind: "Path", span: path.span, steps });
      } finally {
        Context.popScope(this.ctx);
      }
    }

    if (path.steps.some(step => step.type === "link_property")) {
      return this.compileLinkPropertyPath(path);
    }

    // Handle relative paths starting with '.'
    if (path.steps.length === 1) {
      const step = path.steps[0];
      if (step.type === "property") {
        // Single-step path like `.createdAt`. The EdgeQL property name
        // (camelCase) doesn't necessarily match the SQL column name
        // (snake_case). Resolve the active table alias's TypeDef and
        // map property → columnName so unquoted identifiers round-trip
        // correctly through PostgreSQL.
        for (const ta of this.ctx.currentScope.aliases.values()) {
          const td = Context.resolveTypeName(this.ctx, ta.type);
          const prop = td?.properties.get(step.name);
          if (prop?.columnName) {
            return SQL.createColumnReference(prop.columnName, ta.alias);
          }
          const link = td?.links.get(step.name);
          if (link?.columnName) {
            // The linked object's id, or NULL when the select policy hides it.
            const column = SQL.createColumnReference(link.columnName, ta.alias);
            const target = Context.resolveTypeName(this.ctx, link.target);
            return target ? this.readableId(target, column) : column;
          }
        }
        // A select of values (`(select .visits + 1)`, `x := .name ++ {'a', 'b'}`)
        // pushes a scope with no table: the path is the enclosing row's.
        const subject = this.ctx.currentScope.aliases.size === 0 ? this.implicitSubject(step) : undefined;
        const property = subject ? Context.resolveTypeName(this.ctx, subject.type)?.properties.get(step.name) : undefined;
        if (subject && property?.columnName && !property.computed) {
          return SQL.createColumnReference(property.columnName, subject.alias);
        }
        // Fallback: emit the step name verbatim. Pre-existing behavior
        // for paths whose owning type isn't in the alias scope yet.
        return SQL.createColumnReference(step.name);
      }
    }

    // Reverse link with inline type intersection: `.<options[is X]` is
    // parsed as a single backlink step whose `filter` carries the
    // intersected TypeName (see edgeql/parser.ts:1220). Handle this here
    // before falling through to multi-step branches.
    if (path.steps.length === 1) {
      const step = path.steps[0];
      if (step.type === "backlink") {
        const intersection = backlinkIntersectionName(step.filter);
        if (intersection) {
          const backlink = this.compileBacklinkWithIntersection(
            step.name,
            intersection
          );
          if (backlink) {
            return backlink;
          }
        }
        throw new CompilationError(
          `Backlink '.<${step.name}' without a type intersection ` +
            `(e.g. \`.<${step.name}[is SomeType]\`) is not yet supported`
        );
      }
    }

    // Handle 2-step paths: check for enum literals before rejecting
    if (path.steps.length === 2) {
      const firstStep = path.steps[0];
      const secondStep = path.steps[1];

      // `.<linkName[is Type]` can also be parsed as two separate steps in
      // some grammar paths — keep this branch as a safety net.
      if (
        firstStep.type === "backlink" &&
        secondStep.type === "type_intersection"
      ) {
        const backlink = this.compileBacklinkWithIntersection(
          firstStep.name,
          secondStep.name
        );
        if (backlink) {
          return backlink;
        }
      }

      const enumDefPath = firstStep.type === "property" ?
        Context.resolveTypeName(this.ctx, firstStep.name) :
        undefined;
      if (
        firstStep.type === "property" && secondStep.type === "property" &&
        enumDefPath && Array.isArray(enumDefPath.enumValues) &&
        enumDefPath.enumValues.length > 0
      ) {
        return this.compileEnumLiteral(firstStep.name, secondStep.name);
      }

      // Multi-step path through a single-link, e.g. `.author.id` or
      // `.author.email`. Find the link on the active table alias's type,
      // then either short-circuit to the FK column (when the second step
      // is `id`) or emit a correlated subquery against the target table.
      // A backlink step (`.<author[is Post].title`) is not the forward link
      // of the same name, which a self-linked type also has.
      const linked = firstStep.type === "property" ?
        this.compileLinkedPath(firstStep.name, secondStep.name) :
        null;
      if (linked) {
        return linked;
      }

      // Field of a computed named-tuple property, e.g. `.counts.videos`
      // where `counts := (videos := count(...), ...)`. Inline the named
      // field's sub-expression so it compiles to the same SQL as selecting
      // that aggregate directly.
      if (firstStep.type === "property" && secondStep.type === "property") {
        const tupleField = this.compileComputedTupleField(
          firstStep.name,
          secondStep.name
        );
        if (tupleField) {
          return tupleField;
        }
      }

      throw new CompilationError(
        `Multi-step path '.${firstStep.name}.${secondStep.name}' not supported (link must be defined and single-cardinality)`
      );
    }

    // 3+ step paths: walk the link chain via compileLinkChain. All
    // intermediate steps must resolve to single-cardinality links;
    // multi or junction-table links in the middle of a chain stay out
    // of scope (would need EXISTS-style rewrites at each multi hop).
    if (path.steps.length > 2) {
      const allProperties = path.steps.every(s => s.type === "property");
      if (allProperties) {
        const linked = this.compileLinkChain(path.steps.map(s => s.name));
        if (linked) {
          return linked;
        }
      }
      throw new CompilationError(
        `Multi-step path '.${path.steps.map(s => s.name).join(".")}' not supported ` +
          `(every intermediate step must be a single-cardinality link)`
      );
    }

    throw new CompilationError(`Complex path expressions not yet implemented`);
  }

  /**
   * A path containing a link property. A bare `@prop` reads the junction row
   * of the link whose sub-shape is being compiled. `.link@prop` is a set (one
   * value per link), so it is only compiled as a comparison operand, where
   * compileBinaryOp rewrites it to EXISTS over the junction.
   */
  private compileLinkPropertyPath(path: EdgeQLAST.Path): SQL.SQLExpression {
    const [step] = path.steps;
    if (path.steps.length === 1) {
      const source = this.ctx.currentScope.linkSource;
      if (!source) {
        throw new CompilationError(
          `Link property '@${step.name}' can only be used inside the shape of a multi link that declares it (e.g. 'members: { @${step.name} }')`
        );
      }
      return SQL.createColumnReference(Context.getLinkProperty(source.link, step.name).columnName, source.alias);
    }
    const rendered = path.steps.map(s => s.type === "link_property" ? `@${s.name}` : `.${s.name}`).join("");
    throw new CompilationError(
      `Link property path '${rendered}' is only supported as a comparison operand in a filter (e.g. '${rendered} = <value>')`
    );
  }

  /**
   * Compile an N-step path `.link1.link2....linkN.field` through a chain
   * of single-cardinality links. Builds inside-out:
   *
   * - Start with the source alias's FK column to the first link's target.
   * - For each intermediate link step, wrap with a correlated subquery
   *   `(SELECT "h"."<next_fk>" FROM "<current_target>" "h" WHERE "h"."id" = <inner>)`
   *   so the chain extends one hop deeper.
   * - The final step is either `id` (FK shortcut — no extra wrapping
   *   needed; the existing chain already evaluates to the target's id)
   *   or a property name (one final SELECT layer on the last target).
   *
   * 2-step paths fall out as the trivial case (zero intermediate steps).
   *
   * Returns `null` if any link in the chain can't be resolved or is
   * multi/junction-table (those need different SQL the caller handles).
   */
  private compileLinkedPath(
    linkName: string,
    targetField: string
  ): SQL.SQLExpression | null {
    return this.compileLinkChain([linkName, targetField]);
  }

  /**
   * Lower a reverse link with type intersection — `.<linkName[is TargetType]`
   * — into a correlated subquery. Materializes the matching rows as a JSON
   * array of `{ id }` objects so the value slots cleanly into a JSONB shape.
   *
   * Resolves the link on `TargetType` (NOT the current scope's type) and
   * uses its FK column to filter against the current scope's `id`. Supports
   * single-FK backlinks today; junction-table multi backlinks throw a clear
   * error rather than silently returning the wrong rows.
   */
  private compileBacklinkWithIntersection(
    backlinkName: string,
    intersectionType: string
  ): SQL.SQLExpression | null {
    let currentAlias: { alias: string; type: string; } | undefined;
    for (const ta of this.ctx.currentScope.aliases.values()) {
      currentAlias = ta;
      break;
    }
    if (!currentAlias) {
      return null;
    }
    const currentType = Context.resolveTypeName(this.ctx, currentAlias.type);
    if (!currentType) {
      return null;
    }

    const targetType = Context.resolveTypeName(this.ctx, intersectionType);
    if (!targetType) {
      throw new CompilationError(
        `Backlink intersection target '${intersectionType}' not found in schema`
      );
    }

    const link = targetType.links.get(backlinkName);
    if (!link) {
      throw new CompilationError(
        `Type '${intersectionType}' has no link '${backlinkName}' — ` +
          `'.<${backlinkName}[is ${intersectionType}]' requires the named ` +
          `link to exist on the intersection target`
      );
    }

    // The forward link on the target must point back at the current type.
    // Resolving against the schema (not just a string compare) tolerates
    // module-qualified vs bare target names.
    const linkTargetType = Context.resolveTypeName(this.ctx, link.target);
    if (linkTargetType && linkTargetType.name !== currentType.name) {
      throw new CompilationError(
        `Link '${intersectionType}.${backlinkName}' targets ` +
          `'${linkTargetType.name}', not '${currentType.name}' — backlink ` +
          `does not connect to the current type`
      );
    }

    // The backlinked rows get their own alias: when the link points back at
    // its own type, the bare table name would capture the current row's.
    const rowAlias = `__bl_${backlinkName}`;

    if (link.columnName && !link.junctionTable) {
      // Single-FK backlink. Emit a correlated subquery materializing matches
      // as JSON, defaulting to `[]` so a row with no requirements still
      // produces a parseable JSON array instead of NULL.
      const sql = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', "${rowAlias}"."id")), '[]'::jsonb) ` +
        `FROM ${this.readableTableSql(targetType)} "${rowAlias}" ` +
        `WHERE "${rowAlias}"."${link.columnName}" = "${currentAlias.alias}"."id")`;
      return { kind: "RawSQLExpression", sql };
    }

    if (link.junctionTable) {
      // Junction-table multi backlink. The target's forward link sits on
      // the `source_id` side by default; the rows we want are reached by
      // joining the junction table on its `target_id` matching the
      // current scope's id, then projecting the source-side target rows.
      const srcCol = link.junctionSourceColumn ?? "source_id";
      const tgtCol = link.junctionTargetColumn ?? "target_id";
      const sql = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', "${rowAlias}"."id")), '[]'::jsonb) ` +
        `FROM ${this.readableTableSql(targetType)} "${rowAlias}" ` +
        `JOIN ${this.junctionTableSql(link.junctionTable)} ON "${link.junctionTable}"."${srcCol}" = "${rowAlias}"."id" ` +
        `WHERE "${link.junctionTable}"."${tgtCol}" = "${currentAlias.alias}"."id")`;
      return { kind: "RawSQLExpression", sql };
    }

    throw new CompilationError(
      `Backlink '${intersectionType}.${backlinkName}' has no resolvable ` +
        `column (link is neither a single FK nor a junction-table multi)`
    );
  }

  private compileLinkChain(
    stepNames: string[]
  ): SQL.SQLExpression | null {
    if (stepNames.length < 2) {
      return null;
    }

    for (const ta of this.ctx.currentScope.aliases.values()) {
      const sourceType = Context.resolveTypeName(this.ctx, ta.type);
      const firstLink = sourceType?.links.get(stepNames[0]);
      if (
        !firstLink || firstLink.multi || firstLink.junctionTable ||
        !firstLink.columnName
      ) {
        // Wrong alias scope, or first link isn't a single-cardinality
        // link we can FK-walk. Try the next alias; if none match we
        // return null and the caller produces a clear error.
        continue;
      }

      // currentSql is an SQL fragment that evaluates to the id of the
      // *next* hop's target type. Initially it's the source's FK column.
      let currentSql = `"${ta.alias}"."${firstLink.columnName}"`;
      let currentTargetType = Context.resolveTypeName(
        this.ctx,
        firstLink.target
      );
      if (!currentTargetType) {
        return null;
      }

      // Walk intermediate link steps (everything except first link and
      // the terminal property/id step). Each hop's table gets its own alias
      // (`__l<hop>_<link>`): under the bare table name, a link to the source's
      // own type would capture the source alias (`"person"."manager_id"`
      // inside `FROM "person"` reads the inner row).
      for (let i = 1; i < stepNames.length - 1; i++) {
        const link = currentTargetType.links.get(stepNames[i]);
        if (!link || link.multi || link.junctionTable || !link.columnName) {
          return null;
        }
        const hopAlias = `__l${i - 1}_${stepNames[i - 1]}`;
        currentSql = `(SELECT "${hopAlias}"."${link.columnName}" FROM ${this.readableTableSql(currentTargetType)} "${hopAlias}" ` +
          `WHERE "${hopAlias}"."id" = ${currentSql})`;
        const next = Context.resolveTypeName(this.ctx, link.target);
        if (!next) {
          return null;
        }
        currentTargetType = next;
      }

      const finalStep = stepNames[stepNames.length - 1];

      // FK shortcut at the terminus: the chain already evaluates to
      // the target's id, so no extra SELECT is needed — unless the select
      // policy may hide the target, whose id then reads as NULL.
      if (finalStep === "id") {
        return { kind: "RawSQLExpression", sql: this.readableIdSql(currentTargetType, currentSql) };
      }

      const targetProp = currentTargetType.properties.get(finalStep);
      if (!targetProp?.columnName) {
        return null;
      }

      const lastLink = stepNames.length - 2;
      const hopAlias = `__l${lastLink}_${stepNames[lastLink]}`;
      const sql = `(SELECT "${hopAlias}"."${targetProp.columnName}" FROM ${this.readableTableSql(currentTargetType)} "${hopAlias}" ` +
        `WHERE "${hopAlias}"."id" = ${currentSql})`;
      return { kind: "RawSQLExpression", sql };
    }
    return null;
  }

  /**
   * Compile an enum literal path (e.g., Status.active) into a SQL type-cast
   * expression like 'active'::status.
   */
  private compileEnumLiteral(
    enumTypeName: string,
    memberName: string
  ): SQL.RawSQLExpression {
    const typeDef = Context.resolveTypeName(this.ctx, enumTypeName);
    if (!typeDef || !typeDef.enumValues) {
      throw new CompilationError(
        `Enum type '${enumTypeName}' not found`
      );
    }

    if (!typeDef.enumValues.includes(memberName)) {
      throw new CompilationError(
        `'${memberName}' is not a member of enum type '${enumTypeName}'. ` +
          `Valid members: ${typeDef.enumValues.join(", ")}`
      );
    }

    const sqlType = Context.enumSqlType(typeDef);
    return {
      kind: "RawSQLExpression",
      sql: `'${memberName}'::${sqlType}`
    };
  }
}
