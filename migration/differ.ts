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

  createTypeOperation(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>,
  ): Types.CreateTypeOperation {
    const properties = this.extractPropertiesWithInheritance(typeDef, allTypes);
    const links = this.extractLinksWithInheritance(typeDef, allTypes);

    return {
      kind: "CreateType",
      typeName: typeDef.name.value,
      properties,
      links,
    };
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
        properties.push({
          name: member.name.value,
          type: this.typeToString(member.type),
          required: member.required || false,
          multi: member.multi || false,
          default: member.default
            ? this.extractDefaultValue(member.default)
            : undefined,
          constraints: this.extractConstraints(member.constraints || []),
          annotations: this.extractAnnotations(member.annotations || []),
        });
      }
    }

    return properties;
  }

  private extractLinks(typeDef: AST.TypeDeclaration): Types.LinkDefinition[] {
    const links: Types.LinkDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "LinkDeclaration") {
        links.push({
          name: member.name.value,
          target: this.typeToString(member.target),
          required: member.required || false,
          multi: member.multi || false,
          cardinality: member.multi ? "many" : "one",
          onTargetDelete: this.mapOnTargetDelete(member.onTargetDelete),
          annotations: this.extractAnnotations(member.annotations || []),
        });
      }
    }

    return links;
  }

  private mapOnTargetDelete(
    value?: "restrict" | "cascade" | "allow" | "deferred restrict",
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
      default:
        return undefined;
    }
  }

  private diffType(
    oldType: AST.TypeDeclaration,
    newType: AST.TypeDeclaration,
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    // Diff properties
    const oldProps = this.extractProperties(oldType);
    const newProps = this.extractProperties(newType);

    operations.push(...this.diffProperties(oldProps, newProps));

    // Diff links
    const oldLinks = this.extractLinks(oldType);
    const newLinks = this.extractLinks(newType);

    operations.push(...this.diffLinks(oldLinks, newLinks));

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

    return changes;
  }

  private typeToString(type: AST.TypeRef): string {
    return type.name.parts.join("::");
  }

  private extractDefaultValue(expr: AST.Expression): any {
    if (expr.kind === "Literal") {
      return expr.value;
    }
    // For now, return string representation of complex expressions
    return expr.kind;
  }

  private extractConstraints(constraints: AST.Constraint[]): string[] {
    return constraints.map((constraint) => constraint.name?.value || "unnamed");
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
