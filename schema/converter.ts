/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL to Schema AST Converter
 *
 * Converts parsed SDL AST to a normalized module structure
 * suitable for migration engine and other tools
 */

import * as AST from "./ast.ts";

export interface Module {
  name: string;
  items: AST.Declaration[];
}

/**
 * Reclassify arrow-shorthand `LinkDeclaration`s that target a non-object
 * type as `PropertyDeclaration`s.
 *
 * The SDL grammar uses `name -> Type` for both scalar properties and object
 * links. The parser can't distinguish them — the kind of the target type is
 * a cross-module question — so it emits `LinkDeclaration` for every arrow.
 * The runtime Schema in `migration/schema-manager.ts:modulesToSchema()`
 * already reclassifies, but the migration differ reads `typeDef.members`
 * directly. Without normalization, scalar arrows like `created -> datetime`
 * generate FK constraints to a non-existent `datetime` table.
 *
 * Returns a new Module[] with rewritten members; inputs are not mutated.
 * Object link declarations, properties, constraints, indexes, and access
 * policies pass through unchanged.
 */
function collectObjectTypeNames(modules: Module[]): Set<string> {
  const objectTypeNames = new Set<string>();
  for (const module of modules) {
    for (const item of module.items) {
      if (item.kind === "TypeDeclaration") {
        const typeDecl = item as AST.TypeDeclaration;
        const name = typeDecl.name.value;
        objectTypeNames.add(name);
        objectTypeNames.add(`${module.name}::${name}`);
      }
    }
  }
  return objectTypeNames;
}

function makeIsObjectTarget(
  objectTypeNames: Set<string>
): (target: AST.TypeRef) => boolean {
  return (target: AST.TypeRef): boolean => {
    const fullName = target.name.parts.join("::");
    return objectTypeNames.has(fullName) ||
      objectTypeNames.has(fullName.replace(/^default::/, ""));
  };
}

export function normalizeArrowsToProperties(modules: Module[]): Module[] {
  const isObjectTarget = makeIsObjectTarget(collectObjectTypeNames(modules));

  return modules.map(module => ({
    name: module.name,
    items: module.items.map(item => {
      if (item.kind !== "TypeDeclaration") {
        return item;
      }
      const typeDecl = item as AST.TypeDeclaration;
      const newMembers = typeDecl.members.map((member): AST.TypeMember => {
        if (member.kind !== "LinkDeclaration") {
          return member;
        }
        const link = member as AST.LinkDeclaration;
        if (link.abstract || isObjectTarget(link.target)) {
          return member;
        }
        const property: AST.PropertyDeclaration = {
          kind: "PropertyDeclaration",
          name: link.name,
          type: link.target
        };
        if (link.required !== undefined) {
          property.required = link.required;
        }
        if (link.multi !== undefined) {
          property.multi = link.multi;
        }
        if (link.readonly !== undefined) {
          property.readonly = link.readonly;
        }
        if (link.computed !== undefined) {
          property.computed = link.computed;
        }
        if (link.default !== undefined) {
          property.default = link.default;
        }
        if (link.constraints !== undefined) {
          property.constraints = link.constraints;
        }
        if (link.annotations !== undefined) {
          property.annotations = link.annotations;
        }
        return property;
      });
      return { ...typeDecl, members: newMembers };
    })
  }));
}

/**
 * Reclassify colon-form `PropertyDeclaration`s that target an object type as
 * `LinkDeclaration`s.
 *
 * Modern SDL declares links with the bare colon form (`author: User`), which
 * the parser emits as a PropertyDeclaration — whether the target is a scalar
 * or an object type is a cross-module question. Without normalization the
 * migration differ treats these as scalar properties and lays down a bare
 * text column named after the link, while the explicit `link` keyword path
 * produces a `<name>_id` uuid FK column for the same schema.
 *
 * Returns a new Module[] with rewritten members; inputs are not mutated.
 * Abstract, computed, and rewrite-bearing properties pass through unchanged
 * (computed members create no columns; rewrites have no link counterpart).
 */
export function normalizeObjectPropertiesToLinks(modules: Module[]): Module[] {
  const isObjectTarget = makeIsObjectTarget(collectObjectTypeNames(modules));

  return modules.map(module => ({
    name: module.name,
    items: module.items.map(item => {
      if (item.kind !== "TypeDeclaration") {
        return item;
      }
      const typeDecl = item as AST.TypeDeclaration;
      const newMembers = typeDecl.members.map((member): AST.TypeMember => {
        if (member.kind !== "PropertyDeclaration") {
          return member;
        }
        const property = member as AST.PropertyDeclaration;
        if (
          property.abstract ||
          property.computed ||
          (property.rewrites && property.rewrites.length > 0) ||
          !isObjectTarget(property.type)
        ) {
          return member;
        }
        const link: AST.LinkDeclaration = {
          kind: "LinkDeclaration",
          name: property.name,
          target: property.type
        };
        if (property.required !== undefined) {
          link.required = property.required;
        }
        if (property.multi !== undefined) {
          link.multi = property.multi;
        }
        if (property.overloaded !== undefined) {
          link.overloaded = property.overloaded;
        }
        if (property.readonly !== undefined) {
          link.readonly = property.readonly;
        }
        if (property.default !== undefined) {
          link.default = property.default;
        }
        if (property.constraints !== undefined) {
          link.constraints = property.constraints;
        }
        if (property.annotations !== undefined) {
          link.annotations = property.annotations;
        }
        return link;
      });
      return { ...typeDecl, members: newMembers };
    })
  }));
}

/**
 * Run both normalization passes over parsed modules. Every path that feeds
 * modules to the migration differ or `modulesToSchema` must use this so the
 * arrow and colon forms produce identical storage layouts.
 */
export function normalizeModules(modules: Module[]): Module[] {
  return normalizeObjectPropertiesToLinks(normalizeArrowsToProperties(modules));
}

/**
 * Converts SDL AST to normalized module structure
 */
export class SDLConverter {
  /**
   * Convert an SDL document to an array of modules
   * If no modules are explicitly defined, creates a default module
   */
  convertToModules(document: AST.SDLDocument): Module[] {
    const modules: Module[] = [];
    const defaultModuleItems: AST.Declaration[] = [];

    for (const declaration of document.declarations) {
      if (declaration.kind === "ModuleDeclaration") {
        // Add explicit module
        modules.push({
          name: declaration.name.parts.join("::"),
          items: declaration.declarations
        });
      } else {
        // Collect items for default module
        defaultModuleItems.push(declaration);
      }
    }

    // If there are items not in a module, add them to default module
    if (defaultModuleItems.length > 0) {
      // Check if default module already exists
      const defaultModule = modules.find(m => m.name === "default");
      if (defaultModule) {
        // Add items to existing default module
        defaultModule.items.push(...defaultModuleItems);
      } else {
        // Create new default module
        modules.unshift({
          name: "default",
          items: defaultModuleItems
        });
      }
    }

    // If no modules at all, create empty default module
    if (modules.length === 0) {
      modules.push({
        name: "default",
        items: []
      });
    }

    return modules;
  }

  /**
   * Extract type definitions from modules
   */
  extractTypes(
    modules: Module[]
  ): Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration> {
    const types = new Map<
      string,
      AST.TypeDeclaration | AST.ScalarTypeDeclaration
    >();

    for (const module of modules) {
      const modulePrefix = module.name === "default" ? "" : `${module.name}::`;

      for (const item of module.items) {
        if (
          item.kind === "TypeDeclaration" ||
          item.kind === "ScalarTypeDeclaration"
        ) {
          const qualifiedName = modulePrefix + item.name.value;
          types.set(qualifiedName, item);
        }
      }
    }

    return types;
  }

  /**
   * Extract properties from a type declaration
   */
  extractProperties(type: AST.TypeDeclaration): AST.PropertyDeclaration[] {
    return type.members.filter(
      (member): member is AST.PropertyDeclaration => member.kind === "PropertyDeclaration"
    );
  }

  /**
   * Extract links from a type declaration
   */
  extractLinks(type: AST.TypeDeclaration): AST.LinkDeclaration[] {
    return type.members.filter(
      (member): member is AST.LinkDeclaration => member.kind === "LinkDeclaration"
    );
  }

  /**
   * Extract constraints from a type declaration
   */
  extractConstraints(type: AST.TypeDeclaration): AST.Constraint[] {
    return type.members.filter(
      (member): member is AST.Constraint => member.kind === "Constraint"
    );
  }

  /**
   * Extract indexes from a type declaration
   */
  extractIndexes(type: AST.TypeDeclaration): AST.Index[] {
    return type.members.filter(
      (member): member is AST.Index => member.kind === "Index"
    );
  }

  /**
   * Extract access policies from a type declaration
   */
  extractAccessPolicies(type: AST.TypeDeclaration): AST.AccessPolicy[] {
    return type.members.filter(
      (member): member is AST.AccessPolicy => member.kind === "AccessPolicy"
    );
  }

  /**
   * Resolve type inheritance chain
   */
  resolveInheritance(
    type: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration>
  ): AST.TypeDeclaration[] {
    const chain: AST.TypeDeclaration[] = [];

    if (!type.extending) {
      return chain;
    }

    for (const baseRef of type.extending) {
      const baseName = baseRef.name.parts.join("::");
      const baseType = allTypes.get(baseName);

      if (baseType && baseType.kind === "TypeDeclaration") {
        // Add base type and its inheritance chain
        chain.push(baseType);
        chain.push(...this.resolveInheritance(baseType, allTypes));
      }
    }

    return chain;
  }

  /**
   * Merge inherited members with type's own members
   */
  mergeInheritedMembers(
    type: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration>
  ): AST.TypeMember[] {
    const inheritanceChain = this.resolveInheritance(type, allTypes);
    const members: AST.TypeMember[] = [];
    const seenNames = new Set<string>();

    // Start with own members (they override inherited ones)
    for (const member of type.members) {
      members.push(member);
      if ("name" in member && member.name) {
        const name = member.name.kind === "Identifier" ?
          member.name.value :
          member.name.parts.join("::");
        seenNames.add(name);
      }
    }

    // Add inherited members that aren't overridden
    for (const baseType of inheritanceChain) {
      for (const member of baseType.members) {
        if ("name" in member && member.name) {
          const name = member.name.kind === "Identifier" ?
            member.name.value :
            member.name.parts.join("::");
          if (!seenNames.has(name)) {
            members.push(member);
            seenNames.add(name);
          }
        } else {
          // Constraints, indexes, etc. don't have names
          members.push(member);
        }
      }
    }

    return members;
  }

  /**
   * Convert SDL type to SQL type
   */
  sdlTypeToSqlType(sdlType: string): string {
    const typeMap: Record<string, string> = {
      str: "TEXT",
      bool: "BOOLEAN",
      int16: "SMALLINT",
      int32: "INTEGER",
      int64: "BIGINT",
      float32: "REAL",
      float64: "DOUBLE PRECISION",
      decimal: "DECIMAL",
      bigint: "NUMERIC",
      json: "JSONB",
      uuid: "UUID",
      bytes: "BYTEA",
      datetime: "TIMESTAMPTZ",
      duration: "INTERVAL",
      "cal::local_datetime": "TIMESTAMP",
      "cal::local_date": "DATE",
      "cal::local_time": "TIME",
      "cal::relative_duration": "INTERVAL",
      "cal::date_duration": "INTERVAL",
      // Array types
      "array<str>": "TEXT[]",
      "array<int16>": "SMALLINT[]",
      "array<int32>": "INTEGER[]",
      "array<int64>": "BIGINT[]",
      "array<float32>": "REAL[]",
      "array<float64>": "DOUBLE PRECISION[]",
      "array<bool>": "BOOLEAN[]",
      "array<uuid>": "UUID[]",
      "array<datetime>": "TIMESTAMPTZ[]",
      "array<json>": "JSONB[]",
      "array<bytes>": "BYTEA[]",
      "array<bigint>": "NUMERIC[]",
      "array<decimal>": "NUMERIC[]",
      "array<cal::local_date>": "DATE[]",
      "array<cal::local_time>": "TIME[]",
      "array<cal::local_datetime>": "TIMESTAMP[]"
    };

    if (typeMap[sdlType]) {
      return typeMap[sdlType];
    }

    // Tuple types map to JSONB (PostgreSQL has no native tuple type).
    // Arrays of tuples (`array<tuple<...>>`) likewise map to JSONB.
    if (sdlType.startsWith("tuple<") || sdlType.startsWith("array<tuple<")) {
      return "JSONB";
    }

    return "TEXT";
  }

  /**
   * Check if a type is a built-in scalar
   */
  isBuiltinScalar(typeName: string): boolean {
    const builtins = [
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
    return builtins.includes(typeName);
  }

  /**
   * Normalize a type reference to a fully qualified name
   */
  normalizeTypeRef(
    ref: AST.TypeRef,
    currentModule: string = "default"
  ): string {
    const parts = ref.name.parts;

    // If already qualified (contains ::), use as-is
    if (parts.length > 1 || parts[0].includes("::")) {
      return parts.join("::");
    }

    // Check if it's a builtin
    if (this.isBuiltinScalar(parts[0])) {
      return parts[0];
    }

    // Otherwise, assume it's in the current module
    return currentModule === "default" ?
      parts[0] :
      `${currentModule}::${parts[0]}`;
  }
}
