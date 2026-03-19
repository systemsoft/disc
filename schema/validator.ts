/**
 * SDL Schema Validator - Validates SDL AST for correctness
 */

import { ValidationError } from "../lib/errors.ts";
import * as AST from "./ast.ts";
import { Module, SDLConverter } from "./converter.ts";

interface ValidationContext {
  types: Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration>;
  modules: Map<string, AST.ModuleDeclaration>;
  currentModule?: string;
  errors: ValidationError[];
}

export class SchemaValidator {
  private context: ValidationContext;
  private converter: SDLConverter;

  constructor() {
    this.context = {
      types: new Map(),
      modules: new Map(),
      errors: [],
    };
    this.converter = new SDLConverter();
  }

  validate(
    document: AST.SDLDocument,
  ): { ok: boolean; errors?: ValidationError[] } {
    const errors = this.validateDocument(document);
    return {
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private validateDocument(document: AST.SDLDocument): ValidationError[] {
    // First pass: collect all type and module declarations
    this.collectDeclarations(document);

    // Second pass: validate references and constraints
    this.validateDocumentReferences(document);

    return this.context.errors;
  }

  /**
   * Convert SDL document to modules for migration engine
   */
  convertToModules(document: AST.SDLDocument): Module[] {
    return this.converter.convertToModules(document);
  }

  private collectDeclarations(document: AST.SDLDocument): void {
    for (const decl of document.declarations) {
      this.collectDeclaration(decl);
    }
  }

  private collectDeclaration(decl: AST.Declaration): void {
    switch (decl.kind) {
      case "ModuleDeclaration":
        this.collectModule(decl);
        break;
      case "TypeDeclaration":
      case "ScalarTypeDeclaration":
        this.collectType(decl);
        break;
    }
  }

  private collectModule(module: AST.ModuleDeclaration): void {
    const moduleName = module.name.parts.join("::");

    if (this.context.modules.has(moduleName)) {
      this.addError(`Module '${moduleName}' is already defined`);
      return;
    }

    this.context.modules.set(moduleName, module);

    // Set current module context
    const previousModule = this.context.currentModule;
    this.context.currentModule = moduleName;

    // Collect declarations within the module
    for (const decl of module.declarations) {
      this.collectDeclaration(decl);
    }

    // Restore previous module context
    this.context.currentModule = previousModule;
  }

  private collectType(
    type: AST.TypeDeclaration | AST.ScalarTypeDeclaration,
  ): void {
    const typeName = this.getQualifiedTypeName(type.name);

    if (this.context.types.has(typeName)) {
      this.addError(`Type '${typeName}' is already defined`);
      return;
    }

    this.context.types.set(typeName, type);
  }

  private validateDocumentReferences(document: AST.SDLDocument): void {
    for (const decl of document.declarations) {
      this.validateDeclaration(decl);
    }
  }

  private validateDeclaration(decl: AST.Declaration): void {
    switch (decl.kind) {
      case "ModuleDeclaration":
        this.validateModule(decl);
        break;
      case "TypeDeclaration":
        this.validateType(decl);
        break;
      case "ScalarTypeDeclaration":
        this.validateScalarType(decl);
        break;
      case "AliasDeclaration":
        this.validateAlias(decl);
        break;
      case "FunctionDeclaration":
        this.validateFunction(decl);
        break;
      case "GlobalDeclaration":
        this.validateGlobal(decl);
        break;
      case "AnnotationDeclaration":
        this.validateAnnotation(decl);
        break;
    }
  }

  private validateModule(module: AST.ModuleDeclaration): void {
    const moduleName = module.name.parts.join("::");

    // Set current module context
    const previousModule = this.context.currentModule;
    this.context.currentModule = moduleName;

    // Validate declarations within the module
    for (const decl of module.declarations) {
      this.validateDeclaration(decl);
    }

    // Restore previous module context
    this.context.currentModule = previousModule;
  }

  private validateType(type: AST.TypeDeclaration): void {
    // Validate base types
    if (type.extending) {
      for (const baseType of type.extending) {
        this.validateTypeRef(baseType);
      }
    }

    // Validate members
    const propertyNames = new Set<string>();
    const linkNames = new Set<string>();

    for (const member of type.members) {
      switch (member.kind) {
        case "PropertyDeclaration":
          if (propertyNames.has(member.name.value)) {
            this.addError(
              `Property '${member.name.value}' is already defined in type '${type.name.value}'`,
            );
          }
          propertyNames.add(member.name.value);
          this.validateProperty(member);
          break;
        case "LinkDeclaration":
          if (linkNames.has(member.name.value)) {
            this.addError(
              `Link '${member.name.value}' is already defined in type '${type.name.value}'`,
            );
          }
          linkNames.add(member.name.value);
          this.validateLink(member);
          break;
        case "Constraint":
          this.validateConstraint(member);
          break;
        case "Index":
          this.validateIndex(member);
          break;
        case "Annotation":
          // Annotations are validated separately
          break;
        case "AccessPolicy":
          this.validateAccessPolicy(member);
          break;
      }
    }
  }

  private validateScalarType(type: AST.ScalarTypeDeclaration): void {
    // Validate base types
    if (type.extending) {
      for (const baseType of type.extending) {
        this.validateTypeRef(baseType);
      }
    }

    // Validate constraints
    if (type.constraints) {
      for (const constraint of type.constraints) {
        this.validateConstraint(constraint);
      }
    }
  }

  private validateAlias(alias: AST.AliasDeclaration): void {
    // Validate the expression
    this.validateExpression(alias.using);
  }

  private validateFunction(func: AST.FunctionDeclaration): void {
    // Validate parameter types
    for (const param of func.parameters) {
      this.validateTypeRef(param.type);
    }

    // Validate return type
    this.validateTypeRef(func.returnType);

    // Validate using expression
    if (func.using) {
      this.validateExpression(func.using);
    }
  }

  private validateGlobal(global: AST.GlobalDeclaration): void {
    // Validate type
    this.validateTypeRef(global.type);

    // Validate default expression
    if (global.default) {
      this.validateExpression(global.default);
    }
  }

  private validateAnnotation(annotation: AST.AnnotationDeclaration): void {
    // Validate type if specified
    if (annotation.type) {
      this.validateTypeRef(annotation.type);
    }
  }

  private validateProperty(property: AST.PropertyDeclaration): void {
    // Validate type
    this.validateTypeRef(property.type);

    // Validate default expression
    if (property.default) {
      this.validateExpression(property.default);
    }

    // Validate computed expression
    if (property.computed) {
      this.validateExpression(property.computed);
    }

    // Validate constraints with property type context
    if (property.constraints) {
      const propertyType = property.type.name.parts.join("::");
      for (const constraint of property.constraints) {
        this.validateConstraint(constraint, propertyType);
      }
    }
  }

  private validateLink(link: AST.LinkDeclaration): void {
    // Validate target type
    this.validateTypeRef(link.target);

    // Validate default expression
    if (link.default) {
      this.validateExpression(link.default);
    }

    // Validate computed expression
    if (link.computed) {
      this.validateExpression(link.computed);
    }

    // Validate link properties
    if (link.properties) {
      const propNames = new Set<string>();
      for (const prop of link.properties) {
        if (propNames.has(prop.name.value)) {
          this.addError(
            `Link property '${prop.name.value}' is already defined`,
          );
        }
        propNames.add(prop.name.value);
        this.validateProperty(prop);
      }
    }

    // Validate constraints
    if (link.constraints) {
      for (const constraint of link.constraints) {
        this.validateConstraint(constraint);
      }
    }
  }

  private validateConstraint(
    constraint: AST.Constraint,
    propertyType?: string,
  ): void {
    // Validate constraint expression
    if (constraint.on) {
      this.validateExpression(constraint.on);
    }

    // Validate constraint arguments
    if (constraint.args) {
      for (const arg of constraint.args) {
        this.validateExpression(arg);
      }
    }

    const name = constraint.name?.value;
    if (!name) return;

    // Known constraints and their validation rules
    const STRING_TYPES = new Set(["str", "bytes"]);
    const NUMERIC_TYPES = new Set([
      "int16", "int32", "int64", "float32", "float64", "decimal", "bigint",
    ]);
    const SINGLE_ARG_CONSTRAINTS = new Set([
      "max_len_value", "min_len_value",
      "max_value", "min_value",
      "max_ex_value", "min_ex_value",
    ]);

    // Validate argument count for known constraints
    if (SINGLE_ARG_CONSTRAINTS.has(name)) {
      if (!constraint.args || constraint.args.length !== 1) {
        this.addError(
          `Constraint '${name}' requires exactly one argument`,
        );
      }
    }

    if (name === "one_of") {
      if (!constraint.args || constraint.args.length === 0) {
        this.addError(
          "Constraint 'one_of' requires at least one argument",
        );
      }
    }

    if (name === "expression" && !constraint.on) {
      this.addError(
        "Constraint 'expression' requires an 'on' expression",
      );
    }

    // Type compatibility checks (when property type is known)
    if (propertyType) {
      if (
        (name === "max_len_value" || name === "min_len_value") &&
        !STRING_TYPES.has(propertyType)
      ) {
        this.addError(
          `Constraint '${name}' can only be applied to 'str' or 'bytes' properties, not '${propertyType}'`,
        );
      }

      if (
        (name === "max_value" || name === "min_value" ||
          name === "max_ex_value" || name === "min_ex_value") &&
        !NUMERIC_TYPES.has(propertyType) && propertyType !== "datetime" &&
        propertyType !== "duration"
      ) {
        this.addError(
          `Constraint '${name}' can only be applied to numeric or temporal properties, not '${propertyType}'`,
        );
      }
    }
  }

  private validateIndex(index: AST.Index): void {
    // Validate index expression
    this.validateExpression(index.on);
  }

  private validateAccessPolicy(policy: AST.AccessPolicy): void {
    // Validate condition expression
    if (policy.condition) {
      this.validateExpression(policy.condition);
    }

    // Validate actions
    for (const action of policy.actions) {
      if (action.operations.length === 0) {
        this.addError(
          `Access policy '${policy.name.value}' has action with no operations`,
        );
      }
    }
  }

  private validateTypeRef(typeRef: AST.TypeRef): void {
    const typeName = typeRef.name.parts.join("::");

    // Check built-in types
    const builtinTypes = [
      "str",
      "bool",
      "int16",
      "int32",
      "int64",
      "float32",
      "float64",
      "decimal",
      "bigint",
      "json",
      "uuid",
      "bytes",
      "datetime",
      "duration",
      "cal::local_datetime",
      "cal::local_date",
      "cal::local_time",
    ];

    if (builtinTypes.includes(typeName)) {
      return; // Built-in type is valid
    }

    // Try to resolve in current module
    if (this.context.currentModule && !typeName.includes("::")) {
      const qualifiedName = `${this.context.currentModule}::${typeName}`;
      if (this.context.types.has(qualifiedName)) {
        return; // Found in current module
      }
    }

    // Check global types
    if (!this.context.types.has(typeName)) {
      this.addError(`Type '${typeName}' is not defined`);
    }
  }

  private validateExpression(expr: AST.Expression): void {
    switch (expr.kind) {
      case "Literal":
        // Literals are always valid
        break;
      case "PathExpression":
        // Path expressions need context-aware validation
        // For now, we'll accept them
        break;
      case "BinaryOp":
        this.validateExpression(expr.left);
        this.validateExpression(expr.right);
        break;
      case "UnaryOp":
        this.validateExpression(expr.operand);
        break;
      case "FunctionCall":
        // Validate function arguments
        for (const arg of expr.args) {
          this.validateExpression(arg);
        }
        break;
      case "TypeCast":
        this.validateExpression(expr.expr);
        this.validateTypeRef(expr.type);
        break;
      case "Parameter":
        // Parameters are valid in expressions
        break;
      case "ConditionalExpression":
        this.validateExpression(expr.test);
        this.validateExpression(expr.consequent);
        this.validateExpression(expr.alternate);
        break;
    }
  }

  private getQualifiedTypeName(name: AST.Identifier): string {
    if (this.context.currentModule) {
      return `${this.context.currentModule}::${name.value}`;
    }
    return name.value;
  }

  private addError(message: string): void {
    const error = new ValidationError(message);
    this.context.errors.push(error);
  }
}
