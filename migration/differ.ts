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
            type_name: typeName,
            operations: alterOps,
          });
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

  createTypeOperation(typeDef: AST.TypeDeclaration): Types.CreateTypeOperation {
    const properties = this.extractProperties(typeDef);
    const links = this.extractLinks(typeDef);

    return {
      kind: "CreateType",
      type_name: typeDef.name.value,
      properties,
      links,
      constraints: [],
      indexes: [],
    };
  }

  private extractProperties(typeDef: AST.TypeDeclaration): Types.PropertyDefinition[] {
    const properties: Types.PropertyDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "PropertyDeclaration") {
        properties.push({
          name: member.name.value,
          type: this.typeToString(member.type),
          required: member.required || false,
          multi: member.multi || false,
          default: member.default ? this.extractDefaultValue(member.default) : undefined,
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
          on_target_delete: member.onTargetDelete,
          annotations: this.extractAnnotations(member.annotations || []),
        });
      }
    }

    return links;
  }

  private diffType(oldType: AST.TypeDeclaration, newType: AST.TypeDeclaration): Types.TypeOperation[] {
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

    const oldPropsMap = new Map(oldProps.map(p => [p.name, p]));
    const newPropsMap = new Map(newProps.map(p => [p.name, p]));

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
            property_name: propName,
            changes,
          });
        }
      }
    }

    return operations;
  }

  private diffProperty(oldProp: Types.PropertyDefinition, newProp: Types.PropertyDefinition): Types.PropertyChange[] {
    const changes: Types.PropertyChange[] = [];

    if (oldProp.type !== newProp.type) {
      changes.push({
        kind: "ChangeType",
        old_value: oldProp.type,
        new_value: newProp.type,
      });
    }

    if (oldProp.required !== newProp.required) {
      changes.push({
        kind: "ChangeRequired",
        old_value: oldProp.required,
        new_value: newProp.required,
      });
    }

    if (oldProp.multi !== newProp.multi) {
      changes.push({
        kind: "ChangeMulti",
        old_value: oldProp.multi,
        new_value: newProp.multi,
      });
    }

    if (oldProp.default !== newProp.default) {
      changes.push({
        kind: "ChangeDefault",
        old_value: oldProp.default,
        new_value: newProp.default,
      });
    }

    return changes;
  }

  private diffLinks(oldLinks: Types.LinkDefinition[], newLinks: Types.LinkDefinition[]): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldLinksMap = new Map(oldLinks.map(l => [l.name, l]));
    const newLinksMap = new Map(newLinks.map(l => [l.name, l]));

    // Added links
    for (const [linkName, linkDef] of newLinksMap) {
      if (!oldLinksMap.has(linkName)) {
        operations.push({
          kind: "AddLink",
          link: linkDef,
        });
      }
    }

    // Removed links
    for (const [linkName] of oldLinksMap) {
      if (!newLinksMap.has(linkName)) {
        operations.push({
          kind: "DropLink",
          link_name: linkName,
        });
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
            link_name: linkName,
            changes,
          });
        }
      }
    }

    return operations;
  }

  private diffLink(oldLink: Types.LinkDefinition, newLink: Types.LinkDefinition): Types.LinkChange[] {
    const changes: Types.LinkChange[] = [];

    if (oldLink.target !== newLink.target) {
      changes.push({
        kind: "ChangeTarget",
        old_value: oldLink.target,
        new_value: newLink.target,
      });
    }

    if (oldLink.required !== newLink.required) {
      changes.push({
        kind: "ChangeRequired",
        old_value: oldLink.required,
        new_value: newLink.required,
      });
    }

    if (oldLink.multi !== newLink.multi) {
      changes.push({
        kind: "ChangeMulti",
        old_value: oldLink.multi,
        new_value: newLink.multi,
      });
    }

    if (oldLink.cardinality !== newLink.cardinality) {
      changes.push({
        kind: "ChangeCardinality",
        old_value: oldLink.cardinality,
        new_value: newLink.cardinality,
      });
    }

    if (oldLink.on_target_delete !== newLink.on_target_delete) {
      changes.push({
        kind: "ChangeOnDelete",
        old_value: oldLink.on_target_delete,
        new_value: newLink.on_target_delete,
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
    return constraints.map(constraint => constraint.name?.value || "unnamed");
  }

  private extractAnnotations(annotations: AST.Annotation[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const annotation of annotations) {
      const name = annotation.name.parts.join("::");
      result[name] = annotation.value ? this.extractDefaultValue(annotation.value) : true;
    }
    return result;
  }
}