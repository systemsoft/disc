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
import { buildParameterIndex } from "./compiler-base.ts";
import { ShapeCompilerLayer } from "./compiler-shapes.ts";
import { getConfigRegistry, lookupConfigKey } from "./config-registry.ts";
import * as Context from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";
import * as SQL from "./sql.ts";

export { buildParameterIndex } from "./compiler-base.ts";
export type { CompilerOptions } from "./compiler-base.ts";

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

    // Get the table name for the type
    const typeDef = this.ctx.schema.types.get(objectType);
    if (!typeDef) {
      return statement; // Type not found in schema
    }

    // Apply access control based on statement type
    switch (statement.kind) {
      case "SelectStatement": {
        // Check if access is allowed and inject conditions
        const decision = this.accessEvaluator.evaluate(
          objectType,
          "select",
          this.accessContext
        );

        if (!decision.allowed) {
          // Block access entirely with WHERE FALSE
          const falseCondition: SQL.SQLExpression = {
            kind: "LiteralExpression",
            type: "boolean",
            value: false
          };

          return {
            ...statement,
            where: {
              kind: "WhereClause",
              condition: falseCondition
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

      case "InsertStatement": {
        // Check if INSERT is allowed
        const decision = this.accessEvaluator.evaluate(
          objectType,
          "insert",
          this.accessContext
        );
        if (!decision.allowed) {
          throw new CompilationError(
            decision.denialMessage ??
              `INSERT not allowed on ${objectType}: ${decision.reason}`
          );
        }
        return statement;
      }

      case "UpdateStatement": {
        // Check if UPDATE is allowed and inject conditions
        const decision = this.accessEvaluator.evaluate(
          objectType,
          "update",
          this.accessContext
        );
        if (!decision.allowed) {
          throw new CompilationError(
            decision.denialMessage ??
              `UPDATE not allowed on ${objectType}: ${decision.reason}`
          );
        }

        if (decision.sqlConditions && decision.sqlConditions.length > 0) {
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

      case "DeleteStatement": {
        // Check if DELETE is allowed and inject conditions
        const decision = this.accessEvaluator.evaluate(
          objectType,
          "delete",
          this.accessContext
        );
        if (!decision.allowed) {
          throw new CompilationError(
            decision.denialMessage ??
              `DELETE not allowed on ${objectType}: ${decision.reason}`
          );
        }

        if (decision.sqlConditions && decision.sqlConditions.length > 0) {
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

      default:
        return statement;
    }
  }

  private extractObjectType(query: EdgeQLAST.Query): string | undefined {
    switch (query.kind) {
      case "SelectQuery":
        // Extract type from the expression
        if (query.expr?.kind === "TypeName") {
          return query.expr.name.parts.join(".");
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
    expr: EdgeQLAST.Expression
  ): SQL.SQLExpression {
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

  private compileInsertQuery(
    query: EdgeQLAST.InsertQuery
  ): SQL.InsertStatement | SQL.CTEStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const columns: string[] = [];
    const values: SQL.SQLExpression[] = [];
    // Multi-links (junction-backed, no FK column) are written as separate
    // junction INSERTs in a CTE — collect them here, keyed by link.
    const multiLinks: { link: Context.LinkDef; idSelect: SQL.SelectStatement; }[] = [];

    // Process shape elements to extract column assignments
    for (const element of query.shape.elements) {
      if (!element.name || !element.computable) {
        throw new CompilationError(
          "INSERT requires computed assignments (name := value)"
        );
      }

      const propName = element.name.name;
      const property = Context.getProperty(this.ctx, typeName, propName);
      let isLink = false;
      if (!property) {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link && link.columnName) {
          columns.push(link.columnName);
          isLink = true;
        } else if (link && link.junctionTable) {
          multiLinks.push({
            link,
            idSelect: this.compileTargetIdSelect(element.expr)
          });
          continue;
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      } else {
        columns.push(property.columnName);
      }

      const value = isLink ?
        this.compileLinkAssignmentExpression(element.expr) :
        this.compileExpression(element.expr);
      values.push(value);
    }

    // Handle conflict resolution
    let onConflict: SQL.OnConflictClause | undefined;
    if (query.unless) {
      const target: string[] = [];
      if (query.unless.on && query.unless.on.kind === "Path") {
        const step = query.unless.on.steps[0];
        if (step.name) {
          const property = Context.getProperty(this.ctx, typeName, step.name);
          if (property) {
            target.push(property.columnName);
          }
        }
      }

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
                value: this.compileLinkAssignmentExpression(element.expr)
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
              value: this.compileExpression(element.expr)
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

    multiLinks.forEach(({ link, idSelect }, index) => {
      ctes.push(
        this.buildJunctionInsertCTE(
          `link_${index}`,
          link,
          SQL.createColumnReference("id", "ins"),
          idSelect,
          true,
          "ins"
        )
      );
    });

    return SQL.withCTEs(ctes, this.selectAllFrom("ins"));
  }

  // Build a junction INSERT as a CTE row:
  //   <name> AS (
  //     INSERT INTO <junction> (<srcCol>, <tgtCol>)
  //     SELECT <sourceId>, sub.id FROM (<idSelect>) AS sub
  //     [ON CONFLICT DO NOTHING]
  //   )
  // When `crossJoinSource` is set, the source id comes from a preceding CTE
  // (the INSERT path joins `FROM <sourceCteName> CROSS JOIN (sub)`); otherwise
  // the source id is a literal/parameter expression (the UPDATE path).
  private buildJunctionInsertCTE(
    name: string,
    link: Context.LinkDef,
    sourceId: SQL.SQLExpression,
    idSelect: SQL.SelectStatement,
    onConflictDoNothing: boolean,
    crossJoinSourceCteName?: string
  ): SQL.CTE {
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
        SQL.createSelectItem(SQL.createColumnReference("id", subAlias))
      ]),
      from: SQL.createFromClause(fromTables)
    });

    const junctionInsert: SQL.InsertStatement = {
      kind: "InsertStatement",
      table: link.junctionTable!,
      columns: [srcCol, tgtCol],
      values: [],
      insertSelect: selectStmt,
      onConflict: onConflictDoNothing ?
        { kind: "OnConflictClause", action: "DO NOTHING" } :
        undefined
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
  private buildJunctionDeleteCTE(
    name: string,
    link: Context.LinkDef,
    sourceCteName: string,
    targetIdSelect?: SQL.SelectStatement,
    targetOp: "IN" | "NOT IN" = "IN"
  ): SQL.CTE {
    const srcCol = link.junctionSourceColumn ?? "source_id";
    const tgtCol = link.junctionTargetColumn ?? "target_id";

    let condition: SQL.SQLExpression = SQL.createBinaryExpression(
      "IN",
      SQL.createColumnReference(srcCol),
      SQL.createSubqueryExpression(this.selectIdFrom(sourceCteName))
    );

    if (targetIdSelect) {
      condition = SQL.createBinaryExpression(
        "AND",
        condition,
        SQL.createBinaryExpression(
          targetOp,
          SQL.createColumnReference(tgtCol),
          SQL.createSubqueryExpression(targetIdSelect)
        )
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

  private compileUpdateQuery(
    query: EdgeQLAST.UpdateQuery
  ): SQL.UpdateStatement | SQL.CTEStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const setClauses: SQL.SetClause[] = [];
    // Multi-link ops carry their assignment operator so the CTE knows whether
    // to replace (`:=`), add (`+=`), or remove (`-=`) junction rows.
    const multiLinkOps: {
      link: Context.LinkDef;
      operator: ":=" | "+=" | "-=";
      idSelect: SQL.SelectStatement;
    }[] = [];

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
            value: this.compileLinkAssignmentExpression(element.expr)
          });
        } else if (link && link.junctionTable) {
          multiLinkOps.push({
            link,
            operator: element.operator ?? ":=",
            idSelect: this.compileTargetIdSelect(element.expr)
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
          value: this.compileExpression(element.expr)
        });
      }
    }

    // Compile WHERE clause
    let whereClause: SQL.WhereClause | undefined;
    if (query.filter) {
      const condition = this.compileExpression(query.filter);
      whereClause = SQL.createWhereClause(condition);
    }

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
    multiLinkOps: {
      link: Context.LinkDef;
      operator: ":=" | "+=" | "-=";
      idSelect: SQL.SelectStatement;
    }[]
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

    multiLinkOps.forEach(({ link, operator, idSelect }, index) => {
      switch (operator) {
        case ":=": {
          // Replace: delete existing junction rows whose target is NOT in the
          // new set, then insert the new set with ON CONFLICT DO NOTHING. This
          // keeps rows present in both old and new sets untouched — a plain
          // delete-all + insert would, within one snapshot, try to re-insert a
          // just-deleted row and trip the unique constraint.
          ctes.push(
            this.buildJunctionDeleteCTE(
              `del_${index}`,
              link,
              sourceCte,
              idSelect,
              "NOT IN"
            )
          );
          ctes.push(
            this.buildJunctionInsertCTE(
              `link_${index}`,
              link,
              sourceId,
              idSelect,
              true,
              sourceCte
            )
          );
          break;
        }
        case "+=": {
          ctes.push(
            this.buildJunctionInsertCTE(
              `link_${index}`,
              link,
              sourceId,
              idSelect,
              true,
              sourceCte
            )
          );
          break;
        }
        case "-=": {
          ctes.push(
            this.buildJunctionDeleteCTE(
              `del_${index}`,
              link,
              sourceCte,
              idSelect
            )
          );
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
      const condition = this.compileExpression(query.filter);
      whereClause = SQL.createWhereClause(condition);
    }

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

    // Compile each WITH binding into a CTE and register CTE aliases
    const ctes: SQL.CTE[] = [];
    const registeredAliases: string[] = [];

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

      Context.addCTEAlias(this.ctx, cteName, {
        cteName,
        typeName: underlyingTypeName,
        typeDef
      });
      registeredAliases.push(cteName);

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

    // Clean up CTE aliases after body compilation
    for (const alias of registeredAliases) {
      Context.removeCTEAlias(this.ctx, alias);
    }

    // Restore previous module scope
    this.ctx.moduleScope = previousModuleScope;

    // If there are no CTEs (WITH MODULE only, no bindings), return body directly
    if (ctes.length === 0) {
      return mainQuery;
    }

    // Combine CTEs with the main query
    return SQL.withCTEs(ctes, mainQuery);
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

    // Subquery iterator: FOR x IN (SELECT ...) UNION (body)
    // Compile to: SELECT for_sub.* FROM (iterator) AS for_iter(val), LATERAL (body) AS for_sub
    if (query.iterator.kind === "Subquery") {
      const iteratorStmt = this.compileQuery(query.iterator.query);

      Context.pushScope(this.ctx);

      // Bind variable to a column reference on the iterator alias
      this.ctx.currentScope.variables.set(varName, {
        name: varName,
        type: "any",
        expression: { kind: "Literal", type: "empty", value: null },
        sqlOverride: SQL.createColumnReference("val", "for_iter")
      });

      const bodyStmt = this.compileQuery(query.body);

      Context.popScope(this.ctx);

      // Build: SELECT for_sub.* FROM (iterator) AS for_iter(val), LATERAL (body) AS for_sub
      return SQL.createSelectStatement({
        select: SQL.createSelectClause([
          SQL.createSelectItem(SQL.createColumnReference("*", "for_sub"))
        ]),
        from: SQL.createFromClause([
          {
            kind: "TableReference",
            name: "",
            subquery: iteratorStmt,
            alias: "for_iter",
            columnAliases: ["val"]
          },
          {
            kind: "TableReference",
            name: "",
            subquery: bodyStmt,
            lateral: true,
            alias: "for_sub"
          }
        ])
      });
    }

    throw new CompilationError(
      `FOR query iterator must be a set literal or subquery, got ${query.iterator.kind}`
    );
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
