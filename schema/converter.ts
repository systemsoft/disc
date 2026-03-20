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
          items: declaration.declarations,
        });
      } else {
        // Collect items for default module
        defaultModuleItems.push(declaration);
      }
    }

    // If there are items not in a module, add them to default module
    if (defaultModuleItems.length > 0) {
      // Check if default module already exists
      const defaultModule = modules.find((m) => m.name === "default");
      if (defaultModule) {
        // Add items to existing default module
        defaultModule.items.push(...defaultModuleItems);
      } else {
        // Create new default module
        modules.unshift({
          name: "default",
          items: defaultModuleItems,
        });
      }
    }

    // If no modules at all, create empty default module
    if (modules.length === 0) {
      modules.push({
        name: "default",
        items: [],
      });
    }

    return modules;
  }

  /**
   * Extract type definitions from modules
   */
  extractTypes(
    modules: Module[],
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
      (member): member is AST.PropertyDeclaration =>
        member.kind === "PropertyDeclaration",
    );
  }

  /**
   * Extract links from a type declaration
   */
  extractLinks(type: AST.TypeDeclaration): AST.LinkDeclaration[] {
    return type.members.filter(
      (member): member is AST.LinkDeclaration =>
        member.kind === "LinkDeclaration",
    );
  }

  /**
   * Extract constraints from a type declaration
   */
  extractConstraints(type: AST.TypeDeclaration): AST.Constraint[] {
    return type.members.filter(
      (member): member is AST.Constraint => member.kind === "Constraint",
    );
  }

  /**
   * Extract indexes from a type declaration
   */
  extractIndexes(type: AST.TypeDeclaration): AST.Index[] {
    return type.members.filter(
      (member): member is AST.Index => member.kind === "Index",
    );
  }

  /**
   * Extract access policies from a type declaration
   */
  extractAccessPolicies(type: AST.TypeDeclaration): AST.AccessPolicy[] {
    return type.members.filter(
      (member): member is AST.AccessPolicy => member.kind === "AccessPolicy",
    );
  }

  /**
   * Resolve type inheritance chain
   */
  resolveInheritance(
    type: AST.TypeDeclaration,
    allTypes: Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration>,
  ): AST.TypeDeclaration[] {
    const chain: AST.TypeDeclaration[] = [];

    if (!type.extending) return chain;

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
    allTypes: Map<string, AST.TypeDeclaration | AST.ScalarTypeDeclaration>,
  ): AST.TypeMember[] {
    const inheritanceChain = this.resolveInheritance(type, allTypes);
    const members: AST.TypeMember[] = [];
    const seenNames = new Set<string>();

    // Start with own members (they override inherited ones)
    for (const member of type.members) {
      members.push(member);
      if ("name" in member && member.name) {
        const name = member.name.kind === "Identifier"
          ? member.name.value
          : member.name.parts.join("::");
        seenNames.add(name);
      }
    }

    // Add inherited members that aren't overridden
    for (const baseType of inheritanceChain) {
      for (const member of baseType.members) {
        if ("name" in member && member.name) {
          const name = member.name.kind === "Identifier"
            ? member.name.value
            : member.name.parts.join("::");
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
      "str": "TEXT",
      "bool": "BOOLEAN",
      "int16": "SMALLINT",
      "int32": "INTEGER",
      "int64": "BIGINT",
      "float32": "REAL",
      "float64": "DOUBLE PRECISION",
      "decimal": "DECIMAL",
      "bigint": "NUMERIC",
      "json": "JSONB",
      "uuid": "UUID",
      "bytes": "BYTEA",
      "datetime": "TIMESTAMPTZ",
      "duration": "INTERVAL",
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
      "array<cal::local_datetime>": "TIMESTAMP[]",
    };

    if (typeMap[sdlType]) {
      return typeMap[sdlType];
    }

    // Tuple types map to JSONB (PostgreSQL has no native tuple type)
    if (sdlType.startsWith("tuple<")) {
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
      "cal::date_duration",
    ];
    return builtins.includes(typeName);
  }

  /**
   * Normalize a type reference to a fully qualified name
   */
  normalizeTypeRef(
    ref: AST.TypeRef,
    currentModule: string = "default",
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
    return currentModule === "default"
      ? parts[0]
      : `${currentModule}::${parts[0]}`;
  }
}
