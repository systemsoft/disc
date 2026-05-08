/**
 * EdgeQL to SQL Compiler
 * Transforms EdgeQL AST into PostgreSQL-compatible SQL
 */

import { AccessConfig, AccessContext, AccessEvaluator, AccessPolicy, AccessSQLInjector } from "../access/mod.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { getConfigRegistry, lookupConfigKey } from "./config-registry.ts";
import * as Context from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";
import * as SQL from "./sql.ts";

/** Maps EdgeQL type names to PostgreSQL type names */
function edgeqlTypeToPgType(edgeqlType: string): string {
  const typeMap: Record<string, string> = {
    str: "text",
    int16: "smallint",
    int32: "integer",
    int64: "bigint",
    float32: "real",
    float64: "double precision",
    bool: "boolean",
    bytes: "bytea",
    datetime: "timestamptz",
    duration: "interval",
    json: "jsonb",
    uuid: "uuid",
    bigint: "numeric",
    decimal: "numeric",
    sequence: "bigint",
    "std::str": "text",
    "std::int16": "smallint",
    "std::int32": "integer",
    "std::int64": "bigint",
    "std::float32": "real",
    "std::float64": "double precision",
    "std::bool": "boolean",
    "std::bytes": "bytea",
    "std::datetime": "timestamptz",
    "std::duration": "interval",
    "std::json": "jsonb",
    "std::uuid": "uuid",
    "std::bigint": "numeric",
    "std::decimal": "numeric",
    "cal::local_date": "date",
    "cal::local_time": "time without time zone",
    "cal::local_datetime": "timestamp without time zone",
    "cal::relative_duration": "interval",
    "cal::date_duration": "interval",
    // Array types
    "array<str>": "text[]",
    "array<int16>": "smallint[]",
    "array<int32>": "integer[]",
    "array<int64>": "bigint[]",
    "array<float32>": "real[]",
    "array<float64>": "double precision[]",
    "array<bool>": "boolean[]",
    "array<uuid>": "uuid[]",
    "array<datetime>": "timestamptz[]",
    "array<json>": "jsonb[]",
    "array<bytes>": "bytea[]",
    "array<bigint>": "numeric[]",
    "array<decimal>": "numeric[]",
    "array<cal::local_date>": "date[]",
    "array<cal::local_time>": "time without time zone[]",
    "array<cal::local_datetime>": "timestamp without time zone[]",
    // Range types
    "range<int32>": "int4range",
    "range<int64>": "int8range",
    "range<float64>": "numrange",
    "range<decimal>": "numrange",
    "range<datetime>": "tstzrange",
    "range<cal::local_date>": "daterange",
    "range<cal::local_datetime>": "tsrange",
    // Multirange types
    "multirange<int32>": "int4multirange",
    "multirange<int64>": "int8multirange",
    "multirange<float64>": "nummultirange",
    "multirange<decimal>": "nummultirange",
    "multirange<datetime>": "tstzmultirange",
    "multirange<cal::local_date>": "datemultirange",
    "multirange<cal::local_datetime>": "tsmultirange"
  };
  if (typeMap[edgeqlType]) {
    return typeMap[edgeqlType];
  }

  // Tuple types map to jsonb (PostgreSQL has no native tuple type)
  if (edgeqlType.startsWith("tuple<")) {
    return "jsonb";
  }

  return edgeqlType;
}

export interface CompilerOptions {
  enableAccessControl?: boolean;
  accessConfig?: AccessConfig;
  accessContext?: AccessContext;
}

/**
 * Walk a query AST and assign each named parameter a 1-indexed position
 * in first-seen order. Numeric parameters (`$0`, `$1`, ...) are skipped
 * because they bring their own index from the source. Used by `compile()`
 * when the caller doesn't pre-supply a map.
 */
export function buildParameterIndex(node: unknown): Map<string, number> {
  const out = new Map<string, number>();

  function visit(n: unknown): void {
    if (!n || typeof n !== "object")
      return;
    const obj = n as { kind?: string; name?: string; };
    if (obj.kind === "Parameter" && typeof obj.name === "string") {
      const bare = obj.name.startsWith("$") ? obj.name.slice(1) : obj.name;
      // Numeric parameters keep their source-supplied index.
      if (Number.isNaN(parseInt(bare, 10)) && !out.has(bare)) {
        out.set(bare, out.size + 1);
      }
    }
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v)
          visit(item);
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }

  visit(node);
  return out;
}

export class EdgeQLCompiler {
  private ctx: Context.CompilationContext;
  private accessEvaluator?: AccessEvaluator;
  private accessInjector?: AccessSQLInjector;
  private accessContext: AccessContext;
  private enableAccessControl: boolean;
  /**
   * Maps each named EdgeQL parameter (without leading `$`) to its 1-indexed
   * position in the bound-values array. Populated at the start of compile()
   * by walking the AST in first-seen order, so PG `$N` placeholders line up
   * with the values the binary protocol layer (and any other caller passing
   * `parameterMap`) supplies in that same order.
   */
  private parameterIndex: Map<string, number> = new Map();

  constructor(schema: Context.Schema, options?: CompilerOptions) {
    this.ctx = Context.createContext(schema);

    // Access control is enabled by default
    this.enableAccessControl = options?.enableAccessControl !== false;
    this.accessContext = options?.accessContext || {};

    if (this.enableAccessControl) {
      // Initialize access control with default permissive config
      const config = options?.accessConfig || {
        mode: "permissive",
        defaultAllow: true,
        enableRLS: true,
        enableAudit: false
      };

      this.accessEvaluator = new AccessEvaluator(config);
      this.accessInjector = new AccessSQLInjector(this.accessEvaluator);
    }
  }

  /**
   * Register an access policy (only works if access control is enabled)
   */
  registerAccessPolicy(policy: AccessPolicy): void {
    if (this.accessEvaluator) {
      this.accessEvaluator.registerPolicy(policy);
    }
  }

  /**
   * Set the access context for the current compilation
   */
  setAccessContext(context: AccessContext): void {
    this.accessContext = context;
  }

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
    if (sqlConditions.length === 0)
      return null;

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
        throw new CompilationError(`Unsupported query type: ${(query as { kind: string; }).kind}`);
    }
  }

  private compileSelectQuery(
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
        if (polymorphic)
          return polymorphic;
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
      if (!element.typeFilter)
        continue;
      const propName = element.name?.name ||
        (element.expr.kind === "Identifier" ? element.expr.name : "");
      if (!propName)
        continue;
      const filterTypeDef = Context.resolveTypeName(this.ctx, element.typeFilter);
      if (!filterTypeDef)
        continue;

      // Property path (Bundle BB).
      const property = filterTypeDef.properties.get(propName);
      if (property) {
        const colName = property.columnName ?? property.name;
        if (inheritedColumns.includes(colName))
          continue;
        if (cols.has(colName))
          continue;
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
        if (inheritedColumns.includes(colName))
          continue;
        if (cols.has(colName))
          continue;
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

    if (concreteSubs.length === 0)
      return null;

    // Phase 1 — abstract type's columns. `id` is always present; every
    // property of the abstract type is inherited (same column name) by
    // every subtype, so projecting them is safe regardless of which
    // subtype's table backs the row.
    const inheritedColumns = ["id"];
    for (const prop of typeDef.properties.values()) {
      if (prop.computed)
        continue;
      const col = prop.columnName ?? prop.name;
      if (!inheritedColumns.includes(col))
        inheritedColumns.push(col);
    }

    // Phase 2 — subtype-specific columns referenced via polymorphic
    // shape fields like `[IS Circle].radius`. Without this projection
    // the outer CASE expression in `compilePolymorphicShapeElement`
    // resolves `<alias>.radius` against the union, which doesn't have
    // the column → "column shape_1.radius does not exist". Each branch
    // now projects either the actual column (when the subtype owns it)
    // or `NULL::<pg-type> AS <colName>` (when it doesn't), so PG's
    // UNION column-resolution sees a consistent shape across branches.
    const polymorphicColumns = shape ? this.collectPolymorphicShapeColumns(shape, inheritedColumns) : new Map<string, string>();
    const allBranchColumns = [...inheritedColumns, ...polymorphicColumns.keys()];

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

    const subquery: SQL.SQLStatement = branches.length === 1 ? branches[0] : SQL.unionAll(branches);

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
        if (seen.has(name))
          return;
        seen.add(name);
        out.push({
          kind: "ShapeElement",
          expr: EdgeQLAST.createIdentifier(name)
        });
      };
      pushIfNew("id");
      for (const propName of typeDef.properties.keys()) {
        pushIfNew(propName);
      }
    }
    return out;
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
          value = this.compileLinkWithShape(link, element.shape, tableAlias);
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
          value = SQL.createColumnReference(property.columnName, tableAlias);
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
        value = SQL.createColumnReference(property.columnName, tableAlias);
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

    // Add all properties
    for (const [name, property] of typeDef.properties) {
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
        `${link.name.toLowerCase()}_id`;

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
    parentAlias: string
  ): SQL.SQLExpression {
    // Generate a subquery for the linked type with the given shape
    const targetTypeDef = Context.getTypeDef(this.ctx, link.target);
    if (!targetTypeDef) {
      throw new CompilationError(
        `Target type '${link.target}' not found for link '${link.name}'`
      );
    }

    // Build the JSON fields for the subquery's shape
    const jsonFields: SQL.JsonField[] = [];
    for (const element of shape.elements) {
      if (element.expr.kind === "Identifier") {
        const propName = element.expr.name;
        const property = Context.getProperty(this.ctx, link.target, propName);
        if (property) {
          jsonFields.push(
            SQL.createJsonField(
              propName,
              SQL.createColumnReference(
                property.columnName,
                targetTypeDef.tableName
              )
            )
          );
        }
      }
    }

    const jsonObject = SQL.createJsonBuildObject(jsonFields);
    const jsonAgg = SQL.createJsonAgg(jsonObject);

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

    // Build the subquery
    const subquery: SQL.SelectStatement = SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(jsonAgg)]),
      from: fromClause,
      where: SQL.createWhereClause(joinCondition)
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

  protected compileExpression(expr: EdgeQLAST.Expression): SQL.SQLExpression {
    switch (expr.kind) {
      case "Literal":
        return this.compileLiteral(expr);
      case "Identifier":
        return this.compileIdentifier(expr);
      case "BinaryOp":
        return this.compileBinaryOp(expr);
      case "UnaryOp":
        return this.compileUnaryOp(expr);
      case "FunctionCall":
        return this.compileFunctionCall(expr);
      case "WindowFunctionCall":
        return this.compileWindowFunctionCall(expr);
      case "Parameter":
        return this.compileParameter(expr);
      case "TypeCast":
        return this.compileTypeCast(expr);
      case "Path":
        return this.compilePathInExpression(expr);
      case "TypeName":
        return this.compileTypeName(expr);
      case "SetExpr":
        return this.compileSetExpr(expr);
      case "Subquery":
        return this.compileSubqueryExpression(expr);
      case "IfElse":
        return this.compileIfElse(expr as EdgeQLAST.IfElse);
      case "CaseExpression":
        return this.compileCaseExpression(
          expr as EdgeQLAST.CaseExpression
        );
      case "ArrayExpr":
        return this.compileArrayExpr(expr as EdgeQLAST.ArrayExpr);
      case "TupleExpr":
        return this.compileTupleExpr(expr as EdgeQLAST.TupleExpr);
      case "NamedTuple":
        return this.compileNamedTuple(expr as EdgeQLAST.NamedTuple);
      case "TupleAccessExpr":
        return this.compileTupleAccess(expr as EdgeQLAST.TupleAccessExpr);
      case "Detached":
        return this.compileDetached(expr as EdgeQLAST.Detached);
      case "Introspection":
        return this.compileIntrospection(expr as EdgeQLAST.Introspection);
      case "IndexExpression":
        return this.compileIndexExpression(
          expr as EdgeQLAST.IndexExpression
        );
      case "SliceExpression":
        return this.compileSliceExpression(
          expr as EdgeQLAST.SliceExpression
        );
      case "GlobalRef":
        return this.compileGlobalRef(expr as EdgeQLAST.GlobalRef);
      default:
        throw new CompilationError(`Unsupported expression: ${expr.kind}`);
    }
  }

  private compileLiteral(literal: EdgeQLAST.Literal): SQL.LiteralExpression {
    let sqlType: "string" | "number" | "boolean" | "null";

    switch (literal.type) {
      case "string":
        sqlType = "string";
        break;
      case "integer":
      case "float":
        sqlType = "number";
        break;
      case "boolean":
        sqlType = "boolean";
        break;
      case "empty":
        sqlType = "null";
        break;
      default:
        throw new CompilationError(`Unsupported literal type: ${literal.type}`);
    }

    return SQL.createLiteral(sqlType, literal.value);
  }

  private compileIdentifier(
    identifier: EdgeQLAST.Identifier
  ): SQL.SQLExpression {
    // Check scope variables first (e.g., FOR loop variable)
    const varDef = this.ctx.currentScope.variables.get(identifier.name);
    if (varDef) {
      if (varDef.sqlOverride)
        return varDef.sqlOverride;
      return this.compileExpression(varDef.expression);
    }

    // Check parent scopes
    for (let i = this.ctx.scopes.length - 1; i >= 0; i--) {
      const parentVar = this.ctx.scopes[i].variables.get(identifier.name);
      if (parentVar) {
        if (parentVar.sqlOverride)
          return parentVar.sqlOverride;
        return this.compileExpression(parentVar.expression);
      }
    }

    throw new CompilationError(
      `Standalone identifier '${identifier.name}' cannot be resolved`
    );
  }

  private compileBinaryOp(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression {
    // Handle IS / IS NOT for polymorphic type checking
    if (binOp.op === "IS" || binOp.op === "IS NOT") {
      return this.compileIsTypeCheck(binOp);
    }

    const left = this.compileExpression(binOp.left);
    const right = this.compileExpression(binOp.right);

    // Map EdgeQL operators to SQL operators
    let sqlOp: string = binOp.op;
    switch (binOp.op) {
      case "++":
        sqlOp = "||"; // String concatenation in PostgreSQL
        break;
      case "LIKE":
      case "ILIKE":
        sqlOp = binOp.op;
        break;
      // Range operators — same syntax in PG
      case "@>":
      case "<@":
      case "&&":
      case "-|-":
        sqlOp = binOp.op;
        break;
      // Bitwise operators — same syntax in PG
      case "&":
      case "|":
      case "<<":
      case ">>":
        sqlOp = binOp.op;
        break;
      case "^":
        sqlOp = "#"; // PG uses # for bitwise XOR
        break;
      // Regex operators — same syntax in PG
      case "~":
      case "!~":
      case "~*":
      case "!~*":
        sqlOp = binOp.op;
        break;
    }

    return SQL.createBinaryExpression(sqlOp, left, right);
  }

  /**
   * Compile IS / IS NOT type checks into discriminator column checks.
   *
   * `expr IS Type` where Type has subtypes ->
   *   __type__ IN ('Type', 'Sub1', 'Sub2', ...)
   *
   * `expr IS Type` where Type is a leaf ->
   *   __type__ = 'Type'
   *
   * `expr IS NOT Type` -> negated versions of the above
   */
  private compileIsTypeCheck(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression {
    const isNot = binOp.op === "IS NOT";

    // The right side should be a TypeName or Identifier referring to a type
    let typeName: string;
    if (binOp.right.kind === "TypeName") {
      typeName = binOp.right.name.parts.join("::");
    } else if (binOp.right.kind === "Identifier") {
      typeName = binOp.right.name;
    } else {
      // Fallback: compile as generic IS / IS NOT (e.g., IS NULL)
      const left = this.compileExpression(binOp.left);
      const right = this.compileExpression(binOp.right);
      return SQL.createBinaryExpression(binOp.op, left, right);
    }

    // Resolve the type in the schema
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(
        `Type '${typeName}' not found in schema for IS check`
      );
    }

    // Build the list of matching type names (type + all transitive subtypes)
    const allTypes = [
      typeDef.name,
      ...Context.getAllSubtypes(this.ctx.schema, typeDef.name)
    ];

    // Compile the left side (the expression being checked)
    // For paths like `.prop IS Type`, the left side resolves to a table alias
    // The discriminator column is always "__type__" on whatever table context
    // we're currently in.
    // For a simple pattern like `Shape IS Circle`, the left side is the type
    // reference itself. We need the table alias to reference __type__.
    const discriminatorCol = SQL.createColumnReference("__type__");

    if (allTypes.length === 1) {
      // Leaf type: simple equality check
      const op = isNot ? "!=" : "=";
      return SQL.createBinaryExpression(
        op,
        discriminatorCol,
        SQL.createLiteral("string", allTypes[0])
      );
    }

    // Multiple types: IN / NOT IN expression
    const typeList = allTypes.map(t => `'${t}'`).join(", ");
    const inOp = isNot ? "NOT IN" : "IN";

    return {
      kind: "RawSQLExpression" as const,
      sql: `__type__ ${inOp} (${typeList})`
    };
  }

  /** Check if an EdgeQL binary operator is a set operation. */
  private isSetOperator(op: string): boolean {
    return op === "UNION" || op === "INTERSECT" || op === "EXCEPT";
  }

  /**
   * Compile a BinaryOp representing a set operation (UNION, INTERSECT, EXCEPT)
   * into a SQL UnionAllStatement with the appropriate operator.
   */
  private compileSetOperation(
    binOp: EdgeQLAST.BinaryOp
  ): SQL.UnionAllStatement {
    // Map EdgeQL set operator to SQL set operator
    let sqlOp: SQL.SetOperator;
    switch (binOp.op) {
      case "UNION":
        sqlOp = "UNION ALL";
        break;
      case "INTERSECT":
        sqlOp = "INTERSECT";
        break;
      case "EXCEPT":
        sqlOp = "EXCEPT";
        break;
      default:
        throw new CompilationError(`Unsupported set operator: ${binOp.op}`);
    }

    // Compile left and right operands as queries
    const leftStmt = this.compileSetOperand(binOp.left);
    const rightStmt = this.compileSetOperand(binOp.right);

    return SQL.setOperation(sqlOp, [leftStmt, rightStmt]);
  }

  /**
   * Compile a set operation operand. The operand is typically a Subquery
   * wrapping a SelectQuery, but could be another BinaryOp for chained
   * set operations.
   */
  private compileSetOperand(expr: EdgeQLAST.Expression): SQL.SQLStatement {
    if (expr.kind === "Subquery") {
      return this.compileQuery(expr.query);
    }
    if (expr.kind === "BinaryOp" && this.isSetOperator(expr.op)) {
      return this.compileSetOperation(expr);
    }
    // Fallback: wrap expression in a SELECT
    const compiled = this.compileExpression(expr);
    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(compiled)])
    });
  }

  private compileUnaryOp(unaryOp: EdgeQLAST.UnaryOp): SQL.UnaryExpression {
    return {
      kind: "UnaryExpression",
      operator: unaryOp.op,
      operand: this.compileExpression(unaryOp.operand)
    };
  }

  /** Renders a SQL AST expression to a SQL string (for RawSQLExpression construction) */
  private renderSqlExpr(expr: SQL.SQLExpression): string {
    return new SQLCodeGenerator().generateExpression(expr);
  }

  private compileFunctionCall(
    funcCall: EdgeQLAST.FunctionCall
  ): SQL.SQLExpression {
    const functionName = funcCall.name.parts.join("_");
    const qualifiedName = funcCall.name.parts.join("::");

    // Check for schema:: / cfg:: introspection functions
    if (
      qualifiedName.startsWith("schema::") ||
      qualifiedName.startsWith("cfg::")
    ) {
      return this.compileIntrospectionFunction(qualifiedName, funcCall);
    }

    const args = funcCall.args.map(arg => this.compileExpression(arg.value));

    // Special compilation for functions that aren't simple 1:1 mappings
    switch (functionName) {
      case "contains": {
        // Overloaded: string contains vs range contains
        // String: contains(str, sub) → STRPOS(str, sub) > 0
        // Range: contains(range, elem) → range @> elem
        if (args.length !== 2) {
          throw new CompilationError("contains() requires exactly 2 arguments");
        }
        const containsFirstArg = funcCall.args[0].value;
        const isContainsRangeArg = containsFirstArg.kind === "FunctionCall" &&
          containsFirstArg.name.parts.join("_") === "range";
        if (isContainsRangeArg) {
          return SQL.createBinaryExpression("@>", args[0], args[1]);
        }
        return SQL.createBinaryExpression(
          ">",
          SQL.createFunctionCall("STRPOS", args),
          SQL.createLiteral("number", 0)
        );
      }

      case "find":
        // find(str, sub) → STRPOS(str, sub) - 1
        // PG STRPOS is 1-indexed (0 = not found), EdgeQL find is 0-indexed (-1 = not found)
        if (args.length !== 2) {
          throw new CompilationError("find() requires exactly 2 arguments");
        }
        return SQL.createBinaryExpression(
          "-",
          SQL.createFunctionCall("STRPOS", args),
          SQL.createLiteral("number", 1)
        );

      case "to_str":
        if (args.length !== 1) {
          throw new CompilationError("to_str() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "text");

      case "to_int64":
        if (args.length !== 1) {
          throw new CompilationError("to_int64() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "bigint");

      case "to_float64":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_float64() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "double precision");

      // Additional type cast functions
      case "to_int16":
        if (args.length !== 1) {
          throw new CompilationError("to_int16() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "smallint");

      case "to_int32":
        if (args.length !== 1) {
          throw new CompilationError("to_int32() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "integer");

      case "to_float32":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_float32() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "real");

      case "to_bigint":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_bigint() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "numeric");

      case "to_decimal":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_decimal() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "numeric");

      case "to_bool":
        if (args.length !== 1) {
          throw new CompilationError("to_bool() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "boolean");

      case "to_uuid":
        if (args.length !== 1) {
          throw new CompilationError("to_uuid() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "uuid");

      case "to_datetime":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_datetime() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(
          args[0],
          "timestamp with time zone"
        );

      case "to_duration":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_duration() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "interval");

      // Calendar conversion functions → CAST
      case "cal_to_local_date":
        if (args.length !== 1) {
          throw new CompilationError(
            "cal::to_local_date() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "date");

      case "cal_to_local_time":
        if (args.length !== 1) {
          throw new CompilationError(
            "cal::to_local_time() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(
          args[0],
          "time without time zone"
        );

      case "cal_to_local_datetime":
        if (args.length !== 1) {
          throw new CompilationError(
            "cal::to_local_datetime() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(
          args[0],
          "timestamp without time zone"
        );

      // String functions with special compilation
      case "str_starts_with":
        // str_starts_with(s, prefix) → STARTS_WITH(s, prefix) (PG 15+)
        if (args.length !== 2) {
          throw new CompilationError(
            "str_starts_with() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("STARTS_WITH", args);

      case "str_ends_with":
        // str_ends_with(s, suffix) → RIGHT(s, LENGTH(suffix)) = suffix
        if (args.length !== 2) {
          throw new CompilationError(
            "str_ends_with() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression(
          "=",
          SQL.createFunctionCall("RIGHT", [
            args[0],
            SQL.createFunctionCall("LENGTH", [args[1]])
          ]),
          args[1]
        );

      // Math special compilation
      case "math_e":
        // math::e() → EXP(1)
        return SQL.createFunctionCall("EXP", [
          SQL.createLiteral("number", 1)
        ]);

      case "math_log10":
        // math::log10(val) → LOG(10, val) — PG LOG(b, x) is base-b logarithm
        if (args.length !== 1) {
          throw new CompilationError(
            "math_log10() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("LOG", [
          SQL.createLiteral("number", 10),
          args[0]
        ]);

      case "math_log2":
        // math::log2(val) → LOG(2, val) — PG LOG(b, x) is base-b logarithm
        if (args.length !== 1) {
          throw new CompilationError(
            "math_log2() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("LOG", [
          SQL.createLiteral("number", 2),
          args[0]
        ]);

      // Regex functions with special compilation
      case "re_match":
        // re_match(pattern, str) → REGEXP_MATCH(str, pattern) — swap args
        if (args.length !== 2) {
          throw new CompilationError(
            "re_match() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_MATCH", [args[1], args[0]]);

      case "re_match_all":
        // re_match_all(pattern, str) → REGEXP_MATCHES(str, pattern, 'g')
        if (args.length !== 2) {
          throw new CompilationError(
            "re_match_all() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_MATCHES", [
          args[1],
          args[0],
          SQL.createLiteral("string", "g")
        ]);

      case "re_replace":
        // re_replace(pattern, sub, str) → REGEXP_REPLACE(str, pattern, sub)
        if (args.length !== 3) {
          throw new CompilationError(
            "re_replace() requires exactly 3 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_REPLACE", [
          args[2],
          args[0],
          args[1]
        ]);

      case "re_test":
        // re_test(pattern, str) → str ~ pattern
        if (args.length !== 2) {
          throw new CompilationError(
            "re_test() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression("~", args[1], args[0]);

      // Datetime special compilation
      case "datetime_get": {
        // datetime_get(val, field) → EXTRACT(field FROM val)
        if (args.length !== 2) {
          throw new CompilationError(
            "datetime_get() requires exactly 2 arguments"
          );
        }
        const getFieldArg = funcCall.args[1].value;
        const getField = getFieldArg.kind === "Literal" &&
            typeof getFieldArg.value === "string" ?
          getFieldArg.value :
          "epoch";
        return {
          kind: "RawSQLExpression" as const,
          sql: `EXTRACT(${getField} FROM ${this.renderSqlExpr(args[0])})`
        };
      }

      case "datetime_truncate": {
        // datetime_truncate(val, field) → DATE_TRUNC(field, val)
        if (args.length !== 2) {
          throw new CompilationError(
            "datetime_truncate() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("DATE_TRUNC", [args[1], args[0]]);
      }

      // JSON special compilation
      case "json_get":
        // json_get(val, key) → val -> key
        if (args.length !== 2) {
          throw new CompilationError(
            "json_get() requires exactly 2 arguments"
          );
        }
        return SQL.createJsonbAccess(args[0], "->", args[1]);

      // Array special compilation
      case "array_get":
        // array_get(arr, n) → arr[n + 1] (PG is 1-indexed)
        if (args.length !== 2) {
          throw new CompilationError(
            "array_get() requires exactly 2 arguments"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `(${this.renderSqlExpr(args[0])})[${this.renderSqlExpr(args[1])} + 1]`
        };

      // Set functions with special compilation
      case "enumerate":
        // enumerate(val) → ROW_NUMBER() OVER () paired with val as jsonb array
        if (args.length !== 1) {
          throw new CompilationError(
            "enumerate() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `jsonb_build_array(ROW_NUMBER() OVER () - 1, ${this.renderSqlExpr(args[0])})`
        };

      case "distinct":
        // distinct(expr) → wraps expression with DISTINCT keyword
        if (args.length !== 1) {
          throw new CompilationError(
            "distinct() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `DISTINCT ${this.renderSqlExpr(args[0])}`
        };

      case "exists":
        // exists(expr) → EXISTS (subquery) or (expr IS NOT NULL)
        if (args.length !== 1) {
          throw new CompilationError(
            "exists() requires exactly 1 argument"
          );
        }
        return SQL.createBinaryExpression(
          "IS NOT",
          args[0],
          SQL.createLiteral("null", null)
        );

      // Sequence functions
      case "sequence_next":
        // sequence_next(name) → NEXTVAL(name)
        if (args.length !== 1) {
          throw new CompilationError(
            "sequence_next() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("NEXTVAL", args);

      case "sequence_reset":
        // sequence_reset(name, val) → SETVAL(name, val)
        if (args.length !== 2) {
          throw new CompilationError(
            "sequence_reset() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("SETVAL", args);

      // Range & Multirange functions
      case "range": {
        // range(lower, upper) → type-dependent PG range constructor
        // Detect type from literal args: integer → int4range, float → numrange
        if (args.length !== 2) {
          throw new CompilationError(
            "range() requires exactly 2 arguments"
          );
        }
        let rangeConstructor = "int4range"; // default
        if (funcCall.args.length >= 1) {
          const firstArg = funcCall.args[0].value;
          if (firstArg.kind === "Literal") {
            if (firstArg.type === "float") {
              rangeConstructor = "numrange";
            }
            // integer → int4range (default), string literal could be date/timestamp
          }
        }
        return SQL.createFunctionCall(rangeConstructor, args);
      }

      case "multirange": {
        // multirange(r) → type-dependent PG multirange constructor
        // Default to int4multirange; enhanced type inference can be added later
        if (args.length !== 1) {
          throw new CompilationError(
            "multirange() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("int4multirange", args);
      }

      case "overlaps":
        // overlaps(r1, r2) → r1 && r2
        if (args.length !== 2) {
          throw new CompilationError(
            "overlaps() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression("&&", args[0], args[1]);

      // Full-text search functions (ext::fts)
      case "fts_search":
        // fts::search(query) → fts_vector @@ plainto_tsquery('english', query)
        if (args.length !== 1) {
          throw new CompilationError(
            "fts::search() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `fts_vector @@ plainto_tsquery('english', ${this.renderSqlExpr(args[0])})`
        };

      case "fts_rank":
        // fts::rank(query) → ts_rank(fts_vector, plainto_tsquery('english', query))
        if (args.length !== 1) {
          throw new CompilationError(
            "fts::rank() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `ts_rank(fts_vector, plainto_tsquery('english', ${this.renderSqlExpr(args[0])}))`
        };
    }

    // Standard 1:1 function name mapping. The registry is keyed by the
    // underscore-joined form (`std_md5`); fall back to the qualified
    // form (`std::md5`) for entries that prefer the user-facing key.
    let sqlName = functionName;
    const funcDef = this.ctx.schema.functions.get(functionName) ??
      this.ctx.schema.functions.get(qualifiedName);
    if (funcDef?.windowOnly) {
      throw new CompilationError(
        `Function '${functionName}' requires an OVER clause`
      );
    }
    if (funcDef?.sqlName) {
      sqlName = funcDef.sqlName;
    }

    return SQL.createFunctionCall(sqlName, args);
  }

  private compileWindowFunctionCall(
    wfc: EdgeQLAST.WindowFunctionCall
  ): SQL.WindowFunctionExpression {
    const functionName = wfc.name.parts.join("_");
    const args = wfc.args.map(arg => this.compileExpression(arg.value));

    // Map function name to SQL
    let sqlName = functionName;
    const funcDef = this.ctx.schema.functions.get(functionName);
    if (!funcDef?.windowOnly && !funcDef?.windowCompatible) {
      throw new CompilationError(
        `Function '${functionName}' cannot be used with an OVER clause`
      );
    }
    if (funcDef?.sqlName) {
      sqlName = funcDef.sqlName;
    }

    // Compile the OVER clause
    const over = this.compileWindowOverClause(wfc.over);

    return SQL.windowFunction(sqlName, args, over);
  }

  private compileWindowOverClause(
    over: EdgeQLAST.WindowOverClause
  ): SQL.WindowClause {
    // Compile PARTITION BY
    let partitionBy: SQL.SQLExpression[] | undefined;
    if (over.partitionBy && over.partitionBy.length > 0) {
      partitionBy = over.partitionBy.map(expr => this.compileExpression(expr));
    }

    // Compile ORDER BY
    let orderBy: SQL.OrderByItem[] | undefined;
    if (over.orderBy && over.orderBy.length > 0) {
      orderBy = over.orderBy.map(item => ({
        kind: "OrderByItem" as const,
        expression: this.compileExpression(item.expr),
        direction: item.direction || "ASC" as "ASC" | "DESC"
      }));
    }

    // Compile frame spec
    let frame: SQL.WindowFrame | undefined;
    if (over.frame) {
      const start = this.compileFrameBound(over.frame.start);
      const end = over.frame.end ? this.compileFrameBound(over.frame.end) : start;

      frame = {
        kind: "WindowFrame",
        mode: over.frame.mode,
        start,
        end,
        exclude: over.frame.exclude
      };
    }

    return {
      kind: "WindowClause",
      partitionBy,
      orderBy,
      frame
    };
  }

  private compileFrameBound(bound: EdgeQLAST.FrameBound): string {
    switch (bound.type) {
      case "UNBOUNDED PRECEDING":
        return "UNBOUNDED PRECEDING";
      case "CURRENT ROW":
        return "CURRENT ROW";
      case "UNBOUNDED FOLLOWING":
        return "UNBOUNDED FOLLOWING";
      case "OFFSET PRECEDING": {
        // Extract literal value for the offset
        if (bound.offset && bound.offset.kind === "Literal") {
          return `${bound.offset.value} PRECEDING`;
        }
        return "0 PRECEDING";
      }
      case "OFFSET FOLLOWING": {
        if (bound.offset && bound.offset.kind === "Literal") {
          return `${bound.offset.value} FOLLOWING`;
        }
        return "0 FOLLOWING";
      }
      default:
        return bound.type;
    }
  }

  private compileParameter(param: EdgeQLAST.Parameter): SQL.SQLExpression {
    // The lexer keeps the leading `$` on the name. Strip it so callers can
    // key the parameter map by the bare identifier (matches the wire-level
    // `kwargs` shape both upstream Gel clients use).
    const bare = param.name.startsWith("$") ? param.name.slice(1) : param.name;

    // Numeric positional parameters (`$0`, `$1`, ...) keep their literal
    // index. Without this, parseInt fails for purely-numeric names that
    // happen to also exist in `parameterIndex` and we'd shift positions.
    const numeric = parseInt(bare, 10);
    if (!Number.isNaN(numeric)) {
      // EdgeQL `$0` is the first positional argument; PG `$1` is the first
      // bind value. Bump by 1 to keep the two coordinate systems aligned.
      return SQL.createParameterReference(numeric + 1);
    }

    const idx = this.parameterIndex.get(bare);
    if (idx !== undefined)
      return SQL.createParameterReference(idx);

    // No map entry — fall back to length+1 so successive unmapped names get
    // distinct indices instead of all collapsing onto $1 (the prior bug).
    const next = this.parameterIndex.size + 1;
    this.parameterIndex.set(bare, next);
    return SQL.createParameterReference(next);
  }

  private compileTypeCast(cast: EdgeQLAST.TypeCast): SQL.SQLExpression {
    const expr = this.compileExpression(cast.expr);
    const typeName = cast.type.name.parts.join("::");
    const pgType = edgeqlTypeToPgType(typeName);

    return SQL.createCastExpression(expr, pgType);
  }

  private compilePathInExpression(path: EdgeQLAST.Path): SQL.SQLExpression {
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

    // Handle 2-step paths: check for enum literals before rejecting
    if (path.steps.length === 2) {
      const firstStep = path.steps[0];
      const secondStep = path.steps[1];
      const enumDefPath = firstStep.type === "property" ? Context.resolveTypeName(this.ctx, firstStep.name) : undefined;
      if (
        firstStep.type === "property" && secondStep.type === "property" &&
        enumDefPath && Array.isArray(enumDefPath.enumValues) &&
        enumDefPath.enumValues.length > 0
      ) {
        return this.compileEnumLiteral(firstStep.name, secondStep.name);
      }

      // Non-enum multi-step paths would require joins in a full implementation
      throw new CompilationError(
        `Multi-step path expressions not yet implemented`
      );
    }

    // Handle other multi-step paths
    if (path.steps.length > 1) {
      throw new CompilationError(
        `Multi-step path expressions not yet implemented`
      );
    }

    throw new CompilationError(`Complex path expressions not yet implemented`);
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

  private compileInsertQuery(
    query: EdgeQLAST.InsertQuery
  ): SQL.InsertStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const columns: string[] = [];
    const values: SQL.SQLExpression[] = [];

    // Process shape elements to extract column assignments
    for (const element of query.shape.elements) {
      if (!element.name || !element.computable) {
        throw new CompilationError(
          "INSERT requires computed assignments (name := value)"
        );
      }

      const propName = element.name.name;
      const property = Context.getProperty(this.ctx, typeName, propName);
      if (!property) {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link && link.columnName) {
          columns.push(link.columnName);
        } else {
          throw new CompilationError(
            `Property '${propName}' not found on type '${typeName}'`
          );
        }
      } else {
        columns.push(property.columnName);
      }

      const value = this.compileExpression(element.expr);
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
                value: this.compileExpression(element.expr)
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

    return {
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
  }

  private compileUpdateQuery(
    query: EdgeQLAST.UpdateQuery
  ): SQL.UpdateStatement {
    const typeName = query.type.name.parts.join("::");
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const setClauses: SQL.SetClause[] = [];

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
            value: this.compileExpression(element.expr)
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
      const typeDef = underlyingTypeName ? Context.resolveTypeName(this.ctx, underlyingTypeName) : undefined;

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
  private compileSelectQueryRaw(
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
          if (typeDef)
            return firstStep.name;
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

  private compileSetExpr(setExpr: EdgeQLAST.SetExpr): SQL.SQLExpression {
    // Compile set expression {val1, val2, ...} into a SQL tuple (val1, val2, ...)
    // This is used in expressions like FILTER .role IN {"admin", "moderator"}
    const elements = setExpr.elements.map(elem => this.compileExpression(elem));

    // Build a raw SQL expression for the tuple representation
    const parts = elements.map(elem => {
      if (elem.kind === "LiteralExpression") {
        if (elem.type === "string") {
          return "'" + String(elem.value).replace(/'/g, "''") + "'";
        }
        if (elem.type === "number")
          return String(elem.value);
        if (elem.type === "boolean")
          return elem.value ? "TRUE" : "FALSE";
        if (elem.type === "null")
          return "NULL";
      }
      // For non-literal expressions, fall back to a placeholder
      return "?";
    });

    return {
      kind: "RawSQLExpression" as const,
      sql: "(" + parts.join(", ") + ")"
    };
  }

  private compileSubqueryExpression(
    subquery: EdgeQLAST.Subquery
  ): SQL.SQLExpression {
    const compiled = this.compileQuery(subquery.query);

    // compileQuery returns a SQLStatement which could be any statement type.
    // For SubqueryExpression we need a SelectStatement. If it's already one,
    // use it directly. Otherwise wrap in a simple SELECT that references it.
    if (compiled.kind === "SelectStatement") {
      return SQL.createSubqueryExpression(compiled);
    }

    // For CTEStatement, UnionAllStatement, etc. — wrap inside a derived select
    // by placing the statement as a subquery in FROM and selecting *.
    const wrapper: SQL.SelectStatement = SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("*"))
      ]),
      from: SQL.createFromClause([{
        kind: "TableReference",
        name: "",
        subquery: compiled,
        alias: "subq"
      }])
    });

    return SQL.createSubqueryExpression(wrapper);
  }

  private compileIfElse(ifElse: EdgeQLAST.IfElse): SQL.CaseExpression {
    const condition = this.compileExpression(ifElse.condition);
    const thenExpr = this.compileExpression(ifElse.then);
    const elseExpr = this.compileExpression(ifElse.else);

    return SQL.createCaseExpression(
      [SQL.createWhenClause(condition, thenExpr)],
      elseExpr
    );
  }

  /**
   * Compile a multi-branch CASE expression (P1-05). Maps 1:1 to SQL CASE.
   */
  private compileCaseExpression(
    caseExpr: EdgeQLAST.CaseExpression
  ): SQL.CaseExpression {
    const whens = caseExpr.whenClauses.map(clause =>
      SQL.createWhenClause(
        this.compileExpression(clause.condition),
        this.compileExpression(clause.result)
      )
    );
    const elseExpr = caseExpr.elseResult ? this.compileExpression(caseExpr.elseResult) : undefined;
    return SQL.createCaseExpression(whens, elseExpr);
  }

  private compileArrayExpr(arrayExpr: EdgeQLAST.ArrayExpr): SQL.SQLExpression {
    // P1-07: validate that all literal elements share the same JS type.
    // `[1, 'two']` used to compile to `ARRAY[1, 'two']` which PostgreSQL
    // then rejected at runtime with a cryptic coercion error. Catching the
    // homogeneity violation at compile time points the user at the right
    // source line.
    const literalKinds = new Set<string>();
    for (const el of arrayExpr.elements) {
      if (el.kind === "Literal") {
        literalKinds.add(typeof (el as { value: unknown; }).value);
      }
    }
    if (literalKinds.size > 1) {
      throw new CompilationError(
        `Array literal has mixed element types: ${[...literalKinds].sort().join(", ")}. Arrays must be homogeneous.`
      );
    }
    const elements = arrayExpr.elements.map(el => this.compileExpression(el));
    return SQL.createFunctionCall("ARRAY", elements);
  }

  private compileTupleExpr(tupleExpr: EdgeQLAST.TupleExpr): SQL.SQLExpression {
    const elements = tupleExpr.elements.map(el => this.compileExpression(el));
    return SQL.createFunctionCall("jsonb_build_array", elements);
  }

  private compileTupleAccess(
    access: EdgeQLAST.TupleAccessExpr
  ): SQL.SQLExpression {
    const tupleExpr = this.compileExpression(access.tuple);

    if (access.accessType === "index" && access.index !== undefined) {
      // Numeric index access: tuple_expr -> N
      return SQL.createJsonbAccess(
        tupleExpr,
        "->",
        SQL.createLiteral("number", access.index)
      );
    } else if (access.accessType === "name" && access.fieldName) {
      // Named field access: tuple_expr ->> 'name'
      return SQL.createJsonbAccess(
        tupleExpr,
        "->>",
        SQL.createLiteral("string", access.fieldName)
      );
    }

    throw new CompilationError("Invalid tuple access expression");
  }

  private compileNamedTuple(
    namedTuple: EdgeQLAST.NamedTuple
  ): SQL.SQLExpression {
    const fields = namedTuple.elements.map(el => SQL.createJsonField(el.name, this.compileExpression(el.value)));
    return SQL.createJsonBuildObject(fields);
  }

  private compileDetached(detached: EdgeQLAST.Detached): SQL.SQLExpression {
    // DETACHED strips scope context — compile inner expression without
    // scope resolution (the expression runs in a fresh scope context)
    Context.pushScope(this.ctx);
    try {
      return this.compileExpression(detached.expr);
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /**
   * Compile DESCRIBE TYPE <typeName> into a SELECT statement returning the
   * type description as a JSON literal. The introspection is resolved at
   * compile time from the in-memory schema, then embedded as a SQL string
   * literal so the result passes through PG normally.
   */
  private compileDescribeType(
    query: EdgeQLAST.DescribeTypeQuery
  ): SQL.SelectStatement {
    const description = describeType(this.ctx.schema, query.typeName);
    const json = JSON.stringify(description);

    // SELECT '<json>'::jsonb
    const rawExpr: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };

    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(rawExpr)])
    });
  }

  /**
   * Compile DESCRIBE SCHEMA into a SELECT statement returning the full schema
   * description as a JSON literal.
   */
  private compileDescribeSchema(): SQL.SelectStatement {
    const description = describeSchema(this.ctx.schema);
    const json = JSON.stringify(description);

    // SELECT '<json>'::jsonb
    const rawExpr: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };

    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(rawExpr)])
    });
  }

  private compileIntrospection(
    introspection: EdgeQLAST.Introspection
  ): SQL.SQLExpression {
    const typeName = introspection.type.name.parts.join("::");
    throw new CompilationError(
      `Introspection queries (INTROSPECT ${typeName}) are not yet supported. ` +
        `Schema metadata queries require the schema reflection catalog.`
    );
  }

  private compileIndexExpression(
    indexExpr: EdgeQLAST.IndexExpression
  ): SQL.SQLExpression {
    const base = this.compileExpression(indexExpr.expr);
    const idx = this.compileExpression(indexExpr.index);

    // String key access → jsonb -> 'key'
    if (
      indexExpr.index.kind === "Literal" &&
      indexExpr.index.type === "string"
    ) {
      return SQL.createJsonbAccess(base, "->", idx);
    }

    // JSON type cast base → jsonb -> index
    if (
      indexExpr.expr.kind === "TypeCast" &&
      indexExpr.expr.type.name.parts.some((p: string) => p === "json" || p === "jsonb")
    ) {
      return SQL.createJsonbAccess(base, "->", idx);
    }

    // Default: array indexing with negative index support
    // EdgeQL uses 0-based indexing; PG uses 1-based
    // Negative indices count from end: -1 = last element
    const baseStr = this.renderSqlExpr(base);
    const idxStr = this.renderSqlExpr(idx);
    return {
      kind: "RawSQLExpression" as const,
      sql: `(${baseStr})[CASE WHEN ${idxStr} < 0 THEN CARDINALITY(${baseStr}) + ${idxStr} + 1 ELSE ${idxStr} + 1 END]`
    };
  }

  private compileSliceExpression(
    sliceExpr: EdgeQLAST.SliceExpression
  ): SQL.SQLExpression {
    const base = this.compileExpression(sliceExpr.expr);
    const baseStr = this.renderSqlExpr(base);

    const hasStart = sliceExpr.start !== undefined;
    const hasEnd = sliceExpr.end !== undefined;

    if (!hasStart && !hasEnd) {
      // [:] — identity
      return base;
    }

    if (hasStart && hasEnd) {
      // [a:b] → SUBSTRING(expr FROM a+1 FOR b-a)
      const startStr = this.renderSqlExpr(
        this.compileExpression(sliceExpr.start!)
      );
      const endStr = this.renderSqlExpr(
        this.compileExpression(sliceExpr.end!)
      );
      return {
        kind: "RawSQLExpression" as const,
        sql: `SUBSTRING(${baseStr} FROM ${startStr} + 1 FOR ${endStr} - ${startStr})`
      };
    }

    if (hasStart) {
      // [a:] → SUBSTRING(expr FROM a+1)
      const startStr = this.renderSqlExpr(
        this.compileExpression(sliceExpr.start!)
      );
      return {
        kind: "RawSQLExpression" as const,
        sql: `SUBSTRING(${baseStr} FROM ${startStr} + 1)`
      };
    }

    // [:b] → SUBSTRING(expr FROM 1 FOR b)
    const endStr = this.renderSqlExpr(
      this.compileExpression(sliceExpr.end!)
    );
    return {
      kind: "RawSQLExpression" as const,
      sql: `SUBSTRING(${baseStr} FROM 1 FOR ${endStr})`
    };
  }

  /**
   * Compile a GlobalRef expression to SQL.
   *
   * Produces: current_setting('disc.global_default__current_user_id', true)::uuid
   *
   * Uses PostgreSQL's current_setting() with the missing_ok flag set to true
   * so that unset globals return NULL rather than raising an error.
   */
  private compileGlobalRef(expr: EdgeQLAST.GlobalRef): SQL.SQLExpression {
    const qualifiedName = expr.module ? `${expr.module}::${expr.name}` : expr.name;
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
    const qualifiedName = query.module ? `${query.module}::${query.name}` : query.name;
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
  private compileIntrospectionFunction(
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

  private compileTypeName(typeName: EdgeQLAST.TypeName): SQL.SQLExpression {
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
