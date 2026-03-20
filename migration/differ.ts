/**
 * Schema diff engine for generating migration operations
 */

import * as AST from "../schema/ast.ts";
import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";

export class SchemaDiffer {
  diff(oldSchema: Module[], newSchema: Module[]): Types.MigrationOperation[] {
    const operations: Types.MigrationOperation[] = [];

    // Convert schemas to maps for easier comparison
    const oldTypes = this.extractTypes(oldSchema);
    const newTypes = this.extractTypes(newSchema);

    // Find types that were added
    for (const [typeName, typeDef] of newTypes) {
      if (!oldTypes.has(typeName)) {
        operations.push(this.createTypeOperation(typeDef));
      }
    }

    // Find types that were removed
    for (const [typeName] of oldTypes) {
      if (!newTypes.has(typeName)) {
        operations.push(Types.dropTypeOperation(typeName));
      }
    }

    // Find types that were modified
    for (const [typeName, newTypeDef] of newTypes) {
      const oldTypeDef = oldTypes.get(typeName);
      if (oldTypeDef) {
        const alterOps = this.diffType(oldTypeDef, newTypeDef);
        if (alterOps.length > 0) {
          operations.push({
            kind: "AlterType",
            typeName: typeName,
            operations: alterOps,
          } as Types.AlterTypeOperation);
        }
      }
    }

    // Diff aliases
    const oldAliases = this.extractAliases(oldSchema);
    const newAliases = this.extractAliases(newSchema);

    // Added aliases
    for (const [aliasName, aliasDef] of newAliases) {
      if (!oldAliases.has(aliasName)) {
        operations.push(
          Types.createAliasOperation(
            aliasName,
            this.extractExpressionString(aliasDef.using),
          ),
        );
      }
    }

    // Removed aliases
    for (const [aliasName] of oldAliases) {
      if (!newAliases.has(aliasName)) {
        operations.push(Types.dropAliasOperation(aliasName));
      }
    }

    // Modified aliases — drop old + add new (aliases can't be altered in place)
    for (const [aliasName, newAliasDef] of newAliases) {
      const oldAliasDef = oldAliases.get(aliasName);
      if (oldAliasDef) {
        const oldExpr = this.extractExpressionString(oldAliasDef.using);
        const newExpr = this.extractExpressionString(newAliasDef.using);

        if (oldExpr !== newExpr) {
          operations.push(Types.dropAliasOperation(aliasName));
          operations.push(Types.createAliasOperation(aliasName, newExpr));
        }
      }
    }

    return operations;
  }

  private extractTypes(modules: Module[]): Map<string, AST.TypeDeclaration> {
    const types = new Map<string, AST.TypeDeclaration>();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "TypeDeclaration") {
          types.set(item.name.value, item);
        }
      }
    }

    return types;
  }

  private extractAliases(
    modules: Module[],
  ): Map<string, AST.AliasDeclaration> {
    const aliases = new Map<string, AST.AliasDeclaration>();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "AliasDeclaration") {
          aliases.set(item.name.value, item);
        }
      }
    }

    return aliases;
  }

  createTypeOperation(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>,
  ): Types.CreateTypeOperation {
    const properties = this.extractPropertiesWithInheritance(typeDef, allTypes);
    const links = this.extractLinksWithInheritance(typeDef, allTypes);
    const triggers = this.extractTriggers(typeDef);

    const op: Types.CreateTypeOperation = {
      kind: "CreateType",
      typeName: typeDef.name.value,
      properties,
      links,
    };

    // Populate hierarchy fields for DDL discriminator column generation
    if (typeDef.abstract) {
      op.abstract = true;
    }

    if (typeDef.extending && typeDef.extending.length > 0) {
      op.parentTypes = typeDef.extending.map((ext) =>
        ext.name.parts.join("::")
      );
    }

    // Compute direct subtypes from allTypes map
    if (allTypes) {
      const subtypes: string[] = [];
      for (const [name, otherType] of allTypes) {
        if (
          otherType.extending &&
          otherType.extending.some((ext) =>
            ext.name.parts.join("::") === typeDef.name.value
          )
        ) {
          subtypes.push(name);
        }
      }
      if (subtypes.length > 0) {
        op.subtypes = subtypes;
      }
    }

    if (triggers.length > 0) {
      op.triggers = triggers;
    }

    return op;
  }

  /**
   * Extract properties including inherited ones from parent types
   */
  private extractPropertiesWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>,
  ): Types.PropertyDefinition[] {
    const properties = this.extractProperties(typeDef);
    const seenNames = new Set(properties.map((p) => p.name));

    if (allTypes && typeDef.extending) {
      for (const baseRef of typeDef.extending) {
        const baseName = baseRef.name.parts.join("::");
        const baseType = allTypes.get(baseName);
        if (baseType) {
          const inheritedProps = this.extractPropertiesWithInheritance(
            baseType,
            allTypes,
          );
          for (const prop of inheritedProps) {
            if (!seenNames.has(prop.name)) {
              properties.push(prop);
              seenNames.add(prop.name);
            }
          }
        }
      }
    }

    return properties;
  }

  /**
   * Extract links including inherited ones from parent types
   */
  private extractLinksWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>,
  ): Types.LinkDefinition[] {
    const links = this.extractLinks(typeDef);
    const seenNames = new Set(links.map((l) => l.name));

    if (allTypes && typeDef.extending) {
      for (const baseRef of typeDef.extending) {
        const baseName = baseRef.name.parts.join("::");
        const baseType = allTypes.get(baseName);
        if (baseType) {
          const inheritedLinks = this.extractLinksWithInheritance(
            baseType,
            allTypes,
          );
          for (const link of inheritedLinks) {
            if (!seenNames.has(link.name)) {
              links.push(link);
              seenNames.add(link.name);
            }
          }
        }
      }
    }

    return links;
  }

  private extractProperties(
    typeDef: AST.TypeDeclaration,
  ): Types.PropertyDefinition[] {
    const properties: Types.PropertyDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "PropertyDeclaration") {
        const rewrites = this.extractRewrites(member);
        const propDef: Types.PropertyDefinition = {
          name: member.name.value,
          type: this.typeToString(member.type),
          required: member.required || false,
          multi: member.multi || false,
          default: member.default
            ? this.extractDefaultValue(member.default)
            : undefined,
          computed: member.computed
            ? this.extractExpressionString(member.computed)
            : undefined,
          constraints: this.extractConstraints(member.constraints || []),
          annotations: this.extractAnnotations(member.annotations || []),
        };
        if (rewrites.length > 0) {
          propDef.rewrites = rewrites;
        }
        properties.push(propDef);
      }
    }

    return properties;
  }

  private extractLinks(typeDef: AST.TypeDeclaration): Types.LinkDefinition[] {
    const links: Types.LinkDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "LinkDeclaration") {
        const linkDef: Types.LinkDefinition = {
          name: member.name.value,
          target: this.typeToString(member.target),
          required: member.required || false,
          multi: member.multi || false,
          cardinality: member.multi ? "many" : "one",
          onTargetDelete: this.mapOnTargetDelete(member.onTargetDelete),
          onSourceDelete: this.mapOnSourceDelete(member.onSourceDelete),
          annotations: this.extractAnnotations(member.annotations || []),
        };

        // Extract extending references
        if (member.extending && member.extending.length > 0) {
          linkDef.extending = member.extending.map((ext) =>
            ext.name.parts.join("::")
          );
        }

        links.push(linkDef);
      }
    }

    return links;
  }

  private mapOnTargetDelete(
    value?:
      | "restrict"
      | "cascade"
      | "allow"
      | "deferred restrict"
      | "set empty",
  ): Types.LinkDefinition["onTargetDelete"] {
    if (!value) return undefined;
    switch (value) {
      case "restrict":
      case "deferred restrict":
        return "RESTRICT";
      case "cascade":
        return "CASCADE";
      case "allow":
        return "SET NULL";
      case "set empty":
        return "SET NULL";
      default:
        return undefined;
    }
  }

  private mapOnSourceDelete(
    value?: "allow" | "delete target",
  ): Types.LinkDefinition["onSourceDelete"] {
    if (!value) return undefined;
    switch (value) {
      case "allow":
        return "ALLOW";
      case "delete target":
        return "DELETE TARGET";
      default:
        return undefined;
    }
  }

  private diffType(
    oldType: AST.TypeDeclaration,
    newType: AST.TypeDeclaration,
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];
    const typeName = oldType.name.value;

    // Diff properties
    const oldProps = this.extractProperties(oldType);
    const newProps = this.extractProperties(newType);

    operations.push(...this.diffProperties(oldProps, newProps));

    // Diff rewrites for properties that exist in both old and new schemas
    const oldPropsMap = new Map(oldProps.map((p) => [p.name, p]));
    const newPropsMap = new Map(newProps.map((p) => [p.name, p]));

    for (const [propName, newProp] of newPropsMap) {
      const oldProp = oldPropsMap.get(propName);
      if (oldProp) {
        operations.push(
          ...this.diffRewrites(
            typeName,
            propName,
            oldProp.rewrites || [],
            newProp.rewrites || [],
          ),
        );
      }
    }

    // For newly added properties, rewrites are included in the PropertyDefinition
    // For dropped properties, rewrites are implicitly removed with the property

    // Diff links
    const oldLinks = this.extractLinks(oldType);
    const newLinks = this.extractLinks(newType);

    operations.push(...this.diffLinks(oldLinks, newLinks));

    // Diff triggers
    const oldTriggers = this.extractTriggers(oldType);
    const newTriggers = this.extractTriggers(newType);

    operations.push(
      ...this.diffTriggers(typeName, oldTriggers, newTriggers),
    );

    return operations;
  }

  private diffProperties(
    oldProps: Types.PropertyDefinition[],
    newProps: Types.PropertyDefinition[],
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldPropsMap = new Map(oldProps.map((p) => [p.name, p]));
    const newPropsMap = new Map(newProps.map((p) => [p.name, p]));

    // Added properties
    for (const [propName, propDef] of newPropsMap) {
      if (!oldPropsMap.has(propName)) {
        operations.push(Types.addPropertyOperation(propDef));
      }
    }

    // Removed properties
    for (const [propName] of oldPropsMap) {
      if (!newPropsMap.has(propName)) {
        operations.push(Types.dropPropertyOperation(propName));
      }
    }

    // Modified properties
    for (const [propName, newProp] of newPropsMap) {
      const oldProp = oldPropsMap.get(propName);
      if (oldProp) {
        const changes = this.diffProperty(oldProp, newProp);
        if (changes.length > 0) {
          operations.push({
            kind: "AlterProperty",
            propertyName: propName,
            changes,
          } as Types.AlterPropertyOperation);
        }
      }
    }

    return operations;
  }

  private diffProperty(
    oldProp: Types.PropertyDefinition,
    newProp: Types.PropertyDefinition,
  ): Types.PropertyChange[] {
    const changes: Types.PropertyChange[] = [];

    if (oldProp.type !== newProp.type) {
      changes.push({
        kind: "ChangeType",
        oldValue: oldProp.type,
        newValue: newProp.type,
      });
    }

    if (oldProp.required !== newProp.required) {
      changes.push({
        kind: "ChangeRequired",
        oldValue: oldProp.required,
        newValue: newProp.required,
      });
    }

    if (oldProp.multi !== newProp.multi) {
      changes.push({
        kind: "ChangeMulti",
        oldValue: oldProp.multi,
        newValue: newProp.multi,
      });
    }

    if (oldProp.default !== newProp.default) {
      changes.push({
        kind: "ChangeDefault",
        oldValue: oldProp.default,
        newValue: newProp.default,
      });
    }

    // Compare constraints
    const oldConstraints = new Set(oldProp.constraints);
    const newConstraints = new Set(newProp.constraints);

    for (const constraint of newConstraints) {
      if (!oldConstraints.has(constraint)) {
        changes.push({
          kind: "AddConstraint",
          newValue: constraint,
        });
      }
    }

    for (const constraint of oldConstraints) {
      if (!newConstraints.has(constraint)) {
        changes.push({
          kind: "DropConstraint",
          oldValue: constraint,
        });
      }
    }

    return changes;
  }

  private diffLinks(
    oldLinks: Types.LinkDefinition[],
    newLinks: Types.LinkDefinition[],
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldLinksMap = new Map(oldLinks.map((l) => [l.name, l]));
    const newLinksMap = new Map(newLinks.map((l) => [l.name, l]));

    // Added links
    for (const [linkName, linkDef] of newLinksMap) {
      if (!oldLinksMap.has(linkName)) {
        operations.push({
          kind: "AddLink",
          link: linkDef,
        } as Types.AddLinkOperation);
      }
    }

    // Removed links
    for (const [linkName] of oldLinksMap) {
      if (!newLinksMap.has(linkName)) {
        operations.push({
          kind: "DropLink",
          linkName: linkName,
        } as Types.DropLinkOperation);
      }
    }

    // Modified links
    for (const [linkName, newLink] of newLinksMap) {
      const oldLink = oldLinksMap.get(linkName);
      if (oldLink) {
        const changes = this.diffLink(oldLink, newLink);
        if (changes.length > 0) {
          operations.push({
            kind: "AlterLink",
            linkName: linkName,
            changes,
          } as Types.AlterLinkOperation);
        }
      }
    }

    return operations;
  }

  private extractTriggers(
    typeDef: AST.TypeDeclaration,
  ): Types.TriggerDefinition[] {
    const triggers: Types.TriggerDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "TriggerDeclaration") {
        triggers.push({
          name: member.name.value,
          timing: member.timing,
          events: [...member.events],
          scope: member.scope,
          body: this.extractExpressionString(member.body),
        });
      }
    }

    return triggers;
  }

  private diffTriggers(
    typeName: string,
    oldTriggers: Types.TriggerDefinition[],
    newTriggers: Types.TriggerDefinition[],
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldTriggersMap = new Map(oldTriggers.map((t) => [t.name, t]));
    const newTriggersMap = new Map(newTriggers.map((t) => [t.name, t]));

    // Added triggers
    for (const [triggerName, triggerDef] of newTriggersMap) {
      if (!oldTriggersMap.has(triggerName)) {
        operations.push(Types.addTriggerOperation(typeName, triggerDef));
      }
    }

    // Removed triggers
    for (const [triggerName] of oldTriggersMap) {
      if (!newTriggersMap.has(triggerName)) {
        operations.push(Types.dropTriggerOperation(typeName, triggerName));
      }
    }

    // Modified triggers — drop old + add new (triggers can't be altered in place)
    for (const [triggerName, newTrigger] of newTriggersMap) {
      const oldTrigger = oldTriggersMap.get(triggerName);
      if (oldTrigger) {
        const timingChanged = oldTrigger.timing !== newTrigger.timing;
        const eventsChanged = JSON.stringify([...oldTrigger.events].sort()) !==
          JSON.stringify([...newTrigger.events].sort());
        const scopeChanged = oldTrigger.scope !== newTrigger.scope;
        const bodyChanged = oldTrigger.body !== newTrigger.body;

        if (timingChanged || eventsChanged || scopeChanged || bodyChanged) {
          operations.push(Types.dropTriggerOperation(typeName, triggerName));
          operations.push(Types.addTriggerOperation(typeName, newTrigger));
        }
      }
    }

    return operations;
  }

  private extractRewrites(
    propDecl: AST.PropertyDeclaration,
  ): Types.RewriteDefinition[] {
    const rewrites: Types.RewriteDefinition[] = [];

    if (propDecl.rewrites) {
      for (const rewrite of propDecl.rewrites) {
        rewrites.push({
          events: [...rewrite.events],
          body: rewrite.using,
        });
      }
    }

    return rewrites;
  }

  private diffRewrites(
    typeName: string,
    propertyName: string,
    oldRewrites: Types.RewriteDefinition[],
    newRewrites: Types.RewriteDefinition[],
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    // Key rewrites by their sorted event set for comparison
    const eventKey = (events: ("insert" | "update")[]): string =>
      [...events].sort().join(",");

    const oldRewritesMap = new Map(
      oldRewrites.map((r) => [eventKey(r.events), r]),
    );
    const newRewritesMap = new Map(
      newRewrites.map((r) => [eventKey(r.events), r]),
    );

    // Added rewrites
    for (const [key, rewriteDef] of newRewritesMap) {
      if (!oldRewritesMap.has(key)) {
        operations.push(
          Types.createAddRewriteOperation(typeName, propertyName, rewriteDef),
        );
      }
    }

    // Removed rewrites
    for (const [key, rewriteDef] of oldRewritesMap) {
      if (!newRewritesMap.has(key)) {
        operations.push(
          Types.createDropRewriteOperation(
            typeName,
            propertyName,
            rewriteDef.events,
          ),
        );
      }
    }

    // Modified rewrites — drop old + add new (rewrites can't be altered in place)
    for (const [key, newRewrite] of newRewritesMap) {
      const oldRewrite = oldRewritesMap.get(key);
      if (oldRewrite) {
        if (oldRewrite.body !== newRewrite.body) {
          operations.push(
            Types.createDropRewriteOperation(
              typeName,
              propertyName,
              oldRewrite.events,
            ),
          );
          operations.push(
            Types.createAddRewriteOperation(
              typeName,
              propertyName,
              newRewrite,
            ),
          );
        }
      }
    }

    return operations;
  }

  private diffLink(
    oldLink: Types.LinkDefinition,
    newLink: Types.LinkDefinition,
  ): Types.LinkChange[] {
    const changes: Types.LinkChange[] = [];

    if (oldLink.target !== newLink.target) {
      changes.push({
        kind: "ChangeTarget",
        oldValue: oldLink.target,
        newValue: newLink.target,
      });
    }

    if (oldLink.required !== newLink.required) {
      changes.push({
        kind: "ChangeRequired",
        oldValue: oldLink.required,
        newValue: newLink.required,
      });
    }

    if (oldLink.multi !== newLink.multi) {
      changes.push({
        kind: "ChangeMulti",
        oldValue: oldLink.multi,
        newValue: newLink.multi,
      });
    }

    if (oldLink.cardinality !== newLink.cardinality) {
      changes.push({
        kind: "ChangeCardinality",
        oldValue: oldLink.cardinality,
        newValue: newLink.cardinality,
      });
    }

    if (oldLink.onTargetDelete !== newLink.onTargetDelete) {
      changes.push({
        kind: "ChangeOnDelete",
        oldValue: oldLink.onTargetDelete,
        newValue: newLink.onTargetDelete,
      });
    }

    if (oldLink.onSourceDelete !== newLink.onSourceDelete) {
      changes.push({
        kind: "ChangeOnSourceDelete",
        oldValue: oldLink.onSourceDelete,
        newValue: newLink.onSourceDelete,
      });
    }

    // Compare extending arrays
    const oldExtending = JSON.stringify(
      (oldLink.extending ?? []).sort(),
    );
    const newExtending = JSON.stringify(
      (newLink.extending ?? []).sort(),
    );
    if (oldExtending !== newExtending) {
      changes.push({
        kind: "ChangeExtending",
        oldValue: oldLink.extending,
        newValue: newLink.extending,
      });
    }

    return changes;
  }

  private typeToString(type: AST.TypeRef): string {
    let result = type.name.parts.join("::");
    if (type.params && type.params.length > 0) {
      result += `<${type.params.map((p) => this.typeToString(p)).join(", ")}>`;
    }
    return result;
  }

  private extractDefaultValue(expr: AST.Expression): any {
    if (expr.kind === "Literal") {
      return expr.value;
    }
    // For now, return string representation of complex expressions
    return expr.kind;
  }

  /**
   * Extract a string representation of an AST expression.
   * Used for computed property expressions.
   */
  private extractExpressionString(expr: AST.Expression): string {
    switch (expr.kind) {
      case "Literal":
        if (typeof expr.value === "string") return `'${expr.value}'`;
        return String(expr.value);
      case "FunctionCall":
        return `${expr.name.parts.join("::")}(${
          expr.args.map((a) => this.extractExpressionString(a)).join(", ")
        })`;
      case "PathExpression":
        return expr.path.join(".");
      case "BinaryOp":
        return `${this.extractExpressionString(expr.left)} ${expr.op} ${
          this.extractExpressionString(expr.right)
        }`;
      case "UnaryOp":
        return `${expr.op} ${this.extractExpressionString(expr.operand)}`;
      case "TypeCast":
        return `<${expr.type.name.parts.join("::")}>${
          this.extractExpressionString(expr.expr)
        }`;
      case "Parameter":
        return `$${expr.name}`;
      case "ConditionalExpression":
        return `${this.extractExpressionString(expr.consequent)} if ${
          this.extractExpressionString(expr.test)
        } else ${this.extractExpressionString(expr.alternate)}`;
      default:
        return String(expr.kind);
    }
  }

  private extractConstraints(constraints: AST.Constraint[]): string[] {
    return constraints.map((constraint) => {
      const name = constraint.name?.value || "unnamed";

      // Handle "expression on (...)" constraints
      if (name === "expression" && constraint.on) {
        const exprStr = this.extractExpressionString(constraint.on);
        return `expression_on(${exprStr})`;
      }

      if (constraint.args && constraint.args.length > 0) {
        const args = constraint.args.map((arg) => {
          if (arg.kind === "Literal") {
            return String(arg.value);
          }

          return String(arg);
        }).join(",");

        return `${name}(${args})`;
      }

      return name;
    });
  }

  private extractAnnotations(
    annotations: AST.Annotation[],
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const annotation of annotations) {
      const name = annotation.name.parts.join("::");
      result[name] = annotation.value
        ? this.extractDefaultValue(annotation.value)
        : true;
    }
    return result;
  }
}
