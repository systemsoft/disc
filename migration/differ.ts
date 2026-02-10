/**
 * Schema diff engine for generating migration operations
 */

import * as SchemaAST from "../schema/ast.ts";
import * as Types from "./types.ts";

export class SchemaDiffer {
  diff(oldSchema: SchemaAST.Module[], newSchema: SchemaAST.Module[]): Types.MigrationOperation[] {
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

  private extractTypes(modules: SchemaAST.Module[]): Map<string, SchemaAST.TypeDef> {
    const types = new Map<string, SchemaAST.TypeDef>();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "TypeDef") {
          types.set(item.name.name, item);
        }
      }
    }

    return types;
  }

  private createTypeOperation(typeDef: SchemaAST.TypeDef): Types.CreateTypeOperation {
    const properties = this.extractProperties(typeDef);
    const links = this.extractLinks(typeDef);

    return Types.createTypeOperation(typeDef.name.name, properties, links);
  }

  private extractProperties(typeDef: SchemaAST.TypeDef): Types.PropertyDefinition[] {
    const properties: Types.PropertyDefinition[] = [];

    for (const item of typeDef.items) {
      if (item.kind === "Property") {
        properties.push({
          name: item.name.name,
          type: this.typeToString(item.type),
          required: item.required || false,
          multi: item.multi || false,
          default: item.default ? this.extractDefaultValue(item.default) : undefined,
          constraints: this.extractConstraints(item.constraints || []),
          annotations: this.extractAnnotations(item.annotations || []),
        });
      }
    }

    return properties;
  }

  private extractLinks(typeDef: SchemaAST.TypeDef): Types.LinkDefinition[] {
    const links: Types.LinkDefinition[] = [];

    for (const item of typeDef.items) {
      if (item.kind === "Link") {
        links.push({
          name: item.name.name,
          target: this.typeToString(item.target),
          required: item.required || false,
          multi: item.multi || false,
          cardinality: item.cardinality,
          on_target_delete: item.on_target_delete,
          annotations: this.extractAnnotations(item.annotations || []),
        });
      }
    }

    return links;
  }

  private diffType(oldType: SchemaAST.TypeDef, newType: SchemaAST.TypeDef): Types.TypeOperation[] {
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

  private typeToString(type: SchemaAST.TypeExpr): string {
    switch (type.kind) {
      case "NamedType":
        return type.name.name;
      case "GenericType":
        return `${type.name.name}<${type.args.map(arg => this.typeToString(arg)).join(", ")}>`;
      case "TupleType":
        return `tuple<${type.elements.map(el => this.typeToString(el.type)).join(", ")}>`;
      case "UnionType":
        return type.types.map(t => this.typeToString(t)).join(" | ");
      default:
        return "unknown";
    }
  }

  private extractDefaultValue(expr: SchemaAST.Expression): any {
    if (expr.kind === "Literal") {
      return expr.value;
    }
    // For now, return string representation of complex expressions
    return expr.kind;
  }

  private extractConstraints(constraints: SchemaAST.Constraint[]): string[] {
    return constraints.map(constraint => constraint.name.name);
  }

  private extractAnnotations(annotations: SchemaAST.Annotation[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const annotation of annotations) {
      result[annotation.name.name] = annotation.value ? this.extractDefaultValue(annotation.value) : true;
    }
    return result;
  }
}