/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL Schema Validator - Validates SDL AST for correctness
 */

import { isPolymorphicType } from "../compiler/context.ts";
import { ValidationError } from "../lib/errors.ts";
import * as AST from "./ast.ts";
import { Module, SDLConverter } from "./converter.ts";

/**
 * Built-in annotation names that do not require an explicit
 * `abstract annotation` declaration in the schema.
 *
 * `rest::hidden` and `rest::expand` gate the schema-derived REST surface
 * (Disc-original feature #2): `rest::hidden` excludes a property/link
 * from the default GET shape; `rest::expand` inlines a linked collection
 * rather than emitting a hyperlink. Other `rest::*` names are rejected
 * here so typos surface at validation time. (Bundle J)
 */
const BUILTIN_ANNOTATIONS = new Set([
  "description",
  "title",
  "deprecated",
  "secret",
  "std::secret",
  "rest::hidden",
  "rest::expand"
]);

/**
 * Built-in constraint names supported by Disc. These are the canonical Gel
 * constraint names; each maps to a CHECK (or UNIQUE) constraint at DDL
 * generation time (see `migration/ddl.ts` `constraintToCheckExpression`).
 *
 * Any constraint name outside this set is rejected at validation time so a
 * typo or a non-canonical name (e.g. `max_length`) is a loud error instead of
 * silently dropping the constraint at DDL generation.
 */
const SUPPORTED_CONSTRAINTS = new Set([
  "exclusive",
  "expression",
  "max_ex_value",
  "max_len_value",
  "max_value",
  "min_ex_value",
  "min_len_value",
  "min_value",
  "one_of",
  "regexp"
]);

/**
 * Common non-canonical constraint names (notably from Gel documentation
 * examples) mapped to their canonical Disc/Gel equivalents, used to produce a
 * helpful hint when a user writes the wrong name.
 */
const CONSTRAINT_NAME_HINTS = new Map<string, string>([
  ["max_length", "max_len_value"],
  ["min_length", "min_len_value"],
  ["regex", "regexp"]
]);

interface ValidationContext {
  types: Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration>;
  abstractLinks: Map<string, AST.LinkDeclaration>;
  abstractAnnotations: Map<string, AST.AnnotationDeclaration>;
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
      abstractLinks: new Map(),
      abstractAnnotations: new Map(),
      modules: new Map(),
      errors: []
    };
    this.converter = new SDLConverter();
  }

  validate(
    document: AST.SDLDocument
  ): { ok: boolean; errors?: ValidationError[]; } {
    const errors = this.validateDocument(document);
    return {
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
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
      case "LinkDeclaration":
        this.collectAbstractLink(decl);
        break;
      case "AnnotationDeclaration":
        this.collectAbstractAnnotation(decl);
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
    type: AST.TypeDeclaration | AST.ScalarTypeDeclaration
  ): void {
    const typeName = this.getQualifiedTypeName(type.name);

    if (this.context.types.has(typeName)) {
      this.addError(`Type '${typeName}' is already defined`);
      return;
    }

    this.context.types.set(typeName, type);
  }

  private collectAbstractLink(link: AST.LinkDeclaration): void {
    if (!link.abstract) {
      return;
    }
    const linkName = this.getQualifiedTypeName(link.name);
    this.context.abstractLinks.set(linkName, link);
  }

  private collectAbstractAnnotation(
    annotation: AST.AnnotationDeclaration
  ): void {
    const annotationName = this.getQualifiedTypeName(annotation.name);
    this.context.abstractAnnotations.set(annotationName, annotation);
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
      case "LinkDeclaration":
        this.validateLink(decl);
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
    const triggerNames = new Set<string>();

    for (const member of type.members) {
      switch (member.kind) {
        case "PropertyDeclaration":
          if (propertyNames.has(member.name.value)) {
            this.addError(
              `Property '${member.name.value}' is already defined in type '${type.name.value}'`
            );
          }
          propertyNames.add(member.name.value);
          this.validateProperty(member);
          break;
        case "LinkDeclaration":
          if (linkNames.has(member.name.value)) {
            this.addError(
              `Link '${member.name.value}' is already defined in type '${type.name.value}'`
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
          // Validate that annotation name is declared or built-in
          this.validateAnnotationUsage([member]);
          break;
        case "AccessPolicy":
          this.validateAccessPolicy(member);
          break;
        case "TriggerDeclaration":
          this.validateTrigger(member, type.name.value, triggerNames);
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

  /**
   * Validate that annotation usages reference either a built-in annotation
   * (description, title, deprecated) or a user-declared abstract annotation.
   */
  private validateAnnotationUsage(
    annotations: AST.Annotation[] | undefined
  ): void {
    if (!annotations) {
      return;
    }

    for (const ann of annotations) {
      const name = ann.name.parts.join("::");

      // Check built-in annotations
      if (BUILTIN_ANNOTATIONS.has(name)) {
        continue;
      }

      // Check user-declared abstract annotations (try unqualified and qualified)
      if (this.context.abstractAnnotations.has(name)) {
        continue;
      }

      // Try qualified lookup in current module
      if (this.context.currentModule && !name.includes("::")) {
        const qualifiedName = `${this.context.currentModule}::${name}`;
        if (this.context.abstractAnnotations.has(qualifiedName)) {
          continue;
        }
      }

      this.addError(
        `Annotation '${name}' is not defined; declare it with 'abstract annotation ${name};' or use a built-in annotation`
      );
    }
  }

  private validateProperty(property: AST.PropertyDeclaration): void {
    // Validate type
    this.validateTypeRef(property.type);

    // P3-01: cardinality sanity. `required multi` is valid in Gel and
    // means "at least one element" — but `multi` plus `optional` is
    // redundant noise, and computed properties can't be declared
    // required since their values are derived. Flag these as warnings.
    if (property.computed && property.required) {
      this.addError(
        `Property '${property.name.value}': computed properties cannot also be 'required' — the cardinality is determined by the expression`
      );
    }

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

    // Validate rewrites
    if (property.rewrites) {
      const seenEvents = new Set<string>();
      for (const rewrite of property.rewrites) {
        this.validateRewrite(rewrite, property.name.value, seenEvents);
      }
    }

    // Validate annotation usages
    this.validateAnnotationUsage(property.annotations);
  }

  private validateLink(link: AST.LinkDeclaration): void {
    // Validate target type (skip placeholder target for abstract links without targets)
    const targetName = link.target.name.parts.join("::");
    if (targetName !== "std::BaseObject") {
      this.validateTypeRef(link.target);
    }

    // Validate extending references
    if (link.extending) {
      const visited = new Set<string>();
      for (const baseRef of link.extending) {
        const baseName = baseRef.name.parts.join("::");

        // Check that referenced link exists and is abstract
        if (!this.context.abstractLinks.has(baseName)) {
          this.addError(
            `Link '${link.name.value}' extends '${baseName}', but no abstract link '${baseName}' is defined`
          );
        }

        // Check for circular inheritance
        if (visited.has(baseName)) {
          this.addError(
            `Circular link inheritance detected: '${link.name.value}' extends '${baseName}' multiple times`
          );
        }
        visited.add(baseName);

        // Recursively check for cycles through the abstract link chain
        this.checkLinkInheritanceCycle(
          baseName,
          link.name.value,
          new Set([link.name.value])
        );
      }
    }

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
            `Link property '${prop.name.value}' is already defined`
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

    // Validate annotation usages
    this.validateAnnotationUsage(link.annotations);
  }

  private checkLinkInheritanceCycle(
    linkName: string,
    originalName: string,
    visited: Set<string>
  ): void {
    const abstractLink = this.context.abstractLinks.get(linkName);
    if (!abstractLink || !abstractLink.extending) {
      return;
    }

    for (const baseRef of abstractLink.extending) {
      const baseName = baseRef.name.parts.join("::");

      if (baseName === originalName) {
        this.addError(
          `Circular link inheritance detected: '${originalName}' -> '${linkName}' -> '${baseName}'`
        );
        return;
      }

      if (visited.has(baseName)) {
        return;
      }
      visited.add(baseName);

      this.checkLinkInheritanceCycle(baseName, originalName, visited);
    }
  }

  private validateConstraint(
    constraint: AST.Constraint,
    propertyType?: string
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
    if (!name) {
      return;
    }

    // Reject unsupported constraint names. Without this, an unknown name (a
    // typo, or a non-canonical Gel-doc name like `max_length`) passes
    // validation but silently emits no CHECK constraint at DDL generation.
    if (!SUPPORTED_CONSTRAINTS.has(name)) {
      const canonical = CONSTRAINT_NAME_HINTS.get(name);
      const supported = [...SUPPORTED_CONSTRAINTS].sort().join(", ");
      const hint = canonical ?
        `Did you mean '${canonical}'? Supported constraints: ${supported}.` :
        `Supported constraints: ${supported}.`;
      this.addConstraintError(
        `Constraint '${name}' is not supported`,
        constraint,
        hint
      );
      return;
    }

    // Known constraints and their validation rules
    const STRING_TYPES = new Set(["str", "bytes"]);
    const NUMERIC_TYPES = new Set([
      "int16",
      "int32",
      "int64",
      "float32",
      "float64",
      "decimal",
      "bigint"
    ]);
    const SINGLE_ARG_CONSTRAINTS = new Set([
      "max_len_value",
      "min_len_value",
      "max_value",
      "min_value",
      "max_ex_value",
      "min_ex_value"
    ]);

    // Validate argument count for known constraints
    if (SINGLE_ARG_CONSTRAINTS.has(name)) {
      if (!constraint.args || constraint.args.length !== 1) {
        this.addError(
          `Constraint '${name}' requires exactly one argument`
        );
      }
    }

    if (name === "one_of") {
      if (!constraint.args || constraint.args.length === 0) {
        this.addError(
          "Constraint 'one_of' requires at least one argument"
        );
      }
    }

    if (name === "expression" && !constraint.on) {
      this.addError(
        "Constraint 'expression' requires an 'on' expression"
      );
    }

    // Type compatibility checks (when property type is known)
    if (propertyType) {
      if (
        (name === "max_len_value" || name === "min_len_value") &&
        !STRING_TYPES.has(propertyType)
      ) {
        this.addError(
          `Constraint '${name}' can only be applied to 'str' or 'bytes' properties, not '${propertyType}'`
        );
      }

      if (
        (name === "max_value" || name === "min_value" ||
          name === "max_ex_value" || name === "min_ex_value") &&
        !NUMERIC_TYPES.has(propertyType) && propertyType !== "datetime" &&
        propertyType !== "duration" &&
        propertyType !== "cal::local_datetime" &&
        propertyType !== "cal::local_date" &&
        propertyType !== "cal::local_time" &&
        propertyType !== "cal::relative_duration" &&
        propertyType !== "cal::date_duration"
      ) {
        this.addError(
          `Constraint '${name}' can only be applied to numeric or temporal properties, not '${propertyType}'`
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
    if (policy.withCheck) {
      this.validateExpression(policy.withCheck);
    }

    // Validate actions
    for (const action of policy.actions) {
      if (action.operations.length === 0) {
        this.addError(
          `Access policy '${policy.name.value}' has action with no operations`
        );
      }
    }
  }

  private validateTrigger(
    trigger: AST.TriggerDeclaration,
    typeName: string,
    triggerNames: Set<string>
  ): void {
    // Check for duplicate trigger names within the type
    if (triggerNames.has(trigger.name.value)) {
      this.addError(
        `Trigger '${trigger.name.value}' is already defined in type '${typeName}'`
      );
    }
    triggerNames.add(trigger.name.value);

    // Validate at least one event
    if (trigger.events.length === 0) {
      this.addError(
        `Trigger '${trigger.name.value}' must specify at least one event`
      );
    }

    // Validate no duplicate events
    const seenEvents = new Set<string>();
    for (const event of trigger.events) {
      if (seenEvents.has(event)) {
        this.addError(
          `Trigger '${trigger.name.value}' has duplicate event '${event}'`
        );
      }
      seenEvents.add(event);
    }

    // Validate body expression
    this.validateExpression(trigger.body);
  }

  private validateRewrite(
    rewrite: AST.RewriteDeclaration,
    propertyName: string,
    seenEvents: Set<string>
  ): void {
    // Validate events are non-empty
    if (rewrite.events.length === 0) {
      this.addError(
        `Rewrite on property '${propertyName}' must specify at least one event`
      );
    }

    // Validate events are only "insert" or "update"
    for (const event of rewrite.events) {
      if (event !== "insert" && event !== "update") {
        this.addError(
          `Invalid rewrite event '${event}' on property '${propertyName}'; expected 'insert' or 'update'`
        );
      }
    }

    // Check for duplicate events across rewrites on the same property
    for (const event of rewrite.events) {
      if (seenEvents.has(event)) {
        this.addError(
          `Duplicate rewrite event '${event}' on property '${propertyName}'`
        );
      }
      seenEvents.add(event);
    }

    // Validate using expression is non-empty
    if (!rewrite.using || rewrite.using.trim() === "") {
      this.addError(
        `Rewrite on property '${propertyName}' must have a 'using' expression`
      );
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
      "cal::relative_duration",
      "cal::date_duration"
    ];

    // Validate parameterized types: array<T>, tuple<T1, T2, ...>, range<T>, multirange<T>
    if (typeName === "array") {
      if (!typeRef.params || typeRef.params.length !== 1) {
        this.addError(
          `Type 'array' requires exactly one type parameter`
        );
        return;
      }
      this.validateTypeRef(typeRef.params[0]);
      return;
    }

    if (typeName === "tuple") {
      if (!typeRef.params || typeRef.params.length === 0) {
        this.addError(
          `Type 'tuple' requires at least one type parameter`
        );
        return;
      }
      for (const param of typeRef.params) {
        this.validateTypeRef(param);
      }
      return;
    }

    if (typeName === "range" || typeName === "multirange") {
      if (!typeRef.params || typeRef.params.length !== 1) {
        this.addError(
          `Type '${typeName}' requires exactly one type parameter`
        );
        return;
      }

      const innerType = typeRef.params[0];
      const innerTypeName = innerType.name.parts.join("::");

      // Only orderable scalar types are valid inner types for range/multirange
      const orderableTypes = [
        "int16",
        "int32",
        "int64",
        "float32",
        "float64",
        "decimal",
        "datetime",
        "cal::local_date",
        "cal::local_datetime"
      ];

      if (!orderableTypes.includes(innerTypeName)) {
        this.addError(
          `Type '${innerTypeName}' is not a valid inner type for '${typeName}'; ` +
            `expected one of: ${orderableTypes.join(", ")}`
        );
      }

      // Also validate the inner type ref itself
      this.validateTypeRef(innerType);
      return;
    }

    if (builtinTypes.includes(typeName)) {
      return; // Built-in type is valid
    }

    // Accept abstract polymorphic types (anytype, anyscalar, anyenum, etc.)
    if (isPolymorphicType(typeName)) {
      return;
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

  /**
   * Record a validation error for a constraint, including the constraint
   * name's source location (when the parser recorded it) and an optional hint.
   */
  private addConstraintError(
    message: string,
    constraint: AST.Constraint,
    hint?: string
  ): void {
    const start = constraint.span?.start;
    const error = new ValidationError(message, {
      hint,
      location: start ?
        { column: start.column, line: start.line, offset: start.offset } :
        undefined
    });
    this.context.errors.push(error);
  }
}
