/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Shape compilation layer: select queries and expressions, shapes, splats,
 * polymorphic selects, link references, and path expression compilation
 * for the EdgeQL compiler.
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { propNameToColumnName } from "../lib/identifiers.ts";
import { backlinkIntersectionName, edgeqlTypeToPgType } from "./compiler-base.ts";
import { ExpressionCompilerLayer } from "./compiler-expressions.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

export abstract class ShapeCompilerLayer extends ExpressionCompilerLayer {
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

    Context.pushScope(this.ctx);

    try {
      // Handle the main expression and generate appropriate FROM clause
      const { selectItems, fromClause } = this.compileSelectExpression(
        query.expr,
        query.shape
      );

      // Compile WHERE clause
      let whereClause: SQL.WhereClause | undefined;
      if (query.filter) {
        const condition = this.compileExpression(query.filter);
        whereClause = SQL.createWhereClause(condition);
      }

      // Compile ORDER BY clause
      let orderByClause: SQL.OrderByClause | undefined;
      if (query.orderBy && query.orderBy.length > 0) {
        const items = query.orderBy.map(item => ({
          kind: "OrderByItem" as const,
          expression: this.compileExpression(item.expr),
          direction: item.direction || "ASC" as "ASC" | "DESC"
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

  private compileSelectExpression(
    expr: EdgeQLAST.Expression,
    shape?: EdgeQLAST.Shape
  ): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
  } {
    if (expr.kind === "TypeName") {
      // SELECT User -> SELECT * FROM users
      const typeName = expr.name.parts.join("::");
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
        throw new CompilationError(`Type '${typeName}' not found`);
      }

      // `select <Enum>` enumerates the enum's members as a set of scalars
      // (matching Gel), lowered to `unnest(enum_range(NULL::<pg_enum>))`.
      // There's no physical table, so this must be handled before the
      // object-table path that would emit `FROM account_login_method`.
      if (typeDef.kind === "enum") {
        const sqlType = Context.getEnumSqlType(typeDef.name);
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
          shape
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
      // Check if this identifier references a CTE alias
      const cteAlias = Context.getCTEAlias(this.ctx, expr.name);
      if (cteAlias) {
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

        let selectItems: SQL.SelectItem[];
        if (shape && cteAlias.typeName && cteAlias.typeDef) {
          // Use the underlying type's schema to compile the shape
          selectItems = this.compileShape(
            shape,
            cteAlias.typeName,
            tableAlias
          );
        } else if (cteAlias.typeDef) {
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

    if (expr.kind === "Subquery") {
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

    if (expr.kind === "FunctionCall") {
      // Check if function has a TypeName argument (e.g., count(User))
      // This means we need a FROM clause for that type
      let fromClause = SQL.createFromClause([]);
      for (const arg of expr.args) {
        if (arg.value.kind === "TypeName") {
          const argTypeName = arg.value.name.parts.join("::");
          const argTypeDef = Context.resolveTypeName(this.ctx, argTypeName);
          if (argTypeDef) {
            const tableAlias = Context.addTableAlias(
              this.ctx,
              argTypeName.toLowerCase(),
              argTypeDef.tableName,
              argTypeName
            );
            fromClause = SQL.createFromClause([
              SQL.createTableReference(argTypeDef.tableName, tableAlias)
            ]);
          }
        }
      }
      const compiledExpr = this.compileExpression(expr);
      const selectItems = [SQL.createSelectItem(compiledExpr)];
      return { selectItems, fromClause };
    }

    // For other expressions, compile directly
    const compiledExpr = this.compileExpression(expr);
    const selectItems = [SQL.createSelectItem(compiledExpr)];
    const fromClause = SQL.createFromClause([]); // No FROM clause needed

    return { selectItems, fromClause };
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
        const pgType = edgeqlTypeToPgType(property.edgeqlType ?? property.type);
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
    shape?: EdgeQLAST.Shape
  ): { selectItems: SQL.SelectItem[]; fromClause: SQL.FromClause; } | null {
    const allSubs = Context.getAllSubtypes(this.ctx.schema, resolvedName);
    const concreteSubs = allSubs
      .map(n => this.ctx.schema.types.get(n))
      .filter((t): t is Context.TypeDef => t !== undefined && !t.abstract);

    if (concreteSubs.length === 0) {
      return null;
    }

    // Phase 1 — abstract type's columns. `id` is always present; every
    // property of the abstract type is inherited (same column name) by
    // every subtype, so projecting them is safe regardless of which
    // subtype's table backs the row.
    const inheritedColumns = ["id"];
    for (const prop of typeDef.properties.values()) {
      if (prop.computed) {
        continue;
      }
      const col = prop.columnName ?? prop.name;
      if (!inheritedColumns.includes(col)) {
        inheritedColumns.push(col);
      }
    }

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
      const typeDef = this.ctx.schema.types.get(typeName);
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
  private compilePropertyReference(property: Context.PropertyDef, tableAlias: string): SQL.SQLExpression {
    if (property.computed && property.computedExpr) {
      const parser = new EdgeQLParser(property.computedExpr);
      const expr = parser.parseExpressionOnly();
      return this.compileExpression(expr);
    }
    return SQL.createColumnReference(property.columnName, tableAlias);
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

    let key: string;
    let value: SQL.SQLExpression;

    if (element.name) {
      // Named element (alias or computed property)
      key = element.name.name;
      if (element.computable) {
        // Computed property: name := expression
        value = this.compileExpression(element.expr);
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
          value = this.compilePropertyReference(property, tableAlias);
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
        value = this.compilePropertyReference(property, tableAlias);
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
    const columnRef = SQL.createColumnReference(targetColumn, tableAlias);
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
      const value = SQL.createColumnReference(property.columnName, tableAlias);
      fields.push(SQL.createJsonField(name, value));
    }

    const jsonObject = SQL.createJsonBuildObject(fields);
    return [SQL.createSelectItem(jsonObject)];
  }

  private compileLinkReference(
    link: Context.LinkDef,
    parentAlias: string
  ): SQL.SQLExpression {
    if (link.columnName) {
      // Simple foreign key reference
      return SQL.createColumnReference(link.columnName, parentAlias);
    } else if (link.junctionTable) {
      // Many-to-many: subquery returning array of target IDs via junction table
      const jt = link.junctionTable;
      const srcCol = link.junctionSourceColumn || "source_id";
      const tgtCol = link.junctionTargetColumn || "target_id";

      const subquery = SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(
            SQL.createFunctionCall("jsonb_agg", [
              SQL.createColumnReference(tgtCol, jt)
            ])
          )
        ]),
        from: SQL.createFromClause([SQL.createTableReference(jt)]),
        where: SQL.createWhereClause(
          SQL.createBinaryExpression(
            "=",
            SQL.createColumnReference(srcCol, jt),
            SQL.createColumnReference("id", parentAlias)
          )
        )
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

      const subquery = SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(
            SQL.createFunctionCall("jsonb_agg", [
              SQL.createColumnReference("id", targetTypeDef.tableName)
            ])
          )
        ]),
        from: SQL.createFromClause([
          SQL.createTableReference(targetTypeDef.tableName)
        ]),
        where: SQL.createWhereClause(
          SQL.createBinaryExpression(
            "=",
            SQL.createColumnReference(fkColumn, targetTypeDef.tableName),
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
    // to the outer query.
    Context.pushScope(this.ctx);
    this.ctx.currentScope.aliases.set(
      targetTypeDef.name.replace(/::/g, "_").toLowerCase(),
      {
        table: targetTypeDef.tableName,
        alias: targetTypeDef.tableName,
        type: targetTypeDef.name
      }
    );
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
          targetTypeDef.tableName
        );
        if (field) {
          jsonFields.push(field);
        }
      }
      if (filter) {
        filterCondition = this.compileExpression(filter);
      }
      if (orderBy && orderBy.length > 0) {
        aggOrderBy = orderBy.map(item => ({
          kind: "OrderByItem" as const,
          expression: this.compileExpression(item.expr),
          direction: item.direction || "ASC" as "ASC" | "DESC"
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
        SQL.createColumnReference("id", targetTypeDef.tableName),
        SQL.createColumnReference(link.columnName, parentAlias)
      );
      fromClause = SQL.createFromClause([
        SQL.createTableReference(targetTypeDef.tableName)
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
        SQL.createColumnReference("id", targetTypeDef.tableName)
      );

      const targetTableRef = SQL.createTableReference(
        targetTypeDef.tableName
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
        SQL.createColumnReference(fkColumn, targetTypeDef.tableName),
        SQL.createColumnReference("id", parentAlias)
      );
      fromClause = SQL.createFromClause([
        SQL.createTableReference(targetTypeDef.tableName)
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

  private compilePathExpression(
    path: EdgeQLAST.Path,
    _shape?: EdgeQLAST.Shape
  ): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
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
        const typeDef = Context.resolveTypeName(this.ctx, typeName);
        if (typeDef) {
          const tableAlias = Context.addTableAlias(
            this.ctx,
            typeName.toLowerCase(),
            typeDef.tableName,
            typeName
          );
          const fromClause = SQL.createFromClause([
            SQL.createTableReference(typeDef.tableName, tableAlias)
          ]);
          const property = Context.getProperty(
            this.ctx,
            typeName,
            propStep.name
          );
          if (property) {
            const selectItems = [
              SQL.createSelectItem(
                SQL.createColumnReference(property.columnName, tableAlias)
              )
            ];
            return { selectItems, fromClause };
          }
        }
      }
    }

    throw new CompilationError(
      "Path expression compilation not yet fully implemented"
    );
  }

  protected compilePathInExpression(path: EdgeQLAST.Path): SQL.SQLExpression {
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
            return SQL.createColumnReference(link.columnName, ta.alias);
          }
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
      const linked = this.compileLinkedPath(firstStep.name, secondStep.name);
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
   * Compile an N-step path `.link1.link2....linkN.field` through a chain
   * of single-cardinality links. Builds inside-out:
   *
   * - Start with the source alias's FK column to the first link's target.
   * - For each intermediate link step, wrap with a correlated subquery
   *   `(SELECT "<next_fk>" FROM "<current_target>" WHERE "id" = <inner>)`
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

    if (link.columnName && !link.junctionTable) {
      // Single-FK backlink. Emit a correlated subquery materializing matches
      // as JSON, defaulting to `[]` so a row with no requirements still
      // produces a parseable JSON array instead of NULL.
      const sql = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', "${targetType.tableName}"."id")), '[]'::jsonb) ` +
        `FROM "${targetType.tableName}" ` +
        `WHERE "${targetType.tableName}"."${link.columnName}" = "${currentAlias.alias}"."id")`;
      return { kind: "RawSQLExpression", sql };
    }

    if (link.junctionTable) {
      // Junction-table multi backlink. The target's forward link sits on
      // the `source_id` side by default; the rows we want are reached by
      // joining the junction table on its `target_id` matching the
      // current scope's id, then projecting the source-side target rows.
      const srcCol = link.junctionSourceColumn ?? "source_id";
      const tgtCol = link.junctionTargetColumn ?? "target_id";
      const sql = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', "${targetType.tableName}"."id")), '[]'::jsonb) ` +
        `FROM "${targetType.tableName}" ` +
        `JOIN "${link.junctionTable}" ON "${link.junctionTable}"."${srcCol}" = "${targetType.tableName}"."id" ` +
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
      // the terminal property/id step).
      for (let i = 1; i < stepNames.length - 1; i++) {
        const link = currentTargetType.links.get(stepNames[i]);
        if (!link || link.multi || link.junctionTable || !link.columnName) {
          return null;
        }
        currentSql = `(SELECT "${link.columnName}" FROM "${currentTargetType.tableName}" ` +
          `WHERE "id" = ${currentSql})`;
        const next = Context.resolveTypeName(this.ctx, link.target);
        if (!next) {
          return null;
        }
        currentTargetType = next;
      }

      const finalStep = stepNames[stepNames.length - 1];

      // FK shortcut at the terminus: the chain already evaluates to
      // the target's id, so no extra SELECT is needed.
      if (finalStep === "id") {
        return { kind: "RawSQLExpression", sql: currentSql };
      }

      const targetProp = currentTargetType.properties.get(finalStep);
      if (!targetProp?.columnName) {
        return null;
      }

      const sql = `(SELECT "${targetProp.columnName}" FROM "${currentTargetType.tableName}" ` +
        `WHERE "id" = ${currentSql})`;
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

    const sqlType = Context.getEnumSqlType(enumTypeName);
    return {
      kind: "RawSQLExpression",
      sql: `'${memberName}'::${sqlType}`
    };
  }
}
