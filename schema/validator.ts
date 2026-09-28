/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL Schema Validator - Validates SDL AST for correctness
 */

import { isPolymorphicType } from "../compiler/context.ts";
import type * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ValidationError } from "../lib/errors.ts";
import { propNameToColumnName } from "../lib/identifiers.ts";
import * as AST from "./ast.ts";
import { Module, SDLConverter } from "./converter.ts";
import { sdlExpressionToEdgeQL } from "./expression-printer.ts";

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

/**
 * Functions whose value is not a function of their arguments: a constraint
 * expression calling one is not immutable (Gel: "constraint expressions must
 * be immutable"). Without the `std::` prefix.
 */
const EXPRESSION_HINT = "A constraint expression becomes a PostgreSQL CHECK, so it may only read the object's own properties and single links.";

/*** `edgeql` in the parentheses of `on (…)`, once. ***/
function parenthesized(edgeql: string): string {
  return edgeql.startsWith("(") && edgeql.endsWith(")") ? edgeql : `(${edgeql})`;
}

const NOT_IMMUTABLE_FUNCTIONS = new Set([
  "datetime_current",
  "datetime_of_statement",
  "datetime_of_transaction",
  "random",
  "sequence_next",
  "sequence_reset",
  "uuid_generate_v1mc",
  "uuid_generate_v4"
]);

/*** Functions of a whole set, which a constraint can't call (Gel: "cannot use SET OF function … in a constraint"). ***/
const SET_OF_FUNCTIONS = new Set([
  "all",
  "any",
  "array_agg",
  "assert_distinct",
  "assert_exists",
  "assert_single",
  "avg",
  "count",
  "enumerate",
  "max",
  "min",
  "stddev",
  "stddev_pop",
  "sum",
  "var",
  "var_pop"
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
          this.validatePropertyExpressions(type, member);
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
          this.validateTypeConstraint(type, member);
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
        // `sequence` is only valid here: each scalar extending it has its own counter.
        if (baseType.name.parts.join("::") !== "sequence")
          this.validateTypeRef(baseType);
      }
    }

    // Validate constraints. Each becomes a CHECK on every column of the
    // scalar's type (`SchemaDiffer.declaredChecks`), so its expression may
    // read only the value, `__subject__`.
    if (type.constraints) {
      const scalarName = this.getQualifiedTypeName(type.name);
      for (const constraint of type.constraints) {
        this.validateConstraint(constraint);
        if (constraint.name?.value === "exclusive") {
          this.addConstraintError(`Scalar type '${scalarName}': abstract constraint 'std::exclusive' may not be used on scalar types`, constraint);
        }
        if (constraint.name?.value === "expression" && constraint.on) {
          const problem = this.checkExpressionProblem(null, constraint.on);
          if (problem) {
            this.addConstraintError(
              `Scalar type '${scalarName}': 'constraint expression on ${parenthesized(sdlExpressionToEdgeQL(constraint.on))}' can't be enforced — ${problem}`,
              constraint
            );
          }
        }
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
    // Validate type. Computed properties carry the synthetic `auto`
    // placeholder type (the parser can't know the inferred type), so skip
    // type-existence checking for them — the expression is validated below.
    if (!property.computed) {
      this.validateTypeRef(property.type);
    }

    // A computed may be declared `required` (Gel: `required single link
    // x := .author`) when its expression is never empty, and `single` when it
    // never yields several; that needs the schema's types, so it is checked
    // after conversion (detectComputedPointerErrors).

    // A colon-form pointer's target decides whether it is a link: whether
    // `multi x: T` is a multi scalar or a multi link, and whether it may
    // carry link properties and delete policies.
    const isLink = this.isObjectTypeName(property.type.name.parts.join("::"));
    if (property.properties && !isLink) {
      this.addError(
        `Property '${property.name.value}': only links can have link properties — '${property.type.name.parts.join("::")}' is not an object type`
      );
    }
    if (isLink) {
      this.validateLinkProperties(property.name.value, property.multi ?? false, property.properties ?? []);
    }
    if ((property.onTargetDelete || property.onSourceDelete) && !isLink) {
      this.addError(
        `Property '${property.name.value}': only links can have a delete policy — '${property.type.name.parts.join("::")}' is not an object type`
      );
    }

    if (property.multi && !property.computed && !isLink) {
      this.validateMultiScalar(property.name.value, property.type, property.constraints, property.default !== undefined);
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
        if (isLink) {
          this.validateLinkConstraint(property.name.value, constraint);
        }
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

  /**
   * A stored multi scalar property is a PostgreSQL array column, one value
   * per element. Reject what that storage can't express yet: a per-element
   * `exclusive` (unique across all objects' elements), an `expression on`
   * constraint (a CHECK can't iterate the elements), a default, and an
   * `array<…>` element (PG arrays are not arrays of arrays).
   */
  private validateMultiScalar(
    name: string,
    type: AST.TypeRef,
    constraints: AST.Constraint[] | undefined,
    hasDefault: boolean
  ): void {
    for (const constraint of constraints ?? []) {
      const constraintName = constraint.name?.value;
      if (constraintName === "exclusive" || constraintName === "expression") {
        this.addError(
          `Property '${name}': constraint '${constraintName}' is not supported on a multi property yet (it is stored as an array; ` +
            "per-element uniqueness and expression constraints can't be checked)"
        );
      }
    }
    if (hasDefault) {
      this.addError(`Property '${name}': a default on a multi property is not supported yet — an unset multi property is the empty set`);
    }
    if (type.name.parts.join("::") === "array") {
      this.addError(`Property '${name}': a multi property of array type is not supported (it is stored as an array column)`);
    }
  }

  /*** True when `name` resolves to a declared object type (in the current module or fully qualified). ***/
  private isObjectTypeName(name: string): boolean {
    const qualified = this.context.currentModule && !name.includes("::") ? `${this.context.currentModule}::${name}` : name;
    const decl = this.context.types.get(qualified) ?? this.context.types.get(name);
    return decl?.kind === "TypeDeclaration";
  }

  private validateLink(link: AST.LinkDeclaration): void {
    // Validate target type (skip placeholder target for abstract links without
    // targets, and computed links whose target is the inferred `auto`
    // placeholder — the expression is validated below).
    const targetName = link.target.name.parts.join("::");
    if (targetName !== "std::BaseObject" && !link.computed) {
      this.validateTypeRef(link.target);
    }

    // `multi name -> str` is a multi scalar property in arrow form.
    if (link.multi && !link.computed && !link.abstract && !this.isObjectTypeName(targetName)) {
      this.validateMultiScalar(link.name.value, link.target, link.constraints, link.default !== undefined);
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

    // Validate link properties. A concrete link also carries those of the
    // abstract links it extends.
    const inherited = (link.extending ?? []).flatMap(base => this.context.abstractLinks.get(base.name.parts.join("::"))?.properties ?? []);
    if (link.abstract) {
      this.validateLinkProperties(link.name.value, true, link.properties ?? []);
    } else if (link.properties || inherited.length > 0) {
      if (!link.computed && !this.isObjectTypeName(targetName)) {
        this.addError(`Property '${link.name.value}': only links can have link properties — '${targetName}' is not an object type`);
      }
      this.validateLinkProperties(link.name.value, link.multi ?? false, link.properties ?? [], inherited.length > 0);
    }

    // Validate constraints
    if (link.constraints) {
      for (const constraint of link.constraints) {
        this.validateConstraint(constraint);
        if (!link.abstract && this.isObjectTypeName(targetName)) {
          this.validateLinkConstraint(link.name.value, constraint);
        }
      }
    }

    // Validate annotation usages
    this.validateAnnotationUsage(link.annotations);
  }

  /**
   * Link properties are stored as columns of a multi link's junction table,
   * so a single link can't carry them (it is a foreign-key column), and each
   * one is a single stored value whose column name must not collide with the
   * junction's own `source_id` / `target_id`.
   */
  private validateLinkProperties(
    linkName: string,
    multi: boolean,
    properties: AST.PropertyDeclaration[],
    hasInherited = false
  ): void {
    if (!multi && (properties.length > 0 || hasInherited)) {
      this.addError(
        `Link '${linkName}': link properties are only supported on multi links (they are stored on the link's junction table) — ` +
          "declare the link `multi`, or move the property onto the target type"
      );
    }
    const propNames = new Set<string>();
    for (const prop of properties) {
      const name = prop.name.value;
      if (propNames.has(name)) {
        this.addError(`Link property '${name}' is already defined`);
      }
      propNames.add(name);
      if (prop.multi) {
        this.addError(`Link property '${linkName}@${name}' cannot be multi — a link property holds one value per link`);
      }
      if (["source_id", "target_id"].includes(propNameToColumnName(name))) {
        this.addError(`Link property '${linkName}@${name}': the name is reserved for the link's junction table columns`);
      }
      if ((prop.constraints ?? []).some(c => c.name?.value === "exclusive")) {
        this.addError(`Link property '${linkName}@${name}': constraint 'exclusive' is not supported on a link property yet`);
      }
      this.validateProperty(prop);
    }
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

  /**
   * A constraint in a link's body that Disc would otherwise drop without a
   * trace: any but `exclusive`, the only one a link's storage enforces.
   */
  private validateLinkConstraint(pointer: string, constraint: AST.Constraint): void {
    const name = constraint.name?.value;
    if (!name || !SUPPORTED_CONSTRAINTS.has(name)) {
      return; // reported by validateConstraint
    }

    if (name !== "exclusive") {
      this.addConstraintError(
        `Link '${pointer}': constraint '${name}' is not supported on a link — ` +
          `write it on the type instead, e.g. \`constraint expression on (exists .${pointer})\``,
        constraint
      );
    }
  }

  /**
   * A constraint on an object type rather than on one of its properties or
   * links. Disc enforces two kinds there: `exclusive on (…)`, a unique index,
   * and `expression on (…)`, a PostgreSQL CHECK on the table of the type and
   * of each concrete subtype (`SchemaDiffer.declaredChecks`). Any other kind,
   * or an expression a CHECK can't hold, would silently not be enforced, so
   * it is an error.
   */
  private validateTypeConstraint(type: AST.TypeDeclaration, constraint: AST.Constraint): void {
    const name = constraint.name?.value;
    if (!name || !SUPPORTED_CONSTRAINTS.has(name)) {
      return; // reported by validateConstraint
    }

    const typeName = this.getQualifiedTypeName(type.name);

    if (name !== "exclusive" && name !== "expression") {
      this.addConstraintError(
        `Type '${typeName}': constraint '${name}' is not supported on an object type — ` +
          `declare it on the property it constrains, or write it as \`constraint expression on (…)\``,
        constraint
      );
      return;
    }

    if (!constraint.on) {
      if (name === "exclusive") {
        this.addConstraintError(
          `Type '${typeName}': constraint 'exclusive' on an object type needs 'on (…)', e.g. \`constraint exclusive on (.email)\``,
          constraint
        );
      }
      return; // `expression` without `on` is reported by validateConstraint
    }

    if (name === "expression") {
      const problem = this.checkExpressionProblem(type, constraint.on);
      if (problem) {
        this.addConstraintError(
          `Type '${typeName}': 'constraint expression on ${
            parenthesized(sdlExpressionToEdgeQL(constraint.on))
          }' can't be enforced — ${problem}. ${EXPRESSION_HINT}`,
          constraint
        );
      }
    }
  }

  /**
   * A property's `constraint expression on (__subject__ …)` becomes a CHECK
   * on its type's table with `__subject__` read as the property
   * (`SchemaDiffer.declaredChecks`), so it may read what a type-level one
   * may.
   */
  private validatePropertyExpressions(type: AST.TypeDeclaration, property: AST.PropertyDeclaration): void {
    for (const constraint of property.constraints ?? []) {
      if (constraint.name?.value !== "expression" || !constraint.on || property.multi || property.computed) {
        continue;
      }
      const bound = AST.replaceSubject(constraint.on, { kind: "PathExpression", path: [".", property.name.value] });
      const problem = this.checkExpressionProblem(type, bound);
      if (problem) {
        this.addConstraintError(
          `Type '${this.getQualifiedTypeName(type.name)}', property '${property.name.value}': ` +
            `'constraint expression on ${parenthesized(sdlExpressionToEdgeQL(constraint.on))}' can't be enforced — ${problem}. ${EXPRESSION_HINT}`,
          constraint
        );
      }
    }
  }

  /**
   * Why a type-level constraint expression can't be a CHECK on the object's
   * row, or undefined. Gel's own rules: no path with more than one hop, no
   * set of values (a multi link or property, a backlink, an aggregate, a
   * query), and only immutable values (no time, randomness, globals or
   * parameters). What passes here still has to compile to a row-local
   * boolean (see `EdgeQLCompiler.checkConstraintSql`). With no `type`, a
   * scalar type's constraint: it may read only its value, `__subject__`.
   */
  private checkExpressionProblem(type: AST.TypeDeclaration | null, expr: AST.Expression): string | undefined {
    const first = (exprs: AST.Expression[]): string | undefined => {
      for (const e of exprs) {
        const problem = this.checkExpressionProblem(type, e);
        if (problem) {
          return problem;
        }
      }
      return undefined;
    };

    switch (expr.kind) {
      case "Literal":
        return undefined;
      case "Parameter":
        return `it reads the query parameter '$${expr.name.replace(/^\$/, "")}'`;
      case "BinaryOp":
        return first([expr.left, expr.right]);
      case "UnaryOp":
        return first([expr.operand]);
      case "TypeCast":
        return first([expr.expr]);
      case "ConditionalExpression":
        return first([expr.test, expr.consequent, expr.alternate]);
      case "TupleExpression":
        return first(expr.elements);
      case "NamedTupleExpression":
        return first(expr.elements.map(element => element.value));
      case "FunctionCall": {
        const fn = expr.name.parts.join("::").replace(/^std::/, "");
        if (NOT_IMMUTABLE_FUNCTIONS.has(fn)) {
          return `constraint expressions must be immutable, and ${fn}() is not`;
        }
        if (SET_OF_FUNCTIONS.has(fn)) {
          return `it calls the aggregate ${fn}(), which reads a set rather than one object's values`;
        }
        return first(expr.args);
      }
      case "PathExpression":
        return this.checkPathProblem(type, expr);
    }
  }

  private checkPathProblem(type: AST.TypeDeclaration | null, path: AST.PathExpression): string | undefined {
    if (path.source !== undefined) {
      return this.checkEdgeQLProblem(type, new EdgeQLParser(path.source).parseExpressionOnly());
    }
    if (path.path[0] === "global") {
      return `constraint expressions must be immutable, and it reads the global '${path.path[1]}'`;
    }
    if (type === null) {
      return path.path.length === 1 && path.path[0] === "__subject__" ?
        undefined :
        `a scalar type's constraint can only read its value, '__subject__' (not '${sdlExpressionToEdgeQL(path)}')`;
    }
    if (path.path[0] === "__subject__") {
      return `write '.${path.path.slice(1).join(".")}' rather than '__subject__.…' in a type-level constraint`;
    }
    if (path.path[0] !== ".") {
      const name = path.path.join("::");
      return this.isObjectTypeName(name) ? `it reads every '${name}' object` : undefined;
    }

    const steps = path.path.slice(1);
    const written = sdlExpressionToEdgeQL(path);
    if (steps[0].startsWith("<")) {
      return `it reads the backlink '${written}'`;
    }
    if (steps.length > 1) {
      return `constraints cannot contain paths with more than one hop ('${written}')`;
    }
    if (steps[0] === "id") {
      return undefined;
    }

    const member = this.findTypeMember(type, steps[0], new Set());
    if (!member) {
      return `'${written}' is not a property or link of '${type.name.value}'`;
    }
    const kind = member.kind === "LinkDeclaration" || this.isObjectTypeName(member.type.name.parts.join("::")) ? "link" : "property";
    if (member.multi) {
      return `it reads the multi ${kind} '${steps[0]}'`;
    }
    if (member.computed) {
      return `it reads the computed ${kind} '${steps[0]}'`;
    }
    return undefined;
  }

  /**
   * `checkExpressionProblem` for EdgeQL beyond the SDL expression grammar
   * (kept as its source text, parsed as `expr`): a query, a parameter, a
   * function Gel's constraints reject, or a path `checkPathProblem` rejects.
   */
  private checkEdgeQLProblem(type: AST.TypeDeclaration | null, expr: EdgeQLAST.EdgeQLNode): string | undefined {
    const visit = (node: unknown): string | undefined => {
      if (Array.isArray(node)) {
        return node.map(visit).find(problem => problem !== undefined);
      }
      if (!node || typeof node !== "object") {
        return undefined;
      }
      const ast = node as EdgeQLAST.Expression | EdgeQLAST.Query;
      switch (ast.kind) {
        case "Subquery":
        case "SelectQuery":
        case "InsertQuery":
        case "UpdateQuery":
        case "DeleteQuery":
        case "GroupQuery":
        case "ForQuery":
        case "WithBlock":
          return "it contains a query";
        case "Parameter":
          return `it reads the query parameter '$${ast.name.replace(/^\$/, "")}'`;
        case "GlobalRef":
          return this.checkPathProblem(type, { kind: "PathExpression", path: ["global", ast.module ? `${ast.module}::${ast.name}` : ast.name] });
        case "Identifier":
          return this.checkPathProblem(type, { kind: "PathExpression", path: [ast.name] });
        case "TypeName":
          return this.checkPathProblem(type, { kind: "PathExpression", path: ast.name.parts });
        case "Path":
          return this.checkPathProblem(type, {
            kind: "PathExpression",
            path: [...ast.rooted ? [] : ["."], ...ast.steps.map(step => step.type === "backlink" ? `<${step.name}` : step.name)]
          });
        case "TypeCast":
          return visit(ast.expr);
        case "FunctionCall": {
          const fn = ast.name.parts.join("::").replace(/^std::/, "");
          if (NOT_IMMUTABLE_FUNCTIONS.has(fn)) {
            return `constraint expressions must be immutable, and ${fn}() is not`;
          }
          if (SET_OF_FUNCTIONS.has(fn)) {
            return `it calls the aggregate ${fn}(), which reads a set rather than one object's values`;
          }
          return visit(ast.args);
        }
      }
      return visit(Object.values(node));
    };
    return visit(expr);
  }

  /*** A property or link of `type` or of a type it extends, nearest first. ***/
  private findTypeMember(
    type: AST.TypeDeclaration,
    name: string,
    seen: Set<AST.TypeDeclaration>
  ): AST.PropertyDeclaration | AST.LinkDeclaration | undefined {
    if (seen.has(type)) {
      return undefined;
    }
    seen.add(type);

    const own = type.members.find((member): member is AST.PropertyDeclaration | AST.LinkDeclaration =>
      (member.kind === "PropertyDeclaration" || member.kind === "LinkDeclaration") && member.name.value === name
    );
    if (own) {
      return own;
    }

    for (const base of type.extending ?? []) {
      const baseName = base.name.parts.join("::");
      const qualified = this.context.currentModule && !baseName.includes("::") ? `${this.context.currentModule}::${baseName}` : baseName;
      const parent = this.context.types.get(qualified) ?? this.context.types.get(baseName);
      const found = parent?.kind === "TypeDeclaration" ? this.findTypeMember(parent, name, seen) : undefined;
      if (found) {
        return found;
      }
    }
    return undefined;
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
      // Gel's arrays of arrays are query values only (UnsupportedFeatureError).
      if (typeRef.params[0].name.parts.join("::") === "array") {
        this.addError("nested arrays are not supported");
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

    // `enum<"A", "B", ...>` appears as a scalar's base type. Its params are
    // string-literal enum values (the parser wraps each as a TypeRef whose
    // name is the quoted value), not type references — so validate that the
    // enum has at least one value but do not recurse into the params.
    if (typeName === "enum") {
      if (!typeRef.params || typeRef.params.length === 0) {
        this.addError(
          `Type 'enum' requires at least one value`
        );
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

      // Gel's range element types, each backed by a PostgreSQL range type
      // (int16 has neither).
      const orderableTypes = [
        "int32",
        "int64",
        "float32",
        "float64",
        "decimal",
        "datetime",
        "cal::local_datetime",
        "cal::local_date"
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

    if (typeName === "sequence") {
      this.addError(
        `Type 'sequence' cannot be used directly; declare a scalar type extending it (scalar type TicketNo extending sequence;)`
      );
      return;
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
