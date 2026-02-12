/**
 * EdgeQL to SQL Compiler
 * Transforms EdgeQL AST into PostgreSQL-compatible SQL
 */

import * as EdgeQLAST from "../edgeql/ast.ts";
import * as SQL from "./sql.ts";
import * as Context from "./context.ts";
import { Result, Ok, Err } from "../lib/result.ts";
import { CompilationError } from "../lib/errors.ts";

export class EdgeQLCompiler {
  private ctx: Context.CompilationContext;

  constructor(schema: Context.Schema) {
    this.ctx = Context.createContext(schema);
  }

  compile(query: EdgeQLAST.Query): Result<SQL.SQLStatement, CompilationError> {
    try {
      const statement = this.compileQuery(query);
      return Ok(statement);
    } catch (error) {
      if (error instanceof CompilationError) {
        return Err(error);
      }
      return Err(new CompilationError(`Compilation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

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
      case "WithBlock":
        return this.compileWithBlock(query);
      case "ForQuery":
        return this.compileForQuery(query);
      default:
        throw new CompilationError(`Unsupported query type: ${query.kind}`);
    }
  }

  private compileSelectQuery(query: EdgeQLAST.SelectQuery): SQL.SelectStatement {
    Context.pushScope(this.ctx);

    try {
      // Handle the main expression and generate appropriate FROM clause
      const { selectItems, fromClause } = this.compileSelectExpression(query.expr, query.shape);

      // Compile WHERE clause
      let whereClause: SQL.WhereClause | undefined;
      if (query.filter) {
        const condition = this.compileExpression(query.filter);
        whereClause = SQL.createWhereClause(condition);
      }

      // Compile ORDER BY clause
      let orderByClause: SQL.OrderByClause | undefined;
      if (query.orderBy && query.orderBy.length > 0) {
        const items = query.orderBy.map((item) => ({
          kind: "OrderByItem" as const,
          expression: this.compileExpression(item.expr),
          direction: item.direction || "ASC" as "ASC" | "DESC",
        }));
        orderByClause = { kind: "OrderByClause", items };
      }

      // Compile LIMIT and OFFSET
      let limitClause: SQL.LimitClause | undefined;
      if (query.limit) {
        limitClause = { kind: "LimitClause", count: this.compileExpression(query.limit) };
      }

      let offsetClause: SQL.OffsetClause | undefined;
      if (query.offset) {
        offsetClause = { kind: "OffsetClause", count: this.compileExpression(query.offset) };
      }

      const selectClause = SQL.createSelectClause(selectItems, query.distinct);

      return SQL.createSelectStatement({
        select: selectClause,
        from: fromClause,
        where: whereClause,
        orderBy: orderByClause,
        limit: limitClause,
        offset: offsetClause,
      });
    } finally {
      Context.popScope(this.ctx);
    }
  }

  private compileSelectExpression(expr: EdgeQLAST.Expression, shape?: EdgeQLAST.Shape): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
  } {
    if (expr.kind === "TypeName") {
      // SELECT User -> SELECT * FROM users
      const typeName = expr.name.parts[0];
      const typeDef = Context.getTypeDef(this.ctx, typeName);
      if (!typeDef) {
        throw new CompilationError(`Type '${typeName}' not found`);
      }

      const tableAlias = Context.addTableAlias(this.ctx, typeName.toLowerCase(), typeDef.tableName, typeName);
      const fromClause = SQL.createFromClause([SQL.createTableReference(typeDef.tableName, tableAlias)]);

      let selectItems: SQL.SelectItem[];
      if (shape) {
        selectItems = this.compileShape(shape, typeName, tableAlias);
      } else {
        // Select all columns as JSON object
        selectItems = this.compileImplicitShape(typeDef, tableAlias);
      }

      return { selectItems, fromClause };
    }

    if (expr.kind === "Path") {
      return this.compilePathExpression(expr, shape);
    }

    if (expr.kind === "Subquery") {
      // Handle subquery
      const subquery = this.compileQuery(expr.query) as SQL.SelectStatement;
      const selectItems = [SQL.createSelectItem({
        kind: "SubqueryExpression",
        query: subquery,
      })];

      // Empty FROM clause for subqueries
      const fromClause = SQL.createFromClause([]);
      return { selectItems, fromClause };
    }

    // For other expressions, compile directly
    const compiledExpr = this.compileExpression(expr);
    const selectItems = [SQL.createSelectItem(compiledExpr)];
    const fromClause = SQL.createFromClause([]); // No FROM clause needed

    return { selectItems, fromClause };
  }

  private compileShape(shape: EdgeQLAST.Shape, typeName: string, tableAlias: string): SQL.SelectItem[] {
    const fields: SQL.JsonField[] = [];

    for (const element of shape.elements) {
      const field = this.compileShapeElement(element, typeName, tableAlias);
      if (field) {
        fields.push(field);
      }
    }

    const jsonObject = SQL.createJsonBuildObject(fields);
    return [SQL.createSelectItem(jsonObject)];
  }

  private compileShapeElement(element: EdgeQLAST.ShapeElement, typeName: string, tableAlias: string): SQL.JsonField | null {
    let key: string;
    let value: SQL.SQLExpression;

    if (element.name) {
      // Named element (alias or computed property)
      key = element.name.name;
      if (element.computable) {
        // Computed property: name := expression
        value = this.compileExpression(element.expr);
      } else {
        // Aliased property: alias: expression
        value = this.compileExpression(element.expr);
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
          throw new CompilationError(`Property '${propName}' not found on type '${typeName}'`);
        }
      }
    } else {
      // Expression without explicit name
      key = "result";
      value = this.compileExpression(element.expr);
    }

    return SQL.createJsonField(key, value);
  }

  private compileImplicitShape(typeDef: Context.TypeDef, tableAlias: string): SQL.SelectItem[] {
    const fields: SQL.JsonField[] = [];

    // Add all properties
    for (const [name, property] of typeDef.properties) {
      const value = SQL.createColumnReference(property.columnName, tableAlias);
      fields.push(SQL.createJsonField(name, value));
    }

    const jsonObject = SQL.createJsonBuildObject(fields);
    return [SQL.createSelectItem(jsonObject)];
  }

  private compileLinkReference(link: Context.LinkDef, parentAlias: string): SQL.SQLExpression {
    // This is a simplified implementation
    // In a full implementation, this would generate a subquery with proper joins
    if (link.columnName) {
      // Simple foreign key reference
      return SQL.createColumnReference(link.columnName, parentAlias);
    } else {
      // Backlink - would need a subquery
      throw new CompilationError(`Backlink compilation not yet implemented: ${link.name}`);
    }
  }

  private compilePathExpression(path: EdgeQLAST.Path, shape?: EdgeQLAST.Shape): {
    selectItems: SQL.SelectItem[];
    fromClause: SQL.FromClause;
  } {
    // Simplified path compilation
    // In a full implementation, this would handle complex path traversal with joins
    throw new CompilationError("Path expression compilation not yet fully implemented");
  }

  private compileExpression(expr: EdgeQLAST.Expression): SQL.SQLExpression {
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
      case "Parameter":
        return this.compileParameter(expr);
      case "TypeCast":
        return this.compileTypeCast(expr);
      case "Path":
        return this.compilePathInExpression(expr);
      case "TypeName":
        return this.compileTypeName(expr);
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

  private compileIdentifier(identifier: EdgeQLAST.Identifier): SQL.SQLExpression {
    // This is context-dependent - could be a column reference or variable
    // For now, assume it's a column in the current table context
    throw new CompilationError("Standalone identifier compilation not yet implemented");
  }

  private compileBinaryOp(binOp: EdgeQLAST.BinaryOp): SQL.BinaryExpression {
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
    }

    return SQL.createBinaryExpression(sqlOp, left, right);
  }

  private compileUnaryOp(unaryOp: EdgeQLAST.UnaryOp): SQL.UnaryExpression {
    return {
      kind: "UnaryExpression",
      operator: unaryOp.op,
      operand: this.compileExpression(unaryOp.operand),
    };
  }

  private compileFunctionCall(funcCall: EdgeQLAST.FunctionCall): SQL.FunctionCall {
    const functionName = funcCall.name.parts.join("_");
    const args = funcCall.args.map(arg => this.compileExpression(arg.value));

    // Map EdgeQL functions to SQL functions
    let sqlName = functionName;
    const funcDef = this.ctx.schema.functions.get(functionName);
    if (funcDef?.sqlName) {
      sqlName = funcDef.sqlName;
    }

    return SQL.createFunctionCall(sqlName, args);
  }

  private compileParameter(param: EdgeQLAST.Parameter): SQL.SQLExpression {
    // Parameters are placeholders that will be filled in at execution time
    // Use parameter name as index for now (could be improved with proper parameter indexing)
    return SQL.createParameterReference(parseInt(param.name) || 1);
  }

  private compileTypeCast(cast: EdgeQLAST.TypeCast): SQL.SQLExpression {
    const expr = this.compileExpression(cast.expr);
    const typeName = cast.type.name.parts.join("::");

    return SQL.createFunctionCall("CAST", [
      expr,
      SQL.createLiteral("string", typeName),
    ]);
  }

  private compilePathInExpression(path: EdgeQLAST.Path): SQL.SQLExpression {
    // Handle relative paths starting with '.'
    if (path.steps.length === 1) {
      const step = path.steps[0];
      if (step.type === "property") {
        // Simple property reference - resolve to current table's column
        // For now, assume we're in the context of the current table
        return SQL.createColumnReference(step.name);
      }
    }

    // Handle multi-step paths
    if (path.steps.length > 1) {
      // This would require joins in a full implementation
      throw new CompilationError(`Multi-step path expressions not yet implemented`);
    }

    throw new CompilationError(`Complex path expressions not yet implemented`);
  }

  private compileInsertQuery(query: EdgeQLAST.InsertQuery): SQL.InsertStatement {
    const typeName = query.type.name.parts[0];
    const typeDef = Context.getTypeDef(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const columns: string[] = [];
    const values: SQL.SQLExpression[] = [];

    // Process shape elements to extract column assignments
    for (const element of query.shape.elements) {
      if (!element.name || !element.computable) {
        throw new CompilationError("INSERT requires computed assignments (name := value)");
      }

      const propName = element.name.name;
      const property = Context.getProperty(this.ctx, typeName, propName);
      if (!property) {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link && link.columnName) {
          columns.push(link.columnName);
        } else {
          throw new CompilationError(`Property '${propName}' not found on type '${typeName}'`);
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
        // DO UPDATE
        throw new CompilationError("ON CONFLICT DO UPDATE not yet implemented");
      } else {
        // DO NOTHING
        onConflict = {
          kind: "OnConflictClause",
          target: target.length > 0 ? target : undefined,
          action: "DO NOTHING",
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
          expression: SQL.createColumnReference("*"),
        },
      ],
    };
  }

  private compileUpdateQuery(query: EdgeQLAST.UpdateQuery): SQL.UpdateStatement {
    const typeName = query.type.name.parts[0];
    const typeDef = Context.getTypeDef(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(`Type '${typeName}' not found`);
    }

    const setClauses: SQL.SetClause[] = [];

    // Process shape elements to extract SET clauses
    for (const element of query.shape.elements) {
      if (!element.name || !element.computable) {
        throw new CompilationError("UPDATE requires computed assignments (name := value)");
      }

      const propName = element.name.name;
      const property = Context.getProperty(this.ctx, typeName, propName);
      if (!property) {
        const link = Context.getLink(this.ctx, typeName, propName);
        if (link && link.columnName) {
          setClauses.push({
            kind: "SetClause",
            column: link.columnName,
            value: this.compileExpression(element.expr),
          });
        } else {
          throw new CompilationError(`Property '${propName}' not found on type '${typeName}'`);
        }
      } else {
        setClauses.push({
          kind: "SetClause",
          column: property.columnName,
          value: this.compileExpression(element.expr),
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
          expression: SQL.createColumnReference("*"),
        },
      ],
    };
  }

  private compileDeleteQuery(query: EdgeQLAST.DeleteQuery): SQL.DeleteStatement {
    const typeName = query.type.name.parts[0];
    const typeDef = Context.getTypeDef(this.ctx, typeName);
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
          expression: SQL.createColumnReference("*"),
        },
      ],
    };
  }

  private compileWithBlock(query: EdgeQLAST.WithBlock): SQL.SQLStatement {
    throw new CompilationError("WITH block compilation not yet implemented");
  }

  private compileForQuery(query: EdgeQLAST.ForQuery): SQL.SQLStatement {
    throw new CompilationError("FOR query compilation not yet implemented");
  }

  private compileTypeName(typeName: EdgeQLAST.TypeName): SQL.SQLExpression {
    // For function arguments, a TypeName like "User" often means "all User objects"
    // In the context of count(User), this would be like "SELECT * FROM users"
    const name = typeName.name.parts[0];
    const typeDef = Context.getTypeDef(this.ctx, name);
    if (!typeDef) {
      throw new CompilationError(`Type '${name}' not found`);
    }

    // Generate a simple column reference for the primary table
    // In a full implementation, this might create a subquery
    return SQL.createColumnReference("*");
  }
}
