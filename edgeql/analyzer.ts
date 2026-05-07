/**
 * EdgeQL Semantic Analyzer - Analyzes EdgeQL AST for correctness
 */

import { ValidationError } from "../lib/errors.ts";
import * as SchemaAST from "../schema/ast.ts";
import * as AST from "./ast.ts";

interface AnalysisContext {
  schema: Map<
    string,
    SchemaAST.TypeDeclaration | SchemaAST.ScalarTypeDeclaration
  >;
  currentModule?: string;
  variables: Map<string, TypeInfo>;
  errors: ValidationError[];
}

interface TypeInfo {
  name: string;
  cardinality: {
    required: boolean;
    multi: boolean;
  };
  properties?: Map<string, TypeInfo>;
  links?: Map<string, TypeInfo>;
}

export class EdgeQLAnalyzer {
  private context: AnalysisContext;

  constructor(
    schema?: Map<
      string,
      SchemaAST.TypeDeclaration | SchemaAST.ScalarTypeDeclaration
    >,
  ) {
    this.context = {
      schema: schema || new Map(),
      variables: new Map(),
      errors: [],
    };
  }

  analyze(query: AST.Query): ValidationError[] {
    this.analyzeQuery(query);
    return this.context.errors;
  }

  private analyzeQuery(query: AST.Query): TypeInfo | undefined {
    switch (query.kind) {
      case "SelectQuery":
        return this.analyzeSelectQuery(query);
      case "InsertQuery":
        return this.analyzeInsertQuery(query);
      case "UpdateQuery":
        return this.analyzeUpdateQuery(query);
      case "DeleteQuery":
        return this.analyzeDeleteQuery(query);
      case "ForQuery":
        return this.analyzeForQuery(query);
      case "WithBlock":
        return this.analyzeWithBlock(query);
      case "GroupQuery":
        return this.analyzeGroupQuery(query);
      default:
        return undefined;
    }
  }

  private analyzeSelectQuery(query: AST.SelectQuery): TypeInfo | undefined {
    // Analyze the main expression
    const exprType = this.analyzeExpression(query.expr);

    // Analyze filter if present
    if (query.filter) {
      const filterType = this.analyzeExpression(query.filter);
      // Filter should evaluate to boolean
      if (filterType && filterType.name !== "bool") {
        this.addError("Filter expression must evaluate to boolean");
      }
    }

    // Analyze shape if present
    if (query.shape) {
      this.analyzeShape(query.shape, exprType);
    }

    // Analyze order by clauses
    if (query.orderBy) {
      for (const clause of query.orderBy) {
        this.analyzeExpression(clause.expr);
      }
    }

    // Analyze offset and limit
    if (query.offset) {
      const offsetType = this.analyzeExpression(query.offset);
      if (offsetType && !this.isNumericType(offsetType.name)) {
        this.addError("OFFSET must be a numeric value");
      }
    }

    if (query.limit) {
      const limitType = this.analyzeExpression(query.limit);
      if (limitType && !this.isNumericType(limitType.name)) {
        this.addError("LIMIT must be a numeric value");
      }
    }

    return exprType;
  }

  private analyzeInsertQuery(query: AST.InsertQuery): TypeInfo | undefined {
    // Verify the type exists
    const typeName = query.type.name.parts.join("::");
    const typeDecl = this.context.schema.get(typeName);

    if (!typeDecl) {
      this.addError(`Type '${typeName}' not found`);
      return undefined;
    }

    // Analyze the shape
    const typeInfo = this.createTypeInfo(typeDecl);
    this.analyzeShape(query.shape, typeInfo);

    // Analyze conflict clause if present
    if (query.unless) {
      if (query.unless.on) {
        this.analyzeExpression(query.unless.on);
      }
      if (query.unless.else) {
        if ("kind" in query.unless.else) {
          this.analyzeQuery(query.unless.else as AST.Query);
        } else {
          this.analyzeExpression(query.unless.else as AST.Expression);
        }
      }
    }

    return typeInfo;
  }

  private analyzeUpdateQuery(query: AST.UpdateQuery): TypeInfo | undefined {
    // Verify the type exists
    const typeName = query.type.name.parts.join("::");
    const typeDecl = this.context.schema.get(typeName);

    if (!typeDecl) {
      this.addError(`Type '${typeName}' not found`);
      return undefined;
    }

    const typeInfo = this.createTypeInfo(typeDecl);

    // Analyze filter if present
    if (query.filter) {
      const filterType = this.analyzeExpression(query.filter);
      if (filterType && filterType.name !== "bool") {
        this.addError("Filter expression must evaluate to boolean");
      }
    }

    // Analyze the shape
    this.analyzeShape(query.shape, typeInfo);

    return typeInfo;
  }

  private analyzeDeleteQuery(query: AST.DeleteQuery): TypeInfo | undefined {
    // Verify the type exists
    const typeName = query.type.name.parts.join("::");
    const typeDecl = this.context.schema.get(typeName);

    if (!typeDecl) {
      this.addError(`Type '${typeName}' not found`);
      return undefined;
    }

    const typeInfo = this.createTypeInfo(typeDecl);

    // Analyze filter if present
    if (query.filter) {
      const filterType = this.analyzeExpression(query.filter);
      if (filterType && filterType.name !== "bool") {
        this.addError("Filter expression must evaluate to boolean");
      }
    }

    // Analyze order by clauses
    if (query.orderBy) {
      for (const clause of query.orderBy) {
        this.analyzeExpression(clause.expr);
      }
    }

    // Analyze limit
    if (query.limit) {
      const limitType = this.analyzeExpression(query.limit);
      if (limitType && !this.isNumericType(limitType.name)) {
        this.addError("LIMIT must be a numeric value");
      }
    }

    return typeInfo;
  }

  private analyzeForQuery(query: AST.ForQuery): TypeInfo | undefined {
    // Analyze the iterator
    const iterType = this.analyzeExpression(query.iterator);

    // Add the loop variable to context
    if (iterType) {
      this.context.variables.set(query.variable.name, {
        ...iterType,
        cardinality: { required: true, multi: false },
      });
    }

    // Analyze the body
    const bodyType = this.analyzeQuery(query.body);

    // Remove the loop variable from context
    this.context.variables.delete(query.variable.name);

    return bodyType;
  }

  private analyzeWithBlock(query: AST.WithBlock): TypeInfo | undefined {
    // Analyze and bind each WITH binding
    for (const binding of query.bindings) {
      const valueType = this.analyzeExpression(binding.value);
      if (valueType) {
        this.context.variables.set(binding.name.name, valueType);
      }
    }

    // Analyze the body
    const bodyType = this.analyzeQuery(query.body);

    // Remove the bindings from context
    for (const binding of query.bindings) {
      this.context.variables.delete(binding.name.name);
    }

    return bodyType;
  }

  private analyzeGroupQuery(query: AST.GroupQuery): TypeInfo | undefined {
    // Analyze the main expression
    const exprType = this.analyzeExpression(query.expr);

    // Analyze grouping expressions
    for (const element of query.by.elements) {
      this.analyzeExpression(element);
    }

    return exprType;
  }

  private analyzeShape(shape: AST.Shape, contextType?: TypeInfo): void {
    if (!contextType) {
      return;
    }

    for (const element of shape.elements) {
      this.analyzeShapeElement(element, contextType);
    }
  }

  private analyzeShapeElement(
    element: AST.ShapeElement,
    contextType: TypeInfo,
  ): void {
    // Analyze the expression
    const exprType = this.analyzeExpression(element.expr);

    // If it's a property or link reference, verify it exists
    if (element.expr.kind === "Identifier" || element.expr.kind === "Path") {
      const propName = this.getPropertyName(element.expr);

      if (
        propName && contextType.properties
        && !contextType.properties.has(propName)
        && contextType.links && !contextType.links.has(propName)
      ) {
        this.addError(`Property or link '${propName}' not found in type`);
      }
    }

    // Analyze nested shape if present
    if (element.shape) {
      this.analyzeShape(element.shape, exprType);
    }
  }

  private analyzeExpression(expr: AST.Expression): TypeInfo | undefined {
    switch (expr.kind) {
      case "Literal":
        return this.analyzeLiteral(expr);

      case "Parameter":
        return {
          name: "any",
          cardinality: { required: true, multi: false },
        };

      case "Identifier":
        return this.analyzeIdentifier(expr);

      case "Path":
        return this.analyzePath(expr);

      case "TypeCast":
        return this.analyzeTypeCast(expr);

      case "FunctionCall":
        return this.analyzeFunctionCall(expr);

      case "BinaryOp":
        return this.analyzeBinaryOp(expr);

      case "UnaryOp":
        return this.analyzeUnaryOp(expr);

      case "IfElse":
        return this.analyzeIfElse(expr);

      case "SetExpr":
      case "ArrayExpr":
        return this.analyzeCollectionExpr(expr);

      case "TupleExpr":
      case "NamedTuple":
        return {
          name: "tuple",
          cardinality: { required: true, multi: false },
        };

      case "Introspection":
        return {
          name: "schema::Type",
          cardinality: { required: true, multi: false },
        };

      case "Detached":
        return this.analyzeExpression(expr.expr);

      case "TypeName":
        return this.analyzeTypeName(expr);

      case "Subquery":
        return this.analyzeQuery(expr.query);

      case "ShapeExpr": {
        const baseType = this.analyzeExpression(expr.expr);
        this.analyzeShape(expr.shape, baseType);
        return baseType;
      }

      default:
        return undefined;
    }
  }

  private analyzeLiteral(literal: AST.Literal): TypeInfo {
    let typeName: string;

    switch (literal.type) {
      case "string":
        typeName = "str";
        break;
      case "integer":
        typeName = "int64";
        break;
      case "float":
        typeName = "float64";
        break;
      case "boolean":
        typeName = "bool";
        break;
      case "bytes":
        typeName = "bytes";
        break;
      case "uuid":
        typeName = "uuid";
        break;
      case "empty":
        typeName = "empty";
        break;
      default:
        typeName = "any";
    }

    return {
      name: typeName,
      cardinality: { required: true, multi: false },
    };
  }

  private analyzeIdentifier(ident: AST.Identifier): TypeInfo | undefined {
    // Check if it's a variable
    const varType = this.context.variables.get(ident.name);
    if (varType) {
      return varType;
    }

    // Otherwise, it might be a type name or property
    return {
      name: ident.name,
      cardinality: { required: false, multi: false },
    };
  }

  private analyzePath(path: AST.Path): TypeInfo | undefined {
    // Start with the first step
    let currentType: TypeInfo | undefined;

    for (const step of path.steps) {
      if (step.name === ".") {
        // Current object reference
        continue;
      }

      // Navigate through properties/links
      if (currentType && currentType.properties) {
        currentType = currentType.properties.get(step.name);
      } else if (currentType && currentType.links) {
        currentType = currentType.links.get(step.name);
      }
    }

    return currentType;
  }

  private analyzeTypeCast(cast: AST.TypeCast): TypeInfo {
    const typeName = cast.type.name.parts.join("::");

    // Analyze the expression being cast
    this.analyzeExpression(cast.expr);

    return {
      name: typeName,
      cardinality: cast.cardinality
        ? {
          required: cast.cardinality.required ?? true,
          multi: cast.cardinality.multi ?? false,
        }
        : { required: true, multi: false },
    };
  }

  private analyzeFunctionCall(call: AST.FunctionCall): TypeInfo {
    const funcName = call.name.parts.join("::");

    // Analyze arguments
    for (const arg of call.args) {
      this.analyzeExpression(arg.value);
    }

    // Return type based on function name (simplified)
    if (funcName === "count" || funcName === "sum") {
      return {
        name: "int64",
        cardinality: { required: true, multi: false },
      };
    } else if (funcName === "min" || funcName === "max" || funcName === "avg") {
      return {
        name: "float64",
        cardinality: { required: true, multi: false },
      };
    } else if (
      funcName === "str_trim" || funcName === "str_lower"
      || funcName === "str_upper"
    ) {
      return {
        name: "str",
        cardinality: { required: true, multi: false },
      };
    }

    // Default to any type
    return {
      name: "any",
      cardinality: { required: false, multi: false },
    };
  }

  private analyzeBinaryOp(op: AST.BinaryOp): TypeInfo {
    const leftType = this.analyzeExpression(op.left);
    const rightType = this.analyzeExpression(op.right);

    // Determine result type based on operator
    switch (op.op) {
      case "=":
      case "!=":
      case "<":
      case ">":
      case "<=":
      case ">=":
      case "?=":
      case "?!=":
      case "AND":
      case "OR":
      case "LIKE":
      case "ILIKE":
      case "IN":
      case "NOT IN":
      case "IS":
      case "IS NOT":
        return {
          name: "bool",
          cardinality: { required: true, multi: false },
        };

      case "+":
      case "-":
      case "*":
      case "/":
      case "//":
      case "%":
      case "**":
        // Numeric operations
        if (leftType && this.isNumericType(leftType.name)) {
          return leftType;
        }
        return {
          name: "float64",
          cardinality: { required: true, multi: false },
        };

      case "++":
        // String concatenation
        return {
          name: "str",
          cardinality: { required: true, multi: false },
        };

      case "??":
        // Coalesce - returns left type or right type
        return leftType || rightType || {
          name: "any",
          cardinality: { required: false, multi: false },
        };

      case "UNION":
      case "INTERSECT":
      case "EXCEPT":
        // Set operations - returns multi
        if (leftType) {
          return {
            ...leftType,
            cardinality: { ...leftType.cardinality, multi: true },
          };
        }
        return {
          name: "any",
          cardinality: { required: false, multi: true },
        };

      default:
        return {
          name: "any",
          cardinality: { required: false, multi: false },
        };
    }
  }

  private analyzeUnaryOp(op: AST.UnaryOp): TypeInfo {
    const operandType = this.analyzeExpression(op.operand);

    switch (op.op) {
      case "+":
      case "-":
        // Numeric operations
        return operandType || {
          name: "float64",
          cardinality: { required: true, multi: false },
        };

      case "NOT":
        return {
          name: "bool",
          cardinality: { required: true, multi: false },
        };

      case "DISTINCT":
        // Removes duplicates, maintains type
        return operandType || {
          name: "any",
          cardinality: { required: false, multi: true },
        };

      case "EXISTS":
        return {
          name: "bool",
          cardinality: { required: true, multi: false },
        };

      case "DETACHED":
        // Detached maintains type
        return operandType || {
          name: "any",
          cardinality: { required: false, multi: false },
        };

      default:
        return {
          name: "any",
          cardinality: { required: false, multi: false },
        };
    }
  }

  private analyzeIfElse(ifElse: AST.IfElse): TypeInfo | undefined {
    // Analyze condition
    const condType = this.analyzeExpression(ifElse.condition);
    if (condType && condType.name !== "bool") {
      this.addError("IF condition must evaluate to boolean");
    }

    // Analyze branches
    const thenType = this.analyzeExpression(ifElse.then);
    this.analyzeExpression(ifElse.else);

    // Return the union type (simplified - just return then type)
    return thenType;
  }

  private analyzeCollectionExpr(expr: AST.SetExpr | AST.ArrayExpr): TypeInfo {
    // Analyze all elements
    let elementType: TypeInfo | undefined;

    for (const element of expr.elements) {
      const elemType = this.analyzeExpression(element);
      if (!elementType) {
        elementType = elemType;
      }
    }

    return {
      name: elementType?.name || "any",
      cardinality: { required: true, multi: true },
    };
  }

  private analyzeTypeName(typeName: AST.TypeName): TypeInfo {
    const name = typeName.name.parts.join("::");
    const typeDecl = this.context.schema.get(name);

    if (!typeDecl) {
      this.addError(`Type '${name}' not found`);
    }

    return {
      name,
      cardinality: { required: true, multi: false },
    };
  }

  private createTypeInfo(
    typeDecl: SchemaAST.TypeDeclaration | SchemaAST.ScalarTypeDeclaration,
  ): TypeInfo {
    const info: TypeInfo = {
      name: typeDecl.name.value,
      cardinality: { required: true, multi: false },
      properties: new Map(),
      links: new Map(),
    };

    if (typeDecl.kind === "TypeDeclaration") {
      for (const member of typeDecl.members) {
        if (member.kind === "PropertyDeclaration") {
          info.properties?.set(member.name.value, {
            name: member.type.name.parts.join("::"),
            cardinality: {
              required: member.required || false,
              multi: member.multi || false,
            },
          });
        } else if (member.kind === "LinkDeclaration") {
          info.links?.set(member.name.value, {
            name: member.target.name.parts.join("::"),
            cardinality: {
              required: member.required || false,
              multi: member.multi || false,
            },
          });
        }
      }
    }

    return info;
  }

  private getPropertyName(expr: AST.Expression): string | undefined {
    if (expr.kind === "Identifier") {
      return expr.name;
    } else if (expr.kind === "Path" && expr.steps.length > 0) {
      return expr.steps[expr.steps.length - 1].name;
    }
    return undefined;
  }

  private isNumericType(typeName: string): boolean {
    return [
      "int16",
      "int32",
      "int64",
      "float32",
      "float64",
      "decimal",
      "bigint",
    ].includes(typeName);
  }

  private addError(message: string): void {
    this.context.errors.push(new ValidationError(message));
  }
}
