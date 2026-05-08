/**
 * Schema diff engine for generating migration operations
 */

import * as AST from "../schema/ast.ts";
import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";

/**
 * Per-`allTypes` memoization for the initial-migration path. (gh/geldata#5322)
 *
 * `createTypeOperation(typeDef, allTypes)` used to scan `allTypes` for each
 * call to find direct subtypes (O(N) per type → O(N²) for the whole pass)
 * and recursively walked the parent chain in `extractPropertiesWithInheritance`
 * / `extractLinksWithInheritance` (O(depth) per type → O(N²) on a deep
 * inheritance chain). This cache flips both to amortized O(1):
 *
 *   - `subtypes`: reverse parent→child map, built once per `allTypes` Map.
 *   - `props` / `links`: memoized inheritance-resolved member lists, so each
 *     parent's contribution is computed once and reused by every descendant.
 */
interface DiffCache {
  subtypes: Map<string, string[]>;
  props: Map<AST.TypeDeclaration, Types.PropertyDefinition[]>;
  links: Map<AST.TypeDeclaration, Types.LinkDefinition[]>;
}

export class SchemaDiffer {
  private caches = new WeakMap<
    Map<string, AST.TypeDeclaration>,
    DiffCache
  >();

  private getCache(
    allTypes: Map<string, AST.TypeDeclaration>
  ): DiffCache {
    let cache = this.caches.get(allTypes);
    if (cache)
      return cache;
    const subtypes = new Map<string, string[]>();
    for (const [childName, child] of allTypes) {
      if (!child.extending)
        continue;
      for (const ext of child.extending) {
        const parentName = ext.name.parts.join("::");
        let bucket = subtypes.get(parentName);
        if (!bucket) {
          bucket = [];
          subtypes.set(parentName, bucket);
        }
        bucket.push(childName);
      }
    }
    cache = {
      subtypes,
      props: new Map(),
      links: new Map()
    };
    this.caches.set(allTypes, cache);
    return cache;
  }

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
        const alterOps = this.diffType(
          oldTypeDef,
          newTypeDef,
          oldTypes,
          newTypes
        );
        if (alterOps.length > 0) {
          operations.push({
            kind: "AlterType",
            typeName: typeName,
            operations: alterOps
          } as Types.AlterTypeOperation);
        }
      }
    }

    // Diff scalar/enum declarations (gh/geldata#8517, #2564). Disc tracks
    // scalars alongside object types so enum-value changes produce real
    // migration plans instead of silent no-ops.
    const oldScalars = this.extractScalars(oldSchema);
    const newScalars = this.extractScalars(newSchema);

    // Added scalars
    for (const [scalarName, scalarDef] of newScalars) {
      if (!oldScalars.has(scalarName)) {
        const op: Types.CreateScalarOperation = {
          kind: "CreateScalar",
          scalarName: scalarDef.decl.name.value,
          module: scalarDef.module,
          baseType: this.scalarBaseType(scalarDef.decl),
          enumValues: this.scalarEnumValues(scalarDef.decl)
        };
        operations.push(op);
      }
    }

    // Removed scalars
    for (const [scalarName, scalarDef] of oldScalars) {
      if (!newScalars.has(scalarName)) {
        const op: Types.DropScalarOperation = {
          kind: "DropScalar",
          scalarName: scalarDef.decl.name.value,
          module: scalarDef.module
        };
        operations.push(op);
      }
    }

    // Modified scalars — only enum value changes are diff-able today.
    // Non-enum scalar changes (constraints, base) are out of scope and
    // surface as a no-op with a comment in DDL emission.
    for (const [scalarName, newScalarDef] of newScalars) {
      const oldScalarDef = oldScalars.get(scalarName);
      if (!oldScalarDef)
        continue;

      const oldValues = this.scalarEnumValues(oldScalarDef.decl) ?? [];
      const newValues = this.scalarEnumValues(newScalarDef.decl) ?? [];

      // Only compare enum value lists when both sides are enum-like.
      const oldIsEnum = this.isEnumScalar(oldScalarDef.decl);
      const newIsEnum = this.isEnumScalar(newScalarDef.decl);
      if (!oldIsEnum || !newIsEnum)
        continue;

      operations.push(
        ...this.diffEnumValues(
          newScalarDef.decl.name.value,
          newScalarDef.module,
          oldValues,
          newValues
        )
      );
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
            this.extractExpressionString(aliasDef.using)
          )
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

    // Diff globals
    const oldGlobals = this.extractGlobals(oldSchema);
    const newGlobals = this.extractGlobals(newSchema);

    // Added globals
    for (const [globalName, globalDef] of newGlobals) {
      if (!oldGlobals.has(globalName)) {
        const moduleName = globalDef.module;
        const edgeqlType = this.typeToString(globalDef.decl.type);
        const pgType = this.edgeqlTypeToPgType(edgeqlType);
        operations.push(
          Types.createGlobalOperation(
            globalDef.decl.name.value,
            moduleName,
            edgeqlType,
            pgType,
            {
              required: globalDef.decl.required,
              multi: globalDef.decl.multi,
              default: globalDef.decl.default ? this.extractExpressionString(globalDef.decl.default) : undefined,
              readonly: globalDef.decl.readonly
            }
          )
        );
      }
    }

    // Removed globals
    for (const [globalName, globalDef] of oldGlobals) {
      if (!newGlobals.has(globalName)) {
        operations.push(
          Types.dropGlobalOperation(
            globalDef.decl.name.value,
            globalDef.module
          )
        );
      }
    }

    // Modified globals — drop old + add new (globals can't be altered in place)
    for (const [globalName, newGlobalDef] of newGlobals) {
      const oldGlobalDef = oldGlobals.get(globalName);
      if (oldGlobalDef) {
        const oldType = this.typeToString(oldGlobalDef.decl.type);
        const newType = this.typeToString(newGlobalDef.decl.type);
        const oldRequired = oldGlobalDef.decl.required ?? false;
        const newRequired = newGlobalDef.decl.required ?? false;
        const oldMulti = oldGlobalDef.decl.multi ?? false;
        const newMulti = newGlobalDef.decl.multi ?? false;
        const oldDefault = oldGlobalDef.decl.default ? this.extractExpressionString(oldGlobalDef.decl.default) : undefined;
        const newDefault = newGlobalDef.decl.default ? this.extractExpressionString(newGlobalDef.decl.default) : undefined;
        const oldReadonly = oldGlobalDef.decl.readonly ?? false;
        const newReadonly = newGlobalDef.decl.readonly ?? false;

        if (
          oldType !== newType ||
          oldRequired !== newRequired ||
          oldMulti !== newMulti ||
          oldDefault !== newDefault ||
          oldReadonly !== newReadonly
        ) {
          operations.push(
            Types.dropGlobalOperation(
              oldGlobalDef.decl.name.value,
              oldGlobalDef.module
            )
          );
          const pgType = this.edgeqlTypeToPgType(newType);
          operations.push(
            Types.createGlobalOperation(
              newGlobalDef.decl.name.value,
              newGlobalDef.module,
              newType,
              pgType,
              {
                required: newGlobalDef.decl.required,
                multi: newGlobalDef.decl.multi,
                default: newDefault,
                readonly: newGlobalDef.decl.readonly
              }
            )
          );
        }
      }
    }

    return this.reorderForCascade(operations);
  }

  /**
   * Cascade-aware reordering pass. (gh/geldata#8517)
   *
   * Once a property's PG type can be `disc_enum_<name>` (via the
   * scalar registry on DDLGenerator), operation order matters in PG:
   *
   *   - `CREATE TYPE` for an enum must run **before** any
   *     `ADD COLUMN ... <enum_type>` referencing it.
   *   - `DROP TYPE` (and the destructive `RecreateScalar` path) must
   *     run **after** any `DROP COLUMN`/`ALTER COLUMN TYPE` that
   *     removes the dependency, otherwise PG refuses the drop.
   *
   * Three buckets, stable within each: enum-creates first,
   * everything else in the middle (preserves the existing diff order),
   * enum-drops/recreates last. `AddEnumValue` sits in the create
   * bucket — it grows the enum's value set non-destructively, so
   * doing it before columns reference the new value is always safe.
   */
  private reorderForCascade(
    operations: Types.MigrationOperation[]
  ): Types.MigrationOperation[] {
    const creates: Types.MigrationOperation[] = [];
    const middle: Types.MigrationOperation[] = [];
    const drops: Types.MigrationOperation[] = [];
    for (const op of operations) {
      switch (op.kind) {
        case "CreateScalar":
        case "AddEnumValue":
          creates.push(op);
          break;
        case "DropScalar":
        case "RecreateScalar":
          drops.push(op);
          break;
        default:
          middle.push(op);
      }
    }
    return [...creates, ...middle, ...drops];
  }

  /**
   * Names of every enum-typed scalar declared in `schema`. Used to
   * prime `DDLGenerator.setEnumScalars(...)` so column emission
   * resolves user scalar names to their PG `disc_enum_<name>` type
   * instead of the TEXT fallback. Non-enum scalars are excluded
   * because they map to the underlying PG type at column emission and
   * have no PG type of their own. (gh/geldata#8517)
   *
   * Returns both qualified (`module::Name`) and unqualified (`Name`)
   * forms because property type strings can appear either way
   * depending on how the SDL referenced the scalar — properties in
   * the same module typically use the bare name; cross-module
   * references use the qualified form.
   */
  enumScalarNames(schema: Module[]): Set<string> {
    const names = new Set<string>();
    const scalars = this.extractScalars(schema);
    for (const [qualifiedName, def] of scalars) {
      if (this.isEnumScalar(def.decl)) {
        names.add(qualifiedName);
        names.add(def.decl.name.value);
      }
    }
    return names;
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
    modules: Module[]
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

  private extractGlobals(
    modules: Module[]
  ): Map<string, { decl: AST.GlobalDeclaration; module: string; }> {
    const globals = new Map<
      string,
      { decl: AST.GlobalDeclaration; module: string; }
    >();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "GlobalDeclaration") {
          const qualifiedName = `${module.name}::${item.name.value}`;
          globals.set(qualifiedName, { decl: item, module: module.name });
        }
      }
    }

    return globals;
  }

  /**
   * Map an EdgeQL type name to a PostgreSQL type name.
   * Simplified mapping for migration operations.
   */
  private edgeqlTypeToPgType(edgeqlType: string): string {
    const typeMap: Record<string, string> = {
      str: "text",
      int16: "smallint",
      int32: "integer",
      int64: "bigint",
      float32: "real",
      float64: "double precision",
      bool: "boolean",
      uuid: "uuid",
      datetime: "timestamptz",
      duration: "interval",
      bytes: "bytea",
      json: "jsonb",
      decimal: "numeric",
      bigint: "numeric"
    };
    return typeMap[edgeqlType] || "text";
  }

  createTypeOperation(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.CreateTypeOperation {
    const properties = this.extractPropertiesWithInheritance(typeDef, allTypes);
    const links = this.extractLinksWithInheritance(typeDef, allTypes);
    const triggers = this.extractTriggers(typeDef);

    const op: Types.CreateTypeOperation = {
      kind: "CreateType",
      typeName: typeDef.name.value,
      properties,
      links
    };

    // Populate hierarchy fields for DDL discriminator column generation
    if (typeDef.abstract) {
      op.abstract = true;
    }

    if (typeDef.extending && typeDef.extending.length > 0) {
      op.parentTypes = typeDef.extending.map(ext => ext.name.parts.join("::"));
    }

    // Compute direct subtypes via the cached reverse parent→child map.
    // (gh/geldata#5322 — was O(N) per call, now O(1).)
    if (allTypes) {
      const subtypes = this.getCache(allTypes).subtypes.get(typeDef.name.value);
      if (subtypes && subtypes.length > 0) {
        op.subtypes = [...subtypes];
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
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.PropertyDefinition[] {
    if (allTypes) {
      const cache = this.getCache(allTypes);
      const cached = cache.props.get(typeDef);
      if (cached)
        return [...cached];
      const resolved = this.computePropertiesWithInheritance(typeDef, allTypes);
      cache.props.set(typeDef, resolved);
      return [...resolved];
    }
    return this.computePropertiesWithInheritance(typeDef, allTypes);
  }

  private computePropertiesWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.PropertyDefinition[] {
    const properties = this.extractProperties(typeDef);
    const seenNames = new Set(properties.map(p => p.name));

    if (allTypes && typeDef.extending) {
      for (const baseRef of typeDef.extending) {
        const baseName = baseRef.name.parts.join("::");
        const baseType = allTypes.get(baseName);
        if (baseType) {
          const inheritedProps = this.extractPropertiesWithInheritance(
            baseType,
            allTypes
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
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.LinkDefinition[] {
    if (allTypes) {
      const cache = this.getCache(allTypes);
      const cached = cache.links.get(typeDef);
      if (cached)
        return [...cached];
      const resolved = this.computeLinksWithInheritance(typeDef, allTypes);
      cache.links.set(typeDef, resolved);
      return [...resolved];
    }
    return this.computeLinksWithInheritance(typeDef, allTypes);
  }

  private computeLinksWithInheritance(
    typeDef: AST.TypeDeclaration,
    allTypes?: Map<string, AST.TypeDeclaration>
  ): Types.LinkDefinition[] {
    const links = this.extractLinks(typeDef);
    const seenNames = new Set(links.map(l => l.name));

    if (allTypes && typeDef.extending) {
      for (const baseRef of typeDef.extending) {
        const baseName = baseRef.name.parts.join("::");
        const baseType = allTypes.get(baseName);
        if (baseType) {
          const inheritedLinks = this.extractLinksWithInheritance(
            baseType,
            allTypes
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
    typeDef: AST.TypeDeclaration
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
          default: member.default ? this.extractDefaultValue(member.default) : undefined,
          computed: member.computed ? this.extractExpressionString(member.computed) : undefined,
          constraints: this.extractConstraints(member.constraints || []),
          annotations: this.extractAnnotations(member.annotations || [])
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
          annotations: this.extractAnnotations(member.annotations || [])
        };

        // Extract extending references
        if (member.extending && member.extending.length > 0) {
          linkDef.extending = member.extending.map(ext => ext.name.parts.join("::"));
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
      | "set empty"
  ): Types.LinkDefinition["onTargetDelete"] {
    if (!value)
      return undefined;
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
    value?: "allow" | "delete target"
  ): Types.LinkDefinition["onSourceDelete"] {
    if (!value)
      return undefined;
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
    oldAllTypes?: Map<string, AST.TypeDeclaration>,
    newAllTypes?: Map<string, AST.TypeDeclaration>
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];
    const typeName = oldType.name.value;

    // Diff properties using resolved (inheritance-walked) sets so that
    // dropping `extending A` surfaces as DropProperty ops for the
    // properties B inherited from A. (gh/geldata#4215 — the gap was
    // own-only diff, which silently missed inherited-property losses.)
    const oldProps = oldAllTypes ? this.extractPropertiesWithInheritance(oldType, oldAllTypes) : this.extractProperties(oldType);
    const newProps = newAllTypes ? this.extractPropertiesWithInheritance(newType, newAllTypes) : this.extractProperties(newType);

    operations.push(...this.diffProperties(oldProps, newProps));

    // Rewrites are own-only (not inherited) — keep extractProperties
    // for the rewrite comparison so we don't double-count rewrites
    // declared on the parent.
    const oldOwnProps = this.extractProperties(oldType);
    const newOwnProps = this.extractProperties(newType);
    const oldPropsMap = new Map(oldOwnProps.map(p => [p.name, p]));
    const newPropsMap = new Map(newOwnProps.map(p => [p.name, p]));

    for (const [propName, newProp] of newPropsMap) {
      const oldProp = oldPropsMap.get(propName);
      if (oldProp) {
        operations.push(
          ...this.diffRewrites(
            typeName,
            propName,
            oldProp.rewrites || [],
            newProp.rewrites || []
          )
        );
      }
    }

    // For newly added properties, rewrites are included in the PropertyDefinition
    // For dropped properties, rewrites are implicitly removed with the property

    // Diff links using resolved (inheritance-walked) sets — same
    // reasoning as properties above. (gh/geldata#4215)
    const oldLinks = oldAllTypes ? this.extractLinksWithInheritance(oldType, oldAllTypes) : this.extractLinks(oldType);
    const newLinks = newAllTypes ? this.extractLinksWithInheritance(newType, newAllTypes) : this.extractLinks(newType);

    operations.push(...this.diffLinks(oldLinks, newLinks));

    // Diff triggers
    const oldTriggers = this.extractTriggers(oldType);
    const newTriggers = this.extractTriggers(newType);

    operations.push(
      ...this.diffTriggers(typeName, oldTriggers, newTriggers)
    );

    return operations;
  }

  private diffProperties(
    oldProps: Types.PropertyDefinition[],
    newProps: Types.PropertyDefinition[]
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
            propertyName: propName,
            changes
          } as Types.AlterPropertyOperation);
        }
      }
    }

    return operations;
  }

  private diffProperty(
    oldProp: Types.PropertyDefinition,
    newProp: Types.PropertyDefinition
  ): Types.PropertyChange[] {
    const changes: Types.PropertyChange[] = [];

    if (oldProp.type !== newProp.type) {
      changes.push({
        kind: "ChangeType",
        oldValue: oldProp.type,
        newValue: newProp.type
      });
    }

    if (oldProp.required !== newProp.required) {
      changes.push({
        kind: "ChangeRequired",
        oldValue: oldProp.required,
        newValue: newProp.required
      });
    }

    if (oldProp.multi !== newProp.multi) {
      changes.push({
        kind: "ChangeMulti",
        oldValue: oldProp.multi,
        newValue: newProp.multi
      });
    }

    if (oldProp.default !== newProp.default) {
      changes.push({
        kind: "ChangeDefault",
        oldValue: oldProp.default,
        newValue: newProp.default
      });
    }

    // Compare constraints
    const oldConstraints = new Set(oldProp.constraints);
    const newConstraints = new Set(newProp.constraints);

    for (const constraint of newConstraints) {
      if (!oldConstraints.has(constraint)) {
        changes.push({
          kind: "AddConstraint",
          newValue: constraint
        });
      }
    }

    for (const constraint of oldConstraints) {
      if (!newConstraints.has(constraint)) {
        changes.push({
          kind: "DropConstraint",
          oldValue: constraint
        });
      }
    }

    // Compare computed expression
    if (oldProp.computed !== newProp.computed) {
      changes.push({
        kind: "ChangeComputed",
        oldValue: oldProp.computed,
        newValue: newProp.computed
      });
    }

    // Compare annotations (added/removed/changed)
    const oldAnns = oldProp.annotations ?? {};
    const newAnns = newProp.annotations ?? {};
    const annNames = new Set([
      ...Object.keys(oldAnns),
      ...Object.keys(newAnns)
    ]);
    for (const name of annNames) {
      const oldVal = oldAnns[name];
      const newVal = newAnns[name];
      if (oldVal === undefined && newVal !== undefined) {
        changes.push({
          kind: "AddAnnotation",
          annotationName: name,
          newValue: newVal
        });
      } else if (oldVal !== undefined && newVal === undefined) {
        changes.push({
          kind: "DropAnnotation",
          annotationName: name,
          oldValue: oldVal
        });
      } else if (oldVal !== newVal) {
        changes.push({
          kind: "ChangeAnnotation",
          annotationName: name,
          oldValue: oldVal,
          newValue: newVal
        });
      }
    }

    return changes;
  }

  private diffLinks(
    oldLinks: Types.LinkDefinition[],
    newLinks: Types.LinkDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldLinksMap = new Map(oldLinks.map(l => [l.name, l]));
    const newLinksMap = new Map(newLinks.map(l => [l.name, l]));

    // Added links
    for (const [linkName, linkDef] of newLinksMap) {
      if (!oldLinksMap.has(linkName)) {
        operations.push({
          kind: "AddLink",
          link: linkDef
        } as Types.AddLinkOperation);
      }
    }

    // Removed links
    for (const [linkName] of oldLinksMap) {
      if (!newLinksMap.has(linkName)) {
        operations.push({
          kind: "DropLink",
          linkName: linkName
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
            changes
          } as Types.AlterLinkOperation);
        }
      }
    }

    return operations;
  }

  private extractTriggers(
    typeDef: AST.TypeDeclaration
  ): Types.TriggerDefinition[] {
    const triggers: Types.TriggerDefinition[] = [];

    for (const member of typeDef.members) {
      if (member.kind === "TriggerDeclaration") {
        triggers.push({
          name: member.name.value,
          timing: member.timing,
          events: [...member.events],
          scope: member.scope,
          body: this.extractExpressionString(member.body)
        });
      }
    }

    return triggers;
  }

  private diffTriggers(
    typeName: string,
    oldTriggers: Types.TriggerDefinition[],
    newTriggers: Types.TriggerDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    const oldTriggersMap = new Map(oldTriggers.map(t => [t.name, t]));
    const newTriggersMap = new Map(newTriggers.map(t => [t.name, t]));

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
    propDecl: AST.PropertyDeclaration
  ): Types.RewriteDefinition[] {
    const rewrites: Types.RewriteDefinition[] = [];

    if (propDecl.rewrites) {
      for (const rewrite of propDecl.rewrites) {
        rewrites.push({
          events: [...rewrite.events],
          body: rewrite.using
        });
      }
    }

    return rewrites;
  }

  private diffRewrites(
    typeName: string,
    propertyName: string,
    oldRewrites: Types.RewriteDefinition[],
    newRewrites: Types.RewriteDefinition[]
  ): Types.TypeOperation[] {
    const operations: Types.TypeOperation[] = [];

    // Key rewrites by their sorted event set for comparison
    const eventKey = (events: ("insert" | "update")[]): string => [...events].sort().join(",");

    const oldRewritesMap = new Map(
      oldRewrites.map(r => [eventKey(r.events), r])
    );
    const newRewritesMap = new Map(
      newRewrites.map(r => [eventKey(r.events), r])
    );

    // Added rewrites
    for (const [key, rewriteDef] of newRewritesMap) {
      if (!oldRewritesMap.has(key)) {
        operations.push(
          Types.createAddRewriteOperation(typeName, propertyName, rewriteDef)
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
            rewriteDef.events
          )
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
              oldRewrite.events
            )
          );
          operations.push(
            Types.createAddRewriteOperation(
              typeName,
              propertyName,
              newRewrite
            )
          );
        }
      }
    }

    return operations;
  }

  private diffLink(
    oldLink: Types.LinkDefinition,
    newLink: Types.LinkDefinition
  ): Types.LinkChange[] {
    const changes: Types.LinkChange[] = [];

    if (oldLink.target !== newLink.target) {
      changes.push({
        kind: "ChangeTarget",
        oldValue: oldLink.target,
        newValue: newLink.target
      });
    }

    if (oldLink.required !== newLink.required) {
      changes.push({
        kind: "ChangeRequired",
        oldValue: oldLink.required,
        newValue: newLink.required
      });
    }

    if (oldLink.multi !== newLink.multi) {
      changes.push({
        kind: "ChangeMulti",
        oldValue: oldLink.multi,
        newValue: newLink.multi
      });
    }

    if (oldLink.cardinality !== newLink.cardinality) {
      changes.push({
        kind: "ChangeCardinality",
        oldValue: oldLink.cardinality,
        newValue: newLink.cardinality
      });
    }

    if (oldLink.onTargetDelete !== newLink.onTargetDelete) {
      changes.push({
        kind: "ChangeOnDelete",
        oldValue: oldLink.onTargetDelete,
        newValue: newLink.onTargetDelete
      });
    }

    if (oldLink.onSourceDelete !== newLink.onSourceDelete) {
      changes.push({
        kind: "ChangeOnSourceDelete",
        oldValue: oldLink.onSourceDelete,
        newValue: newLink.onSourceDelete
      });
    }

    // Compare extending arrays
    const oldExtending = JSON.stringify(
      (oldLink.extending ?? []).sort()
    );
    const newExtending = JSON.stringify(
      (newLink.extending ?? []).sort()
    );
    if (oldExtending !== newExtending) {
      changes.push({
        kind: "ChangeExtending",
        oldValue: oldLink.extending,
        newValue: newLink.extending
      });
    }

    return changes;
  }

  private typeToString(type: AST.TypeRef): string {
    let result = type.name.parts.join("::");
    if (type.params && type.params.length > 0) {
      result += `<${type.params.map(p => this.typeToString(p)).join(", ")}>`;
    }
    return result;
  }

  private extractDefaultValue(expr: AST.Expression): any {
    if (expr.kind === "Literal") {
      return expr.value;
    }
    return this.extractExpressionString(expr);
  }

  /**
   * Extract a string representation of an AST expression.
   * Used for computed property expressions.
   */
  private extractExpressionString(expr: AST.Expression): string {
    switch (expr.kind) {
      case "Literal":
        if (typeof expr.value === "string")
          return `'${expr.value}'`;
        return String(expr.value);
      case "FunctionCall":
        return `${expr.name.parts.join("::")}(${expr.args.map(a => this.extractExpressionString(a)).join(", ")})`;
      case "PathExpression":
        return expr.path.join(".");
      case "BinaryOp":
        return `${this.extractExpressionString(expr.left)} ${expr.op} ${this.extractExpressionString(expr.right)}`;
      case "UnaryOp":
        return `${expr.op} ${this.extractExpressionString(expr.operand)}`;
      case "TypeCast":
        return `<${expr.type.name.parts.join("::")}>${this.extractExpressionString(expr.expr)}`;
      case "Parameter":
        return `$${expr.name}`;
      case "ConditionalExpression":
        return `${this.extractExpressionString(expr.consequent)} if ${this.extractExpressionString(expr.test)} else ${
          this.extractExpressionString(expr.alternate)
        }`;
      case "TupleExpression":
        return `(${expr.elements.map(e => this.extractExpressionString(e)).join(", ")})`;
      default:
        return String((expr as { kind: string; }).kind);
    }
  }

  private extractConstraints(constraints: AST.Constraint[]): string[] {
    return constraints.map(constraint => {
      const name = constraint.name?.value || "unnamed";

      // Handle "expression on (...)" constraints
      if (name === "expression" && constraint.on) {
        const exprStr = this.extractExpressionString(constraint.on);
        return `expression_on(${exprStr})`;
      }

      if (constraint.args && constraint.args.length > 0) {
        const args = constraint
          .args
          .map(arg => {
            if (arg.kind === "Literal") {
              return String(arg.value);
            }

            return String(arg);
          })
          .join(",");

        return `${name}(${args})`;
      }

      return name;
    });
  }

  private extractAnnotations(
    annotations: AST.Annotation[]
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const annotation of annotations) {
      const name = annotation.name.parts.join("::");
      result[name] = annotation.value ? this.extractDefaultValue(annotation.value) : true;
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Scalar / enum extraction (gh/geldata#8517, #2564)
  // ──────────────────────────────────────────────────────────────────────

  private extractScalars(
    modules: Module[]
  ): Map<string, { decl: AST.ScalarTypeDeclaration; module: string; }> {
    const scalars = new Map<
      string,
      { decl: AST.ScalarTypeDeclaration; module: string; }
    >();

    for (const module of modules) {
      for (const item of module.items) {
        if (item.kind === "ScalarTypeDeclaration") {
          const qualifiedName = `${module.name}::${item.name.value}`;
          scalars.set(qualifiedName, { decl: item, module: module.name });
        }
      }
    }

    return scalars;
  }

  /**
   * Check whether a scalar extends `enum<...>`. The SDL parser stores
   * `extending enum<a, b>` as a TypeRef whose name parts begin with `enum`
   * and whose `params` carry each enum literal as a TypeRef.
   */
  private isEnumScalar(decl: AST.ScalarTypeDeclaration): boolean {
    return (decl.extending ?? []).some(
      ext => ext.name.parts[0] === "enum"
    );
  }

  /**
   * Extract enum values from a scalar declaration. Returns `undefined`
   * for non-enum scalars.
   */
  private scalarEnumValues(
    decl: AST.ScalarTypeDeclaration
  ): string[] | undefined {
    if (!this.isEnumScalar(decl))
      return undefined;
    const enumExt = (decl.extending ?? []).find(
      ext => ext.name.parts[0] === "enum"
    );
    if (!enumExt || !enumExt.params)
      return [];
    return enumExt.params.map(p => p.name.parts.join("::"));
  }

  /**
   * Render the base type of a scalar (used for `CreateScalarOperation`).
   * Non-enum scalars get the joined `extending` chain; enum scalars get
   * the literal `"enum"` string (values live separately).
   */
  private scalarBaseType(decl: AST.ScalarTypeDeclaration): string {
    if (this.isEnumScalar(decl))
      return "enum";
    if (!decl.extending || decl.extending.length === 0)
      return "anyscalar";
    return decl
      .extending
      .map(ext => ext.name.parts.join("::"))
      .join(", ");
  }

  /**
   * Diff old vs new enum value lists. PostgreSQL's enum semantics
   * dictate the operation choice:
   *
   *  - **Pure additions** at the tail → emit `AddEnumValueOperation`
   *    (one per added value). Cheap, non-destructive.
   *  - **Pure additions in the middle** → emit `AddEnumValueOperation`
   *    with `before` set to the next existing value. Still cheap.
   *  - **Removals** or **reorders** → emit a single
   *    `RecreateScalarOperation` flagged unsafe. Recreating an enum
   *    means dropping/re-adding any column referencing it; the
   *    unsafe-gate refuses these without `--unsafe`.
   */
  private diffEnumValues(
    scalarName: string,
    moduleName: string,
    oldValues: string[],
    newValues: string[]
  ): Types.MigrationOperation[] {
    if (oldValues.length === 0 && newValues.length === 0)
      return [];

    const oldSet = new Set(oldValues);
    const newSet = new Set(newValues);

    const removed = oldValues.filter(v => !newSet.has(v));
    const added = newValues.filter(v => !oldSet.has(v));

    // If anything was removed, this is a recreate (PG has no DROP VALUE).
    if (removed.length > 0) {
      return [
        {
          kind: "RecreateScalar",
          scalarName,
          module: moduleName,
          enumValues: newValues,
          oldEnumValues: oldValues,
          reason: "removed-values"
        } as Types.RecreateScalarOperation
      ];
    }

    // No removals — check whether the *retained* values kept their order.
    const retainedOld = oldValues.filter(v => newSet.has(v));
    const retainedNew = newValues.filter(v => oldSet.has(v));
    const reordered = retainedOld.length > 0 &&
      retainedOld.some((v, i) => v !== retainedNew[i]);

    if (reordered) {
      return [
        {
          kind: "RecreateScalar",
          scalarName,
          module: moduleName,
          enumValues: newValues,
          oldEnumValues: oldValues,
          reason: "reordered-values"
        } as Types.RecreateScalarOperation
      ];
    }

    // Pure additions — emit one ADD VALUE per new entry, anchored by
    // its successor in the new list when that successor still exists.
    const ops: Types.AddEnumValueOperation[] = [];
    for (const value of added) {
      const newIdx = newValues.indexOf(value);
      // Find the closest *successor* that already existed in the old
      // list; anchor with `before` so PG inserts in the right slot.
      let anchorBefore: string | undefined;
      for (let i = newIdx + 1; i < newValues.length; i++) {
        if (oldSet.has(newValues[i])) {
          anchorBefore = newValues[i];
          break;
        }
      }
      ops.push({
        kind: "AddEnumValue",
        scalarName,
        module: moduleName,
        value,
        ...(anchorBefore ? { before: anchorBefore } : {})
      });
    }
    return ops;
  }
}
