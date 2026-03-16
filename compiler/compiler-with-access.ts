/**
 * EdgeQL Compiler with Access Control Integration
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import * as SQL from "./sql.ts";
import * as Context from "./context.ts";
import { CompilationError } from "../lib/errors.ts";
import { Result, Ok, Err } from "../lib/result.ts";
import { 
  AccessEvaluator, 
  AccessSQLInjector,
  AccessContext,
  AccessConfig,
  AccessPolicy
} from "../access/mod.ts";

export class EdgeQLCompilerWithAccess {
  private ctx: Context.CompilationContext;
  private accessEvaluator: AccessEvaluator;
  private accessInjector: AccessSQLInjector;
  private accessContext: AccessContext;
  private accessMode: "permissive" | "restrictive";

  constructor(
    schema: Context.Schema,
    accessConfig?: AccessConfig,
    accessContext?: AccessContext
  ) {
    this.ctx = Context.createContext(schema);

    // Initialize access control
    const config = accessConfig || {
      mode: "permissive",
      defaultAllow: true,
      enableRLS: true,
      enableAudit: false,
    };

    this.accessMode = config.mode === "restrictive" ? "restrictive" : "permissive";
    this.accessEvaluator = new AccessEvaluator(config);
    this.accessInjector = new AccessSQLInjector(this.accessEvaluator);
    this.accessContext = accessContext || {};
  }

  /**
   * Register access policies for types
   */
  registerAccessPolicy(policy: AccessPolicy): void {
    this.accessEvaluator.registerPolicy(policy);
  }

  /**
   * Set the access context (user, role, session data)
   */
  setAccessContext(context: AccessContext): void {
    this.accessContext = context;
  }

  compile(query: EdgeQLAST.Query): Result<SQL.SQLStatement, CompilationError> {
    try {
      // First compile the query normally
      const statement = this.compileQuery(query);
      
      // Then apply access control based on the query type
      const securedStatement = this.applyAccessControl(statement, query);
      
      return Ok(securedStatement);
    } catch (error) {
      if (error instanceof CompilationError) {
        return Err(error);
      }
      return Err(new CompilationError(`Compilation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private applyAccessControl(
    statement: SQL.SQLStatement,
    query: EdgeQLAST.Query
  ): SQL.SQLStatement {
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

    const tableName = typeDef.tableName;

    // Apply access control based on statement type
    switch (statement.kind) {
      case "SelectStatement": {
        // Check if access is allowed and inject conditions
        const sqlQuery = {
          text: this.statementToSQL(statement),
          params: [],
        };
        
        const securedQuery = this.accessInjector.injectSelect(
          sqlQuery,
          tableName,
          objectType,
          this.accessContext
        );
        
        // Parse the modified SQL back to AST (simplified - would need proper SQL parser)
        // For now, we'll inject WHERE conditions directly
        return this.injectWhereConditions(statement as SQL.SelectStatement, securedQuery.text);
      }
      
      case "InsertStatement": {
        // Check if INSERT is allowed
        const decision = this.accessEvaluator.evaluate(objectType, "insert", this.accessContext);
        if (!decision.allowed) {
          throw new CompilationError(`INSERT not allowed on ${objectType}: ${decision.reason}`);
        }
        return statement;
      }
      
      case "UpdateStatement": {
        // Check if UPDATE is allowed and inject conditions
        const sqlQuery = {
          text: this.statementToSQL(statement),
          params: [],
        };
        
        const securedQuery = this.accessInjector.injectUpdate(
          sqlQuery,
          tableName,
          objectType,
          this.accessContext
        );
        
        return this.injectWhereConditions(statement as SQL.UpdateStatement, securedQuery.text);
      }
      
      case "DeleteStatement": {
        // Check if DELETE is allowed and inject conditions
        const sqlQuery = {
          text: this.statementToSQL(statement),
          params: [],
        };
        
        const securedQuery = this.accessInjector.injectDelete(
          sqlQuery,
          tableName,
          objectType,
          this.accessContext
        );
        
        return this.injectWhereConditions(statement as SQL.DeleteStatement, securedQuery.text);
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

  private statementToSQL(_statement: SQL.SQLStatement): string {
    // Simplified - would use SQLCodeGenerator
    return "SELECT * FROM table";
  }

  private injectWhereConditions(
    statement: SQL.SelectStatement | SQL.UpdateStatement | SQL.DeleteStatement,
    _modifiedSQL: string
  ): SQL.SQLStatement {
    // Get access policies and evaluate them
    const objectType = this.extractObjectTypeFromStatement(statement);
    if (!objectType) return statement;
    
    const decision = this.accessEvaluator.evaluate(objectType, "select", this.accessContext);
    
    if (!decision.allowed) {
      // Block access entirely
      const falseCondition: SQL.SQLExpression = {
        kind: "LiteralExpression",
        type: "boolean",
        value: false,
      };
      
      return {
        ...statement,
        where: {
          kind: "WhereClause",
          condition: falseCondition,
        },
      };
    }
    
    if (!decision.sqlConditions || decision.sqlConditions.length === 0) {
      return statement; // No conditions to add
    }
    
    // Parse SQL conditions into AST expressions
    const accessConditions = this.parseAccessConditions(decision.sqlConditions);
    if (!accessConditions) return statement;
    
    if (statement.where) {
      // Combine with existing WHERE clause
      const combinedCondition: SQL.BinaryExpression = {
        kind: "BinaryExpression",
        operator: "AND",
        left: accessConditions,
        right: statement.where.condition,
      };
      
      return {
        ...statement,
        where: {
          kind: "WhereClause",
          condition: combinedCondition,
        },
      };
    } else {
      // Add new WHERE clause
      return {
        ...statement,
        where: {
          kind: "WhereClause",
          condition: accessConditions,
        },
      };
    }
  }
  
  private extractObjectTypeFromStatement(
    statement: SQL.SelectStatement | SQL.UpdateStatement | SQL.DeleteStatement
  ): string | undefined {
    // Extract the main table/object type from the statement
    if (statement.kind === "SelectStatement" && statement.from) {
      const table = statement.from.tables[0];
      if (table.kind === "TableReference") {
        // Map table name back to object type
        for (const [typeName, typeDef] of this.ctx.schema.types) {
          if (typeDef.tableName === table.name) {
            return typeName;
          }
        }
      }
    } else if (statement.kind === "UpdateStatement") {
      // Map table name back to object type
      for (const [typeName, typeDef] of this.ctx.schema.types) {
        if (typeDef.tableName === statement.table) {
          return typeName;
        }
      }
    } else if (statement.kind === "DeleteStatement") {
      // Map table name back to object type
      for (const [typeName, typeDef] of this.ctx.schema.types) {
        if (typeDef.tableName === statement.table) {
          return typeName;
        }
      }
    }
    return undefined;
  }
  
  private parseAccessConditions(sqlConditions: string[]): SQL.SQLExpression | null {
    if (sqlConditions.length === 0) return null;
    
    // For now, create raw SQL expressions
    // In a production system, we'd parse these properly
    const conditions = sqlConditions.map(sql => ({
      kind: "RawSQLExpression" as const,
      sql: sql,
    }));
    
    if (conditions.length === 1) {
      return conditions[0];
    }
    
    // Combine multiple conditions with OR (permissive mode)
    // or AND (restrictive mode)
    const operator = this.accessMode === "restrictive" ? "AND" : "OR";

    return conditions.slice(1).reduce<SQL.SQLExpression>((acc, cond) => ({
      kind: "BinaryExpression",
      operator,
      left: acc,
      right: cond,
    }), conditions[0]);
  }

  // ... rest of the compilation methods from original compiler ...
  
  private compileQuery(query: EdgeQLAST.Query): SQL.SQLStatement {
    switch (query.kind) {
      case "SelectQuery":
        return this.compileSelectQuery(query);
      case "InsertQuery":
        return this.compileInsertQuery(query);
      case "UpdateQuery":
        return this.compileUpdateQuery(query);
      case "DeleteQuery":
        return this.compileDeleteQuery(query);
      default:
        throw new CompilationError(`Unsupported query type: ${query.kind}`);
    }
  }

  private compileSelectQuery(query: EdgeQLAST.SelectQuery): SQL.SelectStatement {
    // Extract type name and get table name
    let typeName = "Unknown";
    if (query.expr?.kind === "TypeName") {
      typeName = query.expr.name.parts.join(".");
    }

    const typeDef = this.ctx.schema.types.get(typeName);
    const tableName = typeDef?.tableName || typeName.toLowerCase() + "s";
    const alias = this.generateAlias();

    // Build FROM clause
    const fromClause: SQL.FromClause = {
      kind: "FromClause",
      tables: [{
        kind: "TableReference",
        name: tableName,
        alias,
      }],
    };

    // Build SELECT clause based on shape
    const selectClause = this.buildSelectClause(query, alias);

    // Build WHERE clause from filter
    const whereClause = query.filter ? this.compileFilter(query.filter) : undefined;

    // Build ORDER BY
    const orderByClause = query.orderBy && query.orderBy.length > 0 ?
      this.compileOrderBy(query.orderBy) : undefined;

    // Build LIMIT
    const limitClause = query.limit ?
      { kind: "LimitClause" as const, count: this.compileExpression(query.limit) } : undefined;

    return SQL.createSelectStatement({
      select: selectClause,
      from: fromClause,
      where: whereClause,
      orderBy: orderByClause,
      limit: limitClause,
    });
  }

  private compileInsertQuery(_query: EdgeQLAST.InsertQuery): SQL.InsertStatement {
    throw new CompilationError("INSERT queries not yet implemented with access control");
  }

  private compileUpdateQuery(_query: EdgeQLAST.UpdateQuery): SQL.UpdateStatement {
    throw new CompilationError("UPDATE queries not yet implemented with access control");
  }

  private compileDeleteQuery(_query: EdgeQLAST.DeleteQuery): SQL.DeleteStatement {
    throw new CompilationError("DELETE queries not yet implemented with access control");
  }



  private generateAlias(): string {
    return `t${++this.ctx.aliasCounter}`;
  }

  private buildSelectClause(query: EdgeQLAST.SelectQuery, alias: string): SQL.SelectClause {
    if (query.shape && query.shape.elements.length > 0) {
      // Build JSON object with selected fields
      const fields: SQL.JsonField[] = query.shape.elements
        .map(elem => {
          // ShapeElement has an expr field
          if (elem.expr.kind === "Path") {
            const path = elem.expr as EdgeQLAST.Path;
            const fieldName = path.steps[0].name;
            return SQL.createJsonField(
              fieldName,
              SQL.createColumnReference(fieldName, alias)
            );
          }
          return null;
        })
        .filter((field): field is SQL.JsonField => field !== null);

      const jsonObject = SQL.createJsonBuildObject(fields);
      return SQL.createSelectClause([SQL.createSelectItem(jsonObject)]);
    } else {
      // Select all fields as JSON
      let typeName = "Unknown";
      if (query.expr?.kind === "TypeName") {
        typeName = query.expr.name.parts.join(".");
      }
      const typeDef = this.ctx.schema.types.get(typeName);
      
      if (typeDef && typeDef.properties.size > 0) {
        const fields: SQL.JsonField[] = [];
        for (const [name, prop] of typeDef.properties) {
          fields.push(SQL.createJsonField(
            name,
            SQL.createColumnReference(prop.columnName, alias)
          ));
        }
        const jsonObject = SQL.createJsonBuildObject(fields);
        return SQL.createSelectClause([SQL.createSelectItem(jsonObject)]);
      }
      
      // Fall back to SELECT *
      return SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("*", alias))
      ]);
    }
  }

  private compileFilter(filter: EdgeQLAST.Expression): SQL.WhereClause {
    const condition = this.compileExpression(filter);
    return SQL.createWhereClause(condition);
  }

  private compileOrderBy(orderBy: EdgeQLAST.OrderByClause[]): SQL.OrderByClause {
    const items = orderBy.map(item => ({
      kind: "OrderByItem" as const,
      expression: this.compileExpression(item.expr),
      direction: (item.direction === "DESC" ? "DESC" : "ASC") as "ASC" | "DESC",
    }));
    return { kind: "OrderByClause", items };
  }

  private compileExpression(expr: EdgeQLAST.Expression): SQL.SQLExpression {
    switch (expr.kind) {
      case "Literal":
        return this.compileLiteral(expr);
      case "Path": {
        const lastStep = expr.steps[expr.steps.length - 1];
        return SQL.createColumnReference(lastStep.name);
      }
      case "BinaryOp":
        return this.compileBinaryOp(expr);
      default:
        throw new CompilationError(`Expression type ${expr.kind} not yet implemented`);
    }
  }

  private compileLiteral(lit: EdgeQLAST.Literal): SQL.LiteralExpression {
    // Map EdgeQL literal types to SQL literal types
    let sqlType: "string" | "number" | "boolean" | "null";
    if (lit.type === "string") {
      sqlType = "string";
    } else if (lit.type === "integer" || lit.type === "float") {
      sqlType = "number";
    } else if (lit.type === "boolean") {
      sqlType = "boolean";
    } else {
      sqlType = "null";
    }
    
    return {
      kind: "LiteralExpression",
      type: sqlType,
      value: lit.value
    };
  }

  private compileBinaryOp(binOp: EdgeQLAST.BinaryOp): SQL.BinaryExpression {
    const left = this.compileExpression(binOp.left);
    const right = this.compileExpression(binOp.right);
    let sqlOp: string = binOp.op;
    
    // Map EdgeQL operators to SQL
    if (binOp.op === "++") {
      sqlOp = "||";
    }
    
    return SQL.createBinaryExpression(sqlOp, left, right);
  }
}