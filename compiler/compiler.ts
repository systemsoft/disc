/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL to SQL Compiler
 * Transforms EdgeQL AST into PostgreSQL-compatible SQL. Top layer of the
 * compiler inheritance chain: entry point, access control, query dispatch,
 * DML, with-blocks, for/group queries, globals, config, and introspection.
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import { CompilationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { buildParameterIndex, isMutationQuery } from "./compiler-base.ts";
import { ShapeCompilerLayer } from "./compiler-shapes.ts";
import { getConfigRegistry, lookupConfigKey } from "./config-registry.ts";
import * as Context from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";
import * as SQL from "./sql.ts";

export { buildParameterIndex, buildParameterTypeMap, describeResult, optionalParameterNames, parameterBindOrder } from "./compiler-base.ts";
export type { CompilerOptions, ResultInfo } from "./compiler-base.ts";

/*** One target assigned to a junction-backed multi link, with the link properties set for it. ***/
interface LinkTarget {
  /** SELECT yielding the target rows' `id`. */
  idSelect: SQL.SelectStatement;
  /** Junction columns written for this target: `@role := "admin"` → `{ column: "role", value }`. */
  linkProperties: { column: string; value: SQL.SQLExpression; }[];
}

/*** An update `set { link op targets }` on a junction-backed multi link. ***/
interface MultiLinkOp {
  link: Context.LinkDef;
  operator: ":=" | "+=" | "-=";
  targets: LinkTarget[];
}

export class EdgeQLCompiler extends ShapeCompilerLayer {
  compile(
    query: EdgeQLAST.Query,
    options?: { parameterMap?: Map<string, number>; }
  ): Result<SQL.SQLStatement, CompilationError> {
    try {
      // Establish a stable name → 1-indexed-position map for $name parameters
      // so compileParameter can resolve each reference to a unique `$N`.
      // Caller can pre-supply the map (binary protocol does this so the
      // index lines up with the input typedesc element order); otherwise we
      // walk the AST in first-seen order to derive one.
      this.parameterIndex = options?.parameterMap ??
        buildParameterIndex(query);

      let statement = this.compileQuery(query);

      // Apply access control if enabled
      if (
        this.enableAccessControl && this.accessEvaluator && this.accessInjector
      ) {
        statement = this.applyAccessControl(statement, query);
      }

      return Ok(statement);
    } catch (error) {
      if (error instanceof CompilationError) {
        return Err(error);
      }
      return Err(
        new CompilationError(
          `Compilation failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  private applyAccessControl(
    statement: SQL.SQLStatement,
    query: EdgeQLAST.Query
  ): SQL.SQLStatement {
    if (!this.accessEvaluator || !this.accessInjector) {
      return statement;
    }

    // Per-request bypass (gh/geldata#6358). The HTTP layer gates the
    // override behind admin role; once set here we emit unfiltered SQL.
    if (this.accessContext.bypass) {
      return statement;
    }

    // Determine the object type being accessed
    const objectType = this.extractObjectType(query);
    if (!objectType) {
      return statement; // No type identified, return as-is
    }

    // Policies are registered under TypeDef.name (see adaptAccessPolicies),
    // so resolve the query's spelling (`Doc`, `default::Doc`) to the type and
    // look the policy up by that name, as mutationAccessCondition() does.
    const typeDef = Context.resolveTypeName(this.ctx, objectType);
    if (!typeDef) {
      return statement; // Type not found in schema
    }

    // Apply access control based on statement type
    switch (statement.kind) {
      case "SelectStatement": {
        // Check if access is allowed and inject conditions
        const decision = this.accessEvaluator.evaluate(
          typeDef.name,
          "select",
          this.accessContext
        );

        if (!decision.allowed) {
          // Block access entirely with WHERE FALSE. The user's filter is kept
          // as `FALSE AND (filter)` rather than replaced: the bind list comes
          // from the EdgeQL AST, so dropping a filter that references `$n`
          // leaves PostgreSQL expecting fewer parameters than are sent
          // (08P01). The planner folds the conjunction to FALSE either way.
          const falseCondition: SQL.SQLExpression = {
            kind: "LiteralExpression",
            type: "boolean",
            value: false
          };

          return {
            ...statement,
            where: {
              kind: "WhereClause",
              condition: statement.where ?
                {
                  kind: "BinaryExpression",
                  operator: "AND",
                  left: falseCondition,
                  right: statement.where.condition
                } :
                falseCondition
            }
          };
        }

        if (decision.sqlConditions && decision.sqlConditions.length > 0) {
          // Inject access conditions
          const accessConditions = this.parseAccessConditions(
            decision.sqlConditions
          );
          if (accessConditions) {
            if (statement.where) {
              // Combine with existing WHERE clause
              const combinedCondition: SQL.BinaryExpression = {
                kind: "BinaryExpression",
                operator: "AND",
                left: accessConditions,
                right: statement.where.condition
              };

              return {
                ...statement,
                where: {
                  kind: "WhereClause",
                  condition: combinedCondition
                }
              };
            } else {
              // Add new WHERE clause
              return {
                ...statement,
                where: {
                  kind: "WhereClause",
                  condition: accessConditions
                }
              };
            }
          }
        }

        return statement;
      }

      // Mutations are not handled here: a mutation node can sit anywhere in
      // the query (with binding, for body, explain, multi-link CTE), so
      // compileInsertQuery / compileUpdateQuery / compileDeleteQuery apply
      // their own policy via mutationAccessCondition().

      default:
        return statement;
    }
  }

  private extractObjectType(query: EdgeQLAST.Query): string | undefined {
    switch (query.kind) {
      case "SelectQuery":
        // Extract type from the expression
        if (query.expr?.kind === "TypeName") {
          return query.expr.name.parts.join("::");
        } else if (query.expr?.kind === "Path") {
          // Handle path expressions that start with a type
          const firstStep = query.expr.steps[0];
          if (firstStep.type === "property") {
            return firstStep.name;
          }
        }
        break;
      case "InsertQuery":
        return query.type.name.parts.join(".");
      case "UpdateQuery":
        return query.type.name.parts.join(".");
      case "DeleteQuery":
        return query.type.name.parts.join(".");
    }
    return undefined;
  }

  private parseAccessConditions(
    sqlConditions: string[]
  ): SQL.SQLExpression | null {
    if (sqlConditions.length === 0) {
      return null;
    }

    // For now, create raw SQL expressions
    // In a production system, we'd parse these properly
    const conditions = sqlConditions.map(sql => ({
      kind: "RawSQLExpression" as const,
      sql: sql
    }));

    // Combine multiple conditions with OR (permissive mode)
    // In restrictive mode we'd use AND, but that's handled by the evaluator
    return conditions.slice(1).reduce<SQL.SQLExpression>((acc, cond) => ({
      kind: "BinaryExpression",
      operator: "OR",
      left: acc,
      right: cond
    }), conditions[0]);
  }

  /**
   * Access policy for one mutation node. Called by the three mutation
   * compilers, so the policy follows the node wherever it sits in the query
   * instead of depending on the top-level query kind.
   *
   * Throws when the operation is denied. Returns the row predicate to AND
   * into the mutation's WHERE, or undefined when there is none (access control
   * off, bypass caller, or an unconditional allow).
   *
   * `objectType` must be `TypeDef.name`: policies are registered under it
   * (see `adaptAccessPolicies`), whatever spelling the query used
   * (`Doc`, `default::Doc`).
   */
  private mutationAccessCondition(
    objectType: string,
    operation: "insert" | "update" | "delete"
  ): SQL.SQLExpression | undefined {
    if (!this.enableAccessControl || !this.accessEvaluator || !this.accessInjector) {
      return undefined;
    }

    // Per-request bypass (gh/geldata#6358), same gate as applyAccessControl.
    if (this.accessContext.bypass) {
      return undefined;
    }

    const decision = this.accessEvaluator.evaluate(
      objectType,
      operation,
      this.accessContext
    );
    if (!decision.allowed) {
      throw new CompilationError(
        decision.denialMessage ??
          `${operation.toUpperCase()} not allowed on ${objectType}: ${decision.reason}`
      );
    }

    return this.parseAccessConditions(decision.sqlConditions ?? []) ?? undefined;
  }

  // AND an access predicate into a (possibly absent) WHERE clause.
  private withAccessCondition(
    where: SQL.WhereClause | undefined,
    accessCondition: SQL.SQLExpression | undefined
  ): SQL.WhereClause | undefined {
    if (!accessCondition) {
      return where;
    }

    return SQL.createWhereClause(
      where ?
        SQL.createBinaryExpression("AND", accessCondition, where.condition) :
        accessCondition
    );
  }

  protected compileQuery(query: EdgeQLAST.Query): SQL.SQLStatement {
    switch (query.kind) {
      case "SelectQuery":
        return this.compileSelectQuery(query);
      case "InsertQuery":
        return this.compileInsertQuery(query);
      case "UpdateQuery":
        return this.compileUpdateQuery(query);
      case "DeleteQuery":
        return this.compileDeleteQuery(query);
      case "WithBlock":
        return this.compileWithBlock(query);
      case "ForQuery":
        return this.compileForQuery(query);
      case "GroupQuery":
        return this.compileGroupQuery(query);
      case "DescribeType":
        return this.compileDescribeType(query);
      case "DescribeSchema":
        return this.compileDescribeSchema();
      case "SetGlobalQuery":
        return this.compileSetGlobal(query as EdgeQLAST.SetGlobalQuery);
      case "ExplainQuery":
        return this.compileExplainQuery(query as EdgeQLAST.ExplainQuery);
      case "ConfigureQuery":
        return this.compileConfigureQuery(query as EdgeQLAST.ConfigureQuery);
      default:
        throw new CompilationError(
          `Unsupported query type: ${(query as { kind: string; }).kind}`
        );
    }
  }

  // Compile the value of a link assignment in INSERT/UPDATE. A bare
  // `(select Target filter ...)` in link position must yield the target's id
  // — the FK column stores a uuid, so the default jsonb shape would produce
  // invalid SQL. Any other expression (uuid cast, parameter) compiles
  // normally.
  private compileLinkAssignmentExpression(
    link: Context.LinkDef,
    assigned: EdgeQLAST.Expression
  ): SQL.SQLExpression {
    // `(select T …) { … }`: the shape only matters for its link properties,
    // which a single (FK-column) link cannot store.
    const expr = assigned.kind === "ShapeExpr" ? assigned.expr : assigned;
    const linkProperty = assigned.kind === "ShapeExpr" ? assigned.shape.elements.find(e => e.linkProperty) : undefined;
    if (linkProperty) {
      throw new CompilationError(
        `Link property '@${linkProperty.name?.name}' on link '${link.name}': link properties are only supported on multi links`
      );
    }
    const query = expr.kind === "Subquery" ?
      (expr as EdgeQLAST.Subquery).query :
      expr;

    if (query.kind === "SelectQuery") {
      const select = query as EdgeQLAST.SelectQuery;

      // Only TypeName sources — compileSelectQueryRaw produces a plain
      // `SELECT * FROM table AS alias` for those; narrow it to the id column.
      if (select.expr.kind === "TypeName") {
        const statement = this.compileSelectQueryRaw(select);
        const table = statement.from?.tables[0];

        if (table?.alias) {
          statement.select = SQL.createSelectClause([
            SQL.createSelectItem(
              SQL.createColumnReference("id", table.alias)
            )
          ]);

          return SQL.createSubqueryExpression(statement);
        }
      }
    }

    return this.compileExpression(expr);
  }

  // Compile a multi-link assignment value down to a SELECT yielding the
  // target rows' `id` column. Mirrors compileLinkAssignmentExpression but
  // returns the bare SelectStatement (not wrapped as a SubqueryExpression)
  // so it can drive a junction INSERT/DELETE `SELECT <src>, sub.id FROM (...)`.
  private compileTargetIdSelect(
    expr: EdgeQLAST.Expression
  ): SQL.SelectStatement {
    const query = expr.kind === "Subquery" ?
      (expr as EdgeQLAST.Subquery).query :
      expr;

    if (query.kind === "SelectQuery") {
      const select = query as EdgeQLAST.SelectQuery;
      if (select.expr.kind === "TypeName") {
        const statement = this.compileSelectQueryRaw(select);
        const table = statement.from?.tables[0];
        if (table?.alias) {
          statement.select = SQL.createSelectClause([
            SQL.createSelectItem(
              SQL.createColumnReference("id", table.alias)
            )
          ]);
          return statement;
        }
      }
    }

    // Fallback: wrap whatever the expression compiles to as a single-column
    // `SELECT <expr> AS id`. Covers explicit `<array<uuid>>$x` casts etc.
    return SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(this.compileExpression(expr), "id")
      ])
    });
  }

  /**
   * The targets assigned to a junction-backed multi link, one per element of
   * a set literal (`{(select A …), (select B …)}`; `{}` is no targets), each
   * with the link properties its shape sets:
   * `(select User filter …) { @role := "admin" }`. Link properties are
   * compiled in the statement's scope, so they may reference parameters and
   * `with` bindings but not the target.
   */
  private compileLinkTargets(
    link: Context.LinkDef,
    expr: EdgeQLAST.Expression
  ): LinkTarget[] {
    if (expr.kind === "SetExpr") {
      return expr.elements.flatMap(element => this.compileLinkTargets(link, element));
    }
    if (expr.kind !== "ShapeExpr") {
      return [{ idSelect: this.compileTargetIdSelect(expr), linkProperties: [] }];
    }
    const idSelect = this.compileTargetIdSelect(expr.expr);
    const linkProperties = expr
      .shape
      .elements
      .filter(element => element.linkProperty)
      .map(element => {
        const name = element.name!.name;
        if (!element.computable) {
          throw new CompilationError(`Link property '@${name}' in an assignment must be set with ':=' (e.g. '@${name} := <value>')`);
        }
        return {
          column: Context.getLinkProperty(link, name).columnName,
          value: this.compileExpression(element.expr)
        };
      });
    return [{ idSelect, linkProperties }];
  }

  private compileInsertQuery(
    query: EdgeQLAST.InsertQuery
  ): SQL.InsertStatement | SQL.CTEStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    // Insert policies are allow/deny only (no row check), so there is no
    // predicate to keep.
    this.mutationAccessCondition(typeDef.name, "insert");

    const columns: string[] = [];
    const values: SQL.SQLExpression[] = [];
    // Multi-links (junction-backed, no FK column) are written as separate
    // junction INSERTs in a CTE — collect them here, one per assigned target.
    const multiLinks: { link: Context.LinkDef; target: LinkTarget; }[] = [];

    // Process shape elements to extract column assignments
    for (const element of query.shape.elements) {
      if (!element.name || !element.computable) {
        throw new CompilationError(
          "INSERT requires computed assignments (name := value)"
        );
      }

      const propName = element.name.name;
      const property = Context.getProperty(this.ctx, typeName, propName);
      let singleLink: Context.LinkDef | undefined;
      if (!property) {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link && link.columnName) {
          columns.push(link.columnName);
          singleLink = link;
        } else if (link && link.junctionTable) {
          for (const target of this.compileLinkTargets(link, element.expr)) {
            multiLinks.push({ link, target });
          }
          continue;
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      } else {
        columns.push(property.columnName);
      }

      const value = singleLink ?
        this.compileLinkAssignmentExpression(singleLink, element.expr) :
        property?.multi && !property.computed ?
        this.compileMultiPropertyValue(element.expr, property) :
        this.compileExpression(element.expr);
      values.push(value);
    }

    // Handle conflict resolution
    let onConflict: SQL.OnConflictClause | undefined;
    if (query.unless) {
      const target = this.compileConflictTarget(typeName, query.unless.on);

      if (query.unless.else) {
        // DO UPDATE - extract SET clauses from the else UpdateQuery
        const elseExpr = query.unless.else;
        let updateQuery: EdgeQLAST.UpdateQuery | undefined;

        // The parser wraps ELSE (...) in a Subquery node
        if (elseExpr.kind === "Subquery") {
          const subquery = elseExpr as EdgeQLAST.Subquery;
          if (subquery.query.kind === "UpdateQuery") {
            updateQuery = subquery.query as EdgeQLAST.UpdateQuery;
          }
        } else if (elseExpr.kind === "UpdateQuery") {
          // Direct UpdateQuery (in case parser ever produces this)
          updateQuery = elseExpr as EdgeQLAST.UpdateQuery;
        }

        if (!updateQuery) {
          throw new CompilationError(
            "UPSERT else clause must be an UpdateQuery"
          );
        }

        // The else branch overwrites an existing row, so it answers to the
        // update policy (throws when denied). ON CONFLICT … DO UPDATE cannot
        // carry a row predicate yet — UpdateAction has no WHERE and policy
        // predicates use unqualified columns, ambiguous there between the
        // target row and `excluded` — so a row-level policy fails closed.
        if (this.mutationAccessCondition(typeDef.name, "update")) {
          throw new CompilationError(
            `Upsert (unless conflict … else update) is not supported on '${typeDef.name}' because it has a row-level update policy. ` +
              "Use a separate update, or the service credential."
          );
        }

        const setClauses: SQL.SetClause[] = [];
        for (const element of updateQuery.shape.elements) {
          if (!element.name || !element.computable) {
            throw new CompilationError(
              "UPSERT else clause requires computed assignments (name := value)"
            );
          }

          const propName = element.name.name;
          const property = Context.getProperty(this.ctx, typeName, propName);
          if (!property) {
            const link = Context.getLink(this.ctx, typeName, propName);
            if (link && link.columnName) {
              setClauses.push({
                kind: "SetClause",
                column: link.columnName,
                value: this.compileLinkAssignmentExpression(link, element.expr)
              });
            } else {
              throw new CompilationError(
                `Property '${propName}' not found on type '${typeName}'`
              );
            }
          } else {
            setClauses.push({
              kind: "SetClause",
              column: property.columnName,
              value: property.multi && !property.computed ?
                this.compileMultiPropertyAssignment(property, element.operator ?? ":=", element.expr) :
                this.compileExpression(element.expr)
            });
          }
        }

        const updateAction: SQL.UpdateAction = {
          kind: "UpdateAction",
          set: setClauses
        };

        onConflict = {
          kind: "OnConflictClause",
          target: target.length > 0 ? target : undefined,
          action: updateAction
        };
      } else {
        // DO NOTHING
        onConflict = {
          kind: "OnConflictClause",
          target: target.length > 0 ? target : undefined,
          action: "DO NOTHING"
        };
      }
    }

    const sourceInsert: SQL.InsertStatement = {
      kind: "InsertStatement",
      table: typeDef.tableName,
      columns,
      values: [values],
      onConflict,
      returning: [
        {
          kind: "SelectItem",
          expression: SQL.createColumnReference("*")
        }
      ]
    };

    if (multiLinks.length === 0) {
      return sourceInsert;
    }

    // Multi-link INSERT: wrap the source row in a CTE so each junction INSERT
    // can cross-join the new row's id against its target-id set. The final
    // statement re-selects the inserted row so callers still get `RETURNING *`
    // semantics (raw columns, mapped to the schema shape by the server).
    const ctes: SQL.CTE[] = [{
      kind: "CTE",
      name: "ins",
      recursive: false,
      columns: [],
      query: sourceInsert
    }];

    multiLinks.forEach(({ link, target }, index) => {
      ctes.push(
        this.buildJunctionInsertCTE(
          `link_${index}`,
          link,
          SQL.createColumnReference("id", "ins"),
          target,
          "ins"
        )
      );
    });

    return SQL.withCTEs(ctes, this.selectAllFrom("ins"));
  }

  // Columns of an `unless conflict on …` target: one path, or a tuple of paths,
  // each naming a stored property or a single link of the inserted type. A link
  // is its FK column (`LinkDef.columnName`, built by `linkColumnName()`), the
  // name the migration gives the unique index column, so the conflict target
  // and the index cannot disagree. Anything else is an error: dropping the
  // target would emit a bare ON CONFLICT, which swallows every unique
  // violation, and is invalid SQL in front of DO UPDATE.
  private compileConflictTarget(
    typeName: string,
    on: EdgeQLAST.Expression
  ): string[] {
    // A bare `unless conflict` reaches here as the parser's empty literal.
    if (on.kind === "Literal" && on.type === "empty") {
      return [];
    }

    const paths = on.kind === "TupleExpr" ? on.elements : [on];

    return paths.map(path => {
      if (path.kind !== "Path" || path.steps.length !== 1 || path.steps[0].type !== "property") {
        throw new CompilationError(
          `Unsupported conflict target on '${typeName}': expected a property or single link such as '.name', or a tuple of them`
        );
      }

      const name = path.steps[0].name;
      const property = Context.getProperty(this.ctx, typeName, name);
      const column = property ?
        (property.computed ? undefined : property.columnName) :
        Context.getLink(this.ctx, typeName, name)?.columnName;

      if (!column) {
        throw new CompilationError(
          `Conflict target '.${name}' is not a stored property or single link of '${typeName}'`
        );
      }

      return column;
    });
  }

  // Build a junction INSERT as a CTE row:
  //   <name> AS (
  //     INSERT INTO <junction> (<srcCol>, <tgtCol>[, <linkPropCol>…])
  //     SELECT <sourceId>, sub.id[, <linkPropValue>…] FROM (<idSelect>) AS sub
  //     ON CONFLICT DO NOTHING
  //   )
  // An already-linked target keeps its junction row. When the target sets
  // link properties the conflict clause is instead
  //   ON CONFLICT (<srcCol>, <tgtCol>) DO UPDATE SET <linkPropCol> = EXCLUDED.<linkPropCol>…
  // so `+=` / `:=` update the link properties they name on an existing link;
  // link properties they don't name keep their values.
  // When `crossJoinSource` is set, the source id comes from a preceding CTE
  // (the INSERT path joins `FROM <sourceCteName> CROSS JOIN (sub)`); otherwise
  // the source id is a literal/parameter expression (the UPDATE path).
  private buildJunctionInsertCTE(
    name: string,
    link: Context.LinkDef,
    sourceId: SQL.SQLExpression,
    target: LinkTarget,
    crossJoinSourceCteName?: string
  ): SQL.CTE {
    const { idSelect, linkProperties } = target;
    const srcCol = link.junctionSourceColumn ?? "source_id";
    const tgtCol = link.junctionTargetColumn ?? "target_id";

    const subAlias = "sub";
    const fromTables: SQL.TableReference[] = [];
    if (crossJoinSourceCteName) {
      fromTables.push(SQL.createTableReference(crossJoinSourceCteName));
    }
    fromTables.push({
      kind: "TableReference",
      name: "(subquery)",
      alias: subAlias,
      subquery: idSelect
    });

    const selectStmt = SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(sourceId),
        SQL.createSelectItem(SQL.createColumnReference("id", subAlias)),
        ...linkProperties.map(p => SQL.createSelectItem(p.value))
      ]),
      from: SQL.createFromClause(fromTables)
    });

    const onConflict: SQL.OnConflictClause = linkProperties.length === 0 ?
      { kind: "OnConflictClause", action: "DO NOTHING" } :
      {
        kind: "OnConflictClause",
        target: [srcCol, tgtCol],
        action: {
          kind: "UpdateAction",
          set: linkProperties.map(p => ({
            kind: "SetClause" as const,
            column: p.column,
            value: { kind: "RawSQLExpression" as const, sql: `EXCLUDED."${p.column}"` }
          }))
        }
      };

    const junctionInsert: SQL.InsertStatement = {
      kind: "InsertStatement",
      table: link.junctionTable!,
      columns: [srcCol, tgtCol, ...linkProperties.map(p => p.column)],
      values: [],
      insertSelect: selectStmt,
      onConflict
    };

    return {
      kind: "CTE",
      name,
      recursive: false,
      columns: [],
      query: junctionInsert
    };
  }

  // Build a junction DELETE as a CTE row:
  //   <name> AS (
  //     DELETE FROM <junction>
  //     WHERE <srcCol> IN (SELECT id FROM <sourceCte>)
  //       [AND <tgtCol> {IN|NOT IN} (<idSelect>)]
  //   )
  // The source predicate is a subquery (not a column ref) because a DELETE
  // inside a WITH cannot reference a sibling CTE by name in its WHERE — it
  // must pull the source ids through a `SELECT ... FROM <sourceCte>`.
  //
  // `targetOp` selects the target predicate: "IN" for `-=` (remove the named
  // set) and "NOT IN" for `:=` (clear everything except the new set, so rows
  // already present survive the replace — sibling INSERT/DELETE CTEs run on the
  // same snapshot, so deleting-then-reinserting a kept row would otherwise
  // violate the junction's unique constraint).
  //
  // With several target selects (a set of targets), `IN` matches any of them
  // and `NOT IN` none of them; with none, `NOT IN` deletes every junction row
  // of the source (`link := {}`).
  private buildJunctionDeleteCTE(
    name: string,
    link: Context.LinkDef,
    sourceCteName: string,
    targetIdSelects: SQL.SelectStatement[],
    targetOp: "IN" | "NOT IN" = "IN"
  ): SQL.CTE {
    const srcCol = link.junctionSourceColumn ?? "source_id";
    const tgtCol = link.junctionTargetColumn ?? "target_id";

    let condition: SQL.SQLExpression = SQL.createBinaryExpression(
      "IN",
      SQL.createColumnReference(srcCol),
      SQL.createSubqueryExpression(this.selectIdFrom(sourceCteName))
    );

    const targetConditions = targetIdSelects.map(idSelect =>
      SQL.createBinaryExpression(
        targetOp,
        SQL.createColumnReference(tgtCol),
        SQL.createSubqueryExpression(idSelect)
      )
    );
    if (targetConditions.length > 0) {
      condition = SQL.createBinaryExpression(
        "AND",
        condition,
        targetConditions.reduce((all, next) => SQL.createBinaryExpression(targetOp === "IN" ? "OR" : "AND", all, next))
      );
    }

    const junctionDelete: SQL.DeleteStatement = {
      kind: "DeleteStatement",
      table: link.junctionTable!,
      where: SQL.createWhereClause(condition)
    };

    return {
      kind: "CTE",
      name,
      recursive: false,
      columns: [],
      query: junctionDelete
    };
  }

  // `SELECT * FROM <cteName>` — the final projection of a write CTE so the
  // server's RETURNING-shaped mutation handling still sees the row columns.
  private selectAllFrom(cteName: string): SQL.SelectStatement {
    return SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("*"))
      ]),
      from: SQL.createFromClause([SQL.createTableReference(cteName)])
    });
  }

  // `SELECT id FROM <cteName>` — pulls source ids out of a sibling CTE so a
  // junction DELETE can correlate without referencing the CTE name directly.
  private selectIdFrom(cteName: string): SQL.SelectStatement {
    return SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("id"))
      ]),
      from: SQL.createFromClause([SQL.createTableReference(cteName)])
    });
  }

  // Run `compile` in a scope where relative paths resolve against the mutated
  // type, as they do in a select: `.name` → its column, `.link.id` → the FK
  // column, deeper paths → a correlated subselect. UPDATE and DELETE name their
  // table without an alias, so the table name itself is the qualifier.
  private withMutationScope<T>(
    typeName: string,
    typeDef: Context.TypeDef,
    compile: () => T
  ): T {
    Context.pushScope(this.ctx);
    this.ctx.currentScope.aliases.set(typeName.toLowerCase(), {
      alias: typeDef.tableName,
      table: typeDef.tableName,
      type: typeName
    });

    try {
      return compile();
    } finally {
      Context.popScope(this.ctx);
    }
  }

  private compileUpdateQuery(
    query: EdgeQLAST.UpdateQuery
  ): SQL.UpdateStatement | SQL.CTEStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    return this.withMutationScope(typeName, typeDef, () => this.compileUpdateInScope(query, typeName, typeDef));
  }

  // The body of compileUpdateQuery: `set` and `filter` are compiled with the
  // updated type in scope.
  private compileUpdateInScope(
    query: EdgeQLAST.UpdateQuery,
    typeName: string,
    typeDef: Context.TypeDef
  ): SQL.UpdateStatement | SQL.CTEStatement {
    const setClauses: SQL.SetClause[] = [];
    // Multi-link ops carry their assignment operator so the CTE knows whether
    // to replace (`:=`), add (`+=`), or remove (`-=`) junction rows.
    const multiLinkOps: MultiLinkOp[] = [];

    // Process shape elements to extract SET clauses
    for (const element of query.shape.elements) {
      if (!element.name || !element.computable) {
        throw new CompilationError(
          "UPDATE requires computed assignments (name := value)"
        );
      }

      const propName = element.name.name;
      const property = Context.getProperty(this.ctx, typeName, propName);
      if (!property) {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link && link.columnName) {
          setClauses.push({
            kind: "SetClause",
            column: link.columnName,
            value: this.compileLinkAssignmentExpression(link, element.expr)
          });
        } else if (link && link.junctionTable) {
          multiLinkOps.push({
            link,
            operator: element.operator ?? ":=",
            targets: this.compileLinkTargets(link, element.expr)
          });
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      } else {
        setClauses.push({
          kind: "SetClause",
          column: property.columnName,
          value: property.multi && !property.computed ?
            this.compileMultiPropertyAssignment(property, element.operator ?? ":=", element.expr) :
            this.compileExpression(element.expr)
        });
      }
    }

    // Compile WHERE clause
    let whereClause: SQL.WhereClause | undefined;
    if (query.filter) {
      const condition = this.compileExpression(query.filter);
      whereClause = SQL.createWhereClause(condition);
    }

    // The same WHERE drives both the plain UPDATE and the source CTE of a
    // multi-link update (UPDATE or SELECT), so junction rows are only written
    // for rows the caller may update.
    whereClause = this.withAccessCondition(
      whereClause,
      this.mutationAccessCondition(typeDef.name, "update")
    );

    if (multiLinkOps.length === 0) {
      return {
        kind: "UpdateStatement",
        table: typeDef.tableName,
        set: setClauses,
        where: whereClause,
        returning: [
          {
            kind: "SelectItem",
            expression: SQL.createColumnReference("*")
          }
        ]
      };
    }

    return this.compileMultiLinkUpdate(
      typeDef,
      setClauses,
      whereClause,
      multiLinkOps
    );
  }

  // Build an UPDATE that touches one or more junction-backed multi-links,
  // optionally alongside scalar/single-link SETs. Emits a single atomic CTE:
  //
  //   WITH <source> AS ( <UPDATE ... RETURNING *>  |  <SELECT * FROM table WHERE ...> ),
  //        <junction ops...>
  //   SELECT * FROM <source>
  //
  // The source row's id drives each junction op. When scalar SETs exist the
  // source CTE is the UPDATE itself (so the row is mutated once); otherwise
  // it is a plain SELECT of the matching rows — no empty `UPDATE ... SET`.
  private compileMultiLinkUpdate(
    typeDef: Context.TypeDef,
    setClauses: SQL.SetClause[],
    whereClause: SQL.WhereClause | undefined,
    multiLinkOps: MultiLinkOp[]
  ): SQL.CTEStatement {
    const sourceCte = "upd";
    const sourceId = SQL.createColumnReference("id", sourceCte);

    let sourceQuery: SQL.SQLStatement;
    if (setClauses.length > 0) {
      sourceQuery = {
        kind: "UpdateStatement",
        table: typeDef.tableName,
        set: setClauses,
        where: whereClause,
        returning: [
          {
            kind: "SelectItem",
            expression: SQL.createColumnReference("*")
          }
        ]
      };
    } else {
      sourceQuery = SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(SQL.createColumnReference("*"))
        ]),
        from: SQL.createFromClause([
          SQL.createTableReference(typeDef.tableName)
        ]),
        where: whereClause
      });
    }

    const ctes: SQL.CTE[] = [{
      kind: "CTE",
      name: sourceCte,
      recursive: false,
      columns: [],
      query: sourceQuery
    }];

    // Junction inserts are numbered across all ops (`link_<n>`), one per target.
    let insertCount = 0;
    const insertTargets = (link: Context.LinkDef, targets: LinkTarget[]) => {
      for (const target of targets) {
        ctes.push(this.buildJunctionInsertCTE(`link_${insertCount++}`, link, sourceId, target, sourceCte));
      }
    };

    multiLinkOps.forEach(({ link, operator, targets }, index) => {
      const idSelects = targets.map(target => target.idSelect);
      switch (operator) {
        case ":=": {
          // Replace: delete existing junction rows whose target is NOT in the
          // new set, then insert the new set with ON CONFLICT DO NOTHING (or,
          // for targets setting link properties, DO UPDATE of those). This
          // keeps rows present in both old and new sets — a plain
          // delete-all + insert would, within one snapshot, try to re-insert a
          // just-deleted row and trip the unique constraint.
          ctes.push(
            this.buildJunctionDeleteCTE(
              `del_${index}`,
              link,
              sourceCte,
              idSelects,
              "NOT IN"
            )
          );
          insertTargets(link, targets);
          break;
        }
        case "+=": {
          insertTargets(link, targets);
          break;
        }
        case "-=": {
          // Removing the empty set removes nothing.
          if (idSelects.length > 0) {
            ctes.push(
              this.buildJunctionDeleteCTE(
                `del_${index}`,
                link,
                sourceCte,
                idSelects
              )
            );
          }
          break;
        }
      }
    });

    return SQL.withCTEs(ctes, this.selectAllFrom(sourceCte));
  }

  private compileDeleteQuery(
    query: EdgeQLAST.DeleteQuery
  ): SQL.DeleteStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    // Compile WHERE clause
    let whereClause: SQL.WhereClause | undefined;
    if (query.filter) {
      const filter = query.filter;
      const condition = this.withMutationScope(typeName, typeDef, () => this.compileExpression(filter));
      whereClause = SQL.createWhereClause(condition);
    }

    whereClause = this.withAccessCondition(
      whereClause,
      this.mutationAccessCondition(typeDef.name, "delete")
    );

    return {
      kind: "DeleteStatement",
      table: typeDef.tableName,
      where: whereClause,
      returning: [
        {
          kind: "SelectItem",
          expression: SQL.createColumnReference("*")
        }
      ]
    };
  }

  private compileWithBlock(query: EdgeQLAST.WithBlock): SQL.SQLStatement {
    // Set module scope if WITH MODULE <name> was specified
    const previousModuleScope = this.ctx.moduleScope;
    if (query.module) {
      this.ctx.moduleScope = query.module;
    }

    // Names the block registers, removed again whether or not it compiles: the
    // compiler instance (and its context) outlives the query.
    const registeredAliases: string[] = [];
    // A plain expression binding (`x := <str>$n`) is also a scope variable, so
    // the body can use the name in expression position; it is inlined there.
    // The previous value is kept to restore a shadowed outer name.
    const variables = this.ctx.currentScope.variables;
    const shadowedVariables = new Map<string, Context.VariableDef | undefined>();

    try {
      return this.compileWithBindings(query, registeredAliases, shadowedVariables);
    } finally {
      for (const alias of registeredAliases) {
        Context.removeCTEAlias(this.ctx, alias);
      }
      for (const [name, previous] of shadowedVariables) {
        if (previous) {
          variables.set(name, previous);
        } else {
          variables.delete(name);
        }
      }

      // Restore previous module scope
      this.ctx.moduleScope = previousModuleScope;
    }
  }

  private compileWithBindings(
    query: EdgeQLAST.WithBlock,
    registeredAliases: string[],
    shadowedVariables: Map<string, Context.VariableDef | undefined>
  ): SQL.SQLStatement {
    // Compile each WITH binding into a CTE and register CTE aliases
    const ctes: SQL.CTE[] = [];
    const variables = this.ctx.currentScope.variables;
    const inlinedAliases = new Map<string, Context.CTEAlias>();

    for (const binding of query.bindings) {
      // Validate recursive CTEs: must contain a UNION (which maps to SQL
      // UNION ALL) between a base case and recursive case
      if (binding.recursive) {
        const hasUnion = binding.value.kind === "Subquery" &&
          binding.value.query.kind === "SelectQuery" &&
          binding.value.query.expr.kind === "BinaryOp" &&
          (binding.value.query.expr as EdgeQLAST.BinaryOp).op === "UNION";

        if (!hasUnion) {
          throw new CompilationError(
            `Recursive CTE '${binding.name.name}' must contain a UNION ALL between base case and recursive case`
          );
        }
      }

      let bindingQuery: SQL.SQLStatement;
      let underlyingTypeName: string | undefined;

      if (binding.value.kind === "Subquery") {
        // Extract the underlying type name from the inner query for shape
        // resolution in the body query
        underlyingTypeName = this.extractQueryTypeName(binding.value.query);

        // Compile the CTE inner query as raw columns (SELECT * FROM ...)
        // so the body query can reference individual columns by name
        if (
          underlyingTypeName &&
          binding.value.query.kind === "SelectQuery"
        ) {
          bindingQuery = this.compileSelectQueryRaw(binding.value.query);
        } else {
          bindingQuery = this.compileQuery(binding.value.query);
        }
      } else {
        // Direct expression - wrap in a SELECT
        const expr = this.compileExpression(binding.value);
        bindingQuery = SQL.createSelectStatement({
          select: SQL.createSelectClause([SQL.createSelectItem(expr)])
        });
      }

      const cteName = binding.name.name;

      // Register this CTE alias so the body query can resolve it
      const typeDef = underlyingTypeName ?
        Context.resolveTypeName(this.ctx, underlyingTypeName) :
        undefined;

      const cteAlias: Context.CTEAlias = {
        cteName,
        mutation: binding.value.kind === "Subquery" && isMutationQuery(binding.value.query),
        typeName: underlyingTypeName,
        typeDef
      };
      Context.addCTEAlias(this.ctx, cteName, cteAlias);
      registeredAliases.push(cteName);

      if (binding.value.kind !== "Subquery") {
        shadowedVariables.set(cteName, variables.get(cteName));
        variables.set(cteName, { name: cteName, type: "any", expression: binding.value });
        inlinedAliases.set(cteName, cteAlias);
      }

      ctes.push({
        kind: "CTE",
        name: cteName,
        recursive: binding.recursive || false,
        columns: [],
        query: bindingQuery
      });
    }

    // Compile the body query (CTE aliases are now resolvable)
    const mainQuery = this.compileQuery(query.body);

    // An inlined binding nothing selects from needs no CTE.
    const emitted = ctes.filter(cte => {
      const inlined = inlinedAliases.get(cte.name);
      return !inlined || inlined.referenced;
    });

    // If there are no CTEs (WITH MODULE only, no bindings), return body directly
    if (emitted.length === 0) {
      return mainQuery;
    }

    // Combine CTEs with the main query
    return SQL.withCTEs(emitted, mainQuery);
  }

  /**
   * Compile a SELECT query producing raw columns (SELECT * FROM table WHERE ...)
   * instead of JSON-wrapped output. Used for CTE inner queries so the body
   * query can reference individual columns from the CTE.
   */
  protected compileSelectQueryRaw(
    query: EdgeQLAST.SelectQuery
  ): SQL.SelectStatement {
    Context.pushScope(this.ctx);

    try {
      // Resolve the type and create the FROM clause
      let fromClause: SQL.FromClause;

      if (query.expr.kind === "TypeName") {
        const typeName = query.expr.name.parts.join("::");
        const typeDef = Context.resolveTypeName(this.ctx, typeName);
        if (!typeDef) {
          throw new CompilationError(`Type '${typeName}' not found`);
        }

        const tableAlias = Context.addTableAlias(
          this.ctx,
          typeName.toLowerCase(),
          typeDef.tableName,
          typeName
        );
        fromClause = SQL.createFromClause([
          SQL.createTableReference(typeDef.tableName, tableAlias)
        ]);
      } else {
        // Fall back to the regular compile path for non-type expressions
        return this.compileSelectQuery(query) as SQL.SelectStatement;
      }

      // Compile WHERE clause
      let whereClause: SQL.WhereClause | undefined;
      if (query.filter) {
        const condition = this.compileExpression(query.filter);
        whereClause = SQL.createWhereClause(condition);
      }

      // SELECT * (raw columns, no JSON wrapping)
      const selectClause = SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("*"))
      ]);

      return SQL.createSelectStatement({
        select: selectClause,
        from: fromClause,
        where: whereClause
      });
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /**
   * Extract the underlying type name from a query, if it references a known
   * schema type. Used by compileWithBlock to associate CTE aliases with types.
   */
  private extractQueryTypeName(query: EdgeQLAST.Query): string | undefined {
    if (query.kind === "SelectQuery") {
      if (query.expr?.kind === "TypeName") {
        return query.expr.name.parts.join("::");
      }
      if (query.expr?.kind === "Path") {
        const firstStep = query.expr.steps[0];
        if (firstStep?.type === "property") {
          // Check if this is a known type
          const typeDef = Context.resolveTypeName(this.ctx, firstStep.name);
          if (typeDef) {
            return firstStep.name;
          }
        }
      }
    }
    // A mutation binding returns rows of the mutated type (`RETURNING *`), so
    // the body can project a shape over it like over a select binding.
    if (isMutationQuery(query)) {
      return query.type.name.parts.join("::");
    }
    return undefined;
  }

  private compileForQuery(query: EdgeQLAST.ForQuery): SQL.SQLStatement {
    const varName = query.variable.name;

    if (query.iterator.kind === "SetExpr") {
      // Set literal iterator: FOR x IN {a, b, c} UNION (body)
      // Expand into UNION ALL of body compiled for each element
      const elements = query.iterator.elements;

      if (elements.length === 0) {
        throw new CompilationError("FOR query requires non-empty set iterator");
      }

      const compiledQueries: SQL.SQLStatement[] = [];

      for (const element of elements) {
        Context.pushScope(this.ctx);

        // Bind the variable in scope
        this.ctx.currentScope.variables.set(varName, {
          name: varName,
          type: "any",
          expression: element
        });

        const bodyStmt = this.compileQuery(query.body);
        compiledQueries.push(bodyStmt);

        Context.popScope(this.ctx);
      }

      if (compiledQueries.length === 1) {
        return compiledQueries[0];
      }

      // If all queries are INSERTs into the same table, merge into a single
      // multi-row INSERT instead of UNION ALL (which is invalid for INSERTs)
      if (
        compiledQueries.every(q =>
          q.kind === "InsertStatement" &&
          (q as SQL.InsertStatement).table ===
            (compiledQueries[0] as SQL.InsertStatement).table
        )
      ) {
        const first = compiledQueries[0] as SQL.InsertStatement;
        const mergedValues: SQL.SQLExpression[][] = [];
        for (const q of compiledQueries) {
          const insert = q as SQL.InsertStatement;
          for (const row of insert.values) {
            mergedValues.push(row);
          }
        }
        return {
          kind: "InsertStatement",
          table: first.table,
          columns: first.columns,
          values: mergedValues,
          returning: first.returning,
          onConflict: first.onConflict
        } as SQL.InsertStatement;
      }

      return SQL.unionAll(compiledQueries);
    }

    // Row-source iterator: a subquery, or a set-returning function call
    // (`json_array_unpack(…)`, `array_unpack(…)`, `range_unpack(…)`). Either is a
    // FROM item `… AS for_iter(val)`, and the variable is its one column.
    const iteratorTable = this.compileForIteratorTable(query.iterator);

    Context.pushScope(this.ctx);

    try {
      this.ctx.currentScope.variables.set(varName, {
        name: varName,
        // `isJsonExpression` reads this: elements of a JSON array are json.
        type: this.isJsonArrayUnpack(query.iterator) ? "json" : "any",
        expression: { kind: "Literal", type: "empty", value: null },
        sqlOverride: SQL.createColumnReference("val", "for_iter")
      });

      // An insert body is one `INSERT INTO t (cols) SELECT <exprs> FROM <iterator>`.
      // PostgreSQL has no INSERT inside LATERAL.
      if (query.body.kind === "InsertQuery") {
        return this.compileBulkInsert(query.body, iteratorTable);
      }

      // An update or delete inside LATERAL is not valid PostgreSQL either. The
      // subquery-iterator form has always emitted it; the function-iterator
      // form is new and says so instead.
      if (query.iterator.kind === "FunctionCall" && (query.body.kind === "UpdateQuery" || query.body.kind === "DeleteQuery")) {
        throw new CompilationError(
          "A FOR query over a function iterator supports an insert or select body. " +
            "Run the update or delete once, with a filter over the whole set (e.g. `filter .id in array_unpack(…)`)."
        );
      }

      const bodyStmt = this.compileQuery(query.body);

      // Build: SELECT for_sub.* FROM <iterator> AS for_iter(val), LATERAL (body) AS for_sub
      return SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(SQL.createColumnReference("*", "for_sub"))
        ]),
        from: SQL.createFromClause([
          iteratorTable,
          {
            kind: "TableReference",
            name: "",
            subquery: bodyStmt,
            lateral: true,
            alias: "for_sub"
          }
        ])
      });
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /*** Functions a FOR query can iterate: each returns a set, one row per element. ***/
  private static readonly FOR_ITERATOR_FUNCTIONS = new Set(["json_array_unpack", "array_unpack", "range_unpack"]);

  private isJsonArrayUnpack(iterator: EdgeQLAST.Expression): boolean {
    return iterator.kind === "FunctionCall" && Context.lookupFunction(this.ctx.schema, iterator.name.parts)?.name === "json_array_unpack";
  }

  private compileForIteratorTable(iterator: EdgeQLAST.Expression): SQL.TableReference {
    if (iterator.kind === "Subquery") {
      return {
        kind: "TableReference",
        name: "",
        subquery: this.compileQuery(iterator.query),
        alias: "for_iter",
        columnAliases: ["val"]
      };
    }

    const functionName = iterator.kind === "FunctionCall" ? Context.lookupFunction(this.ctx.schema, iterator.name.parts)?.name : undefined;
    if (iterator.kind !== "FunctionCall" || !functionName || !EdgeQLCompiler.FOR_ITERATOR_FUNCTIONS.has(functionName)) {
      throw new CompilationError(
        `FOR query iterator must be a set literal, a subquery, or a call to json_array_unpack, array_unpack or range_unpack, got ${
          iterator.kind === "FunctionCall" ? `${iterator.name.parts.join("::")}()` : iterator.kind
        }`
      );
    }

    // The call stays a SQL AST node so a `<json>$rows` argument is still found
    // by `buildParameterTypeMap`.
    return {
      kind: "TableReference",
      name: "",
      expression: this.compileExpression(iterator),
      alias: "for_iter",
      columnAliases: ["val"]
    };
  }

  /**
   * `for x in <iterator> union (insert T { … })` as a single statement, whatever
   * the number of rows. The insert is compiled by `compileInsertQuery` — access
   * policy, link assignments and conflict target included — and its one VALUES
   * row becomes the select list over the iterator.
   *
   * Only `id` comes back: a bulk insert's rows can be large (`content`), and
   * the ids are enough to tell which rows were new when there is a conflict
   * clause.
   */
  private compileBulkInsert(body: EdgeQLAST.InsertQuery, iteratorTable: SQL.TableReference): SQL.InsertStatement {
    const insert = this.compileInsertQuery(body);
    if (insert.kind !== "InsertStatement") {
      throw new CompilationError(
        "A bulk insert (for … union (insert …)) cannot assign a multi link. Insert the objects first, then add the links with an update."
      );
    }

    return {
      ...insert,
      values: [],
      insertSelect: SQL.createSelectStatement({
        select: SQL.createSelectClause(insert.values[0].map(value => SQL.createSelectItem(value))),
        from: SQL.createFromClause([iteratorTable])
      }),
      returning: [SQL.createSelectItem(SQL.createColumnReference("id"))]
    };
  }

  private compileGroupQuery(query: EdgeQLAST.GroupQuery): SQL.SelectStatement {
    // The expr must be a TypeName so we can resolve the table
    if (query.expr.kind !== "TypeName") {
      throw new CompilationError(
        "GROUP query expression must be a type name"
      );
    }

    const typeName = query.expr.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const tableAlias = Context.addTableAlias(
      this.ctx,
      typeName.toLowerCase(),
      typeDef.tableName,
      typeName
    );

    const fromClause = SQL.createFromClause([
      SQL.createTableReference(typeDef.tableName, tableAlias)
    ]);

    // Build GROUP BY expressions from the BY clause
    const groupByExprs: SQL.SQLExpression[] = [];
    const keyFields: SQL.JsonField[] = [];

    for (const byExpr of query.by.elements) {
      if (byExpr.kind === "Path" && byExpr.steps.length === 1) {
        const propName = byExpr.steps[0].name;
        const property = Context.getProperty(this.ctx, typeName, propName);
        if (property) {
          const colRef = SQL.createColumnReference(
            property.columnName,
            tableAlias
          );
          groupByExprs.push(colRef);
          keyFields.push(SQL.createJsonField(propName, colRef));
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      } else if (byExpr.kind === "Identifier") {
        // Bare identifier — look up as property
        const propName = byExpr.name;
        const property = Context.getProperty(this.ctx, typeName, propName);
        if (property) {
          const colRef = SQL.createColumnReference(
            property.columnName,
            tableAlias
          );
          groupByExprs.push(colRef);
          keyFields.push(SQL.createJsonField(propName, colRef));
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      } else {
        // Fallback: compile the expression directly
        const compiled = this.compileExpression(byExpr);
        groupByExprs.push(compiled);
        keyFields.push(SQL.createJsonField("expr", compiled));
      }
    }

    // Build the 'key' as jsonb_build_object of the BY fields
    const keyObject = SQL.createJsonBuildObject(keyFields);

    // Build 'elements' as jsonb_agg of all properties
    const allFields: SQL.JsonField[] = [];
    for (const [name, property] of typeDef.properties) {
      allFields.push(
        SQL.createJsonField(
          name,
          SQL.createColumnReference(property.columnName, tableAlias)
        )
      );
    }
    const elementsAgg = SQL.createJsonAgg(
      SQL.createJsonBuildObject(allFields)
    );

    // Final SELECT: jsonb_build_object('key', key_obj, 'elements', elements_agg)
    const resultObject = SQL.createJsonBuildObject([
      SQL.createJsonField("key", keyObject),
      SQL.createJsonField("elements", elementsAgg)
    ]);

    const selectClause = SQL.createSelectClause([
      SQL.createSelectItem(resultObject)
    ]);
    const groupByClause: SQL.GroupByClause = {
      kind: "GroupByClause",
      expressions: groupByExprs
    };

    // Compile FILTER to HAVING clause
    let havingClause: SQL.HavingClause | undefined;
    if (query.filter) {
      const havingCondition = this.compileExpression(query.filter);
      havingClause = {
        kind: "HavingClause",
        condition: havingCondition
      };
    }

    return SQL.createSelectStatement({
      select: selectClause,
      from: fromClause,
      groupBy: groupByClause,
      having: havingClause
    });
  }

  /**
   * Compile a GlobalRef expression to SQL.
   *
   * Produces: current_setting('disc.global_default__current_user_id', true)::uuid
   *
   * Uses PostgreSQL's current_setting() with the missing_ok flag set to true
   * so that unset globals return NULL rather than raising an error.
   */
  protected compileGlobalRef(expr: EdgeQLAST.GlobalRef): SQL.SQLExpression {
    const qualifiedName = expr.module ?
      `${expr.module}::${expr.name}` :
      expr.name;
    const globalDef = Context.resolveGlobal(
      this.ctx.schema,
      qualifiedName,
      this.ctx.moduleScope
    );
    if (!globalDef) {
      throw new CompilationError(`Unknown global: ${qualifiedName}`);
    }

    const functionCall = SQL.createFunctionCall("current_setting", [
      SQL.createLiteral("string", globalDef.pgSettingName),
      SQL.createLiteral("boolean", true)
    ]);

    return SQL.createCastExpression(functionCall, globalDef.pgType);
  }

  /**
   * Compile a SET GLOBAL query to SQL.
   *
   * Produces: SELECT set_config('disc.global_default__current_user_id', <value>::text, true)
   *
   * Uses set_config() instead of SET LOCAL because PostgreSQL only allows
   * SET LOCAL for registered GUC parameters. set_config() works with
   * arbitrary parameter names.
   *
   * Readonly globals cannot be set and will raise a CompilationError.
   */
  private compileSetGlobal(
    query: EdgeQLAST.SetGlobalQuery
  ): SQL.RawSQLStatement {
    const qualifiedName = query.module ?
      `${query.module}::${query.name}` :
      query.name;
    const globalDef = Context.resolveGlobal(
      this.ctx.schema,
      qualifiedName,
      this.ctx.moduleScope
    );
    if (!globalDef) {
      throw new CompilationError(`Unknown global: ${qualifiedName}`);
    }
    if (globalDef.readonly) {
      throw new CompilationError(
        `Cannot SET readonly global: ${qualifiedName}`
      );
    }

    const valueSql = this.compileExpression(query.value);
    const codegen = new SQLCodeGenerator();
    const valueStr = codegen.generateExpression(valueSql);

    return {
      kind: "RawSQLStatement",
      sql: `SELECT set_config('${globalDef.pgSettingName}', ${valueStr}::text, true)`
    };
  }

  private compileExplainQuery(
    query: EdgeQLAST.ExplainQuery
  ): SQL.RawSQLStatement {
    const innerStatement = this.compileQuery(query.query);
    const codegen = new SQLCodeGenerator();
    const innerSql = codegen.generate(innerStatement);

    const options: string[] = ["FORMAT JSON"];
    if (query.analyze) {
      options.push("ANALYZE");
    }
    if (query.buffers) {
      options.push("BUFFERS");
    }

    return {
      kind: "RawSQLStatement",
      sql: `EXPLAIN (${options.join(", ")}) ${innerSql}`
    };
  }

  private compileConfigureQuery(
    query: EdgeQLAST.ConfigureQuery
  ): SQL.RawSQLStatement {
    const pgKey = lookupConfigKey(query.key)?.pgName ?? query.key;

    if (query.action === "RESET") {
      if (query.scope === "SESSION") {
        return { kind: "RawSQLStatement", sql: `RESET ${pgKey}` };
      }
      if (query.scope === "SYSTEM") {
        return {
          kind: "RawSQLStatement",
          sql: `ALTER SYSTEM RESET ${pgKey}`
        };
      }
      // DATABASE/INSTANCE: delete from config table
      return {
        kind: "RawSQLStatement",
        sql: `DELETE FROM disc_config WHERE key = '${query.key}' AND scope = '${query.scope}'`
      };
    }

    // SET action
    if (!query.value) {
      throw new CompilationError("CONFIGURE SET requires a value");
    }

    const codegen = new SQLCodeGenerator();
    const valueSql = codegen.generateExpression(
      this.compileExpression(query.value)
    );

    if (query.scope === "SESSION") {
      return {
        kind: "RawSQLStatement",
        sql: `SET LOCAL ${pgKey} = ${valueSql}`
      };
    }
    if (query.scope === "SYSTEM") {
      return {
        kind: "RawSQLStatement",
        sql: `ALTER SYSTEM SET ${pgKey} = ${valueSql}`
      };
    }
    // DATABASE/INSTANCE: upsert into config table
    return {
      kind: "RawSQLStatement",
      sql:
        `INSERT INTO disc_config (key, value, scope, updated) VALUES ('${query.key}', to_jsonb(${valueSql}), '${query.scope}', NOW()) ON CONFLICT (key) DO UPDATE SET value = to_jsonb(${valueSql}), updated = NOW()`
    };
  }

  /**
   * Compile a schema:: introspection function call into a SELECT returning
   * a JSON literal. These functions are resolved at compile time from the
   * in-memory schema, following the same pattern as DESCRIBE TYPE/SCHEMA.
   */
  protected compileIntrospectionFunction(
    qualifiedName: string,
    funcCall: EdgeQLAST.FunctionCall
  ): SQL.RawSQLExpression {
    let json: string;

    switch (qualifiedName) {
      case "schema::types": {
        const description = describeSchema(this.ctx.schema);
        const typeNames = description.types.map(t => t.name);
        json = JSON.stringify(typeNames);
        break;
      }

      case "schema::get_type": {
        if (funcCall.args.length !== 1) {
          throw new CompilationError(
            "schema::get_type() requires exactly 1 argument"
          );
        }
        const arg = funcCall.args[0].value;
        if (arg.kind !== "Literal" || arg.type !== "string") {
          throw new CompilationError(
            "schema::get_type() argument must be a string literal"
          );
        }
        const typeName = arg.value as string;
        const description = describeType(this.ctx.schema, typeName);
        json = JSON.stringify(description);
        break;
      }

      case "schema::functions": {
        const description = describeSchema(this.ctx.schema);
        const funcNames = description.functions.map(f => f.name);
        json = JSON.stringify(funcNames);
        break;
      }

      case "cfg::describe_settings": {
        // #5988 + #6444: registry of CONFIGURE-able keys with secret flag.
        // Values are not included here — querying current values requires
        // a SQL roundtrip (SHOW or disc_config select), which a separate
        // admin endpoint will handle while applying maskIfSecret().
        json = JSON.stringify(getConfigRegistry());
        break;
      }

      default:
        throw new CompilationError(
          `Unknown introspection function: ${qualifiedName}`
        );
    }

    return {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };
  }

  protected compileTypeName(typeName: EdgeQLAST.TypeName): SQL.SQLExpression {
    // For function arguments, a TypeName like "User" often means "all User objects"
    // In the context of count(User), this would be like "SELECT * FROM users"
    const name = typeName.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, name);
    if (!typeDef) {
      throw new CompilationError(`Type '${name}' not found`);
    }

    // Generate a simple column reference for the primary table
    // In a full implementation, this might create a subquery
    return SQL.createColumnReference("*");
  }
}
