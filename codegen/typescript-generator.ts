/**
 * TypeScript Type Generator
 * Generates TypeScript interfaces from EdgeQL schema
 */

import * as Context from "../compiler/context.ts";
import { getLogger } from "../lib/logger.ts";
import * as Types from "./types.ts";

const log = getLogger("codegen");

export class TypeScriptGenerator {
  private config: Types.CodegenConfig;
  private schema: Context.Schema;
  private type_mappings: Map<string, Types.TypeMapping>;

  constructor(schema: Context.Schema, config: Types.CodegenConfig) {
    this.schema = schema;
    this.config = config;
    this.type_mappings = new Map();

    // Initialize built-in type mappings
    Types.DEFAULT_TYPE_MAPPINGS.forEach(mapping => {
      this.type_mappings.set(mapping.edgeqlType, mapping);
    });
  }

  generate(): Types.CodegenResult {
    const result: Types.CodegenResult = {
      files: [],
      warnings: [],
      errors: []
    };

    try {
      // Generate type definitions (always needed for all targets)
      const typesFile = this.generateTypeDefinitions();
      result.files.push(typesFile);

      // Generate query builders
      if (this.config.includeQueryBuilders) {
        const queryFile = this.generateQueryBuilders();
        result.files.push(queryFile);
      }

      // Generate client
      if (this.config.includeClient) {
        const clientFile = this.generateClient();
        result.files.push(clientFile);
      }

      // Generate index file
      const indexFile = this.generateIndexFile();
      result.files.push(indexFile);

      log.info("TypeScript files generated", { count: result.files.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      result.errors.push(errorMessage);
    }

    return result;
  }

  /** Check if schema has multi-module types */
  private isMultiModule(): boolean {
    for (const [_name, typeDef] of this.schema.types) {
      if (typeDef.module && typeDef.module !== "default") {
        return true;
      }
    }
    // Also check: if any type has module set at all (even all default), use namespace mode
    for (const [_name, typeDef] of this.schema.types) {
      if (typeDef.module) {
        return true;
      }
    }
    return false;
  }

  /** Group schema types by their module */
  private groupTypesByModule(): Map<string, Context.TypeDef[]> {
    const groups = new Map<string, Context.TypeDef[]>();
    for (const [_name, typeDef] of this.schema.types) {
      const mod = typeDef.module || "default";
      if (!groups.has(mod)) {
        groups.set(mod, []);
      }
      groups.get(mod)!.push(typeDef);
    }
    return groups;
  }

  /** Convert module name to TypeScript namespace name */
  private getModuleNamespace(moduleName: string): string {
    return moduleName === "default" ? "$default" : moduleName;
  }

  /**
   * Resolve a type reference for cross-module use.
   * If target is in a different module from currentModule, prefix with namespace.
   * If same module, use bare name.
   */
  private resolveTypeReference(
    target: string,
    currentModule: string
  ): string {
    // Check if target contains :: (qualified name like "payment::Transaction")
    let targetModule = "default";
    let targetName = target;

    if (target.includes("::")) {
      const parts = target.split("::");
      targetModule = parts[0];
      targetName = parts[parts.length - 1];
    } else {
      // Try to find the type in the schema to determine its module
      const typeDef = this.schema.types.get(target);
      if (typeDef?.module) {
        targetModule = typeDef.module;
      }
    }

    const tsName = this.getTypeScriptTypeName(targetName);

    if (targetModule === currentModule) {
      return tsName;
    }

    return `${this.getModuleNamespace(targetModule)}.${tsName}`;
  }

  private generateTypeDefinitions(): Types.GeneratedFile {
    let content = "";

    // File header
    content += this.generateFileHeader("Type Definitions");
    content += "\n";

    if (this.isMultiModule()) {
      // Namespaced output
      const groups = this.groupTypesByModule();

      // Sort modules: default first, then alphabetical
      const sortedModules = Array.from(groups.keys()).sort((a, b) => {
        if (a === "default")
          return -1;
        if (b === "default")
          return 1;
        return a.localeCompare(b);
      });

      for (const mod of sortedModules) {
        const types = groups.get(mod)!;
        const ns = this.getModuleNamespace(mod);
        content += `export namespace ${ns} {\n`;

        for (const typeDef of types) {
          if (typeDef.kind === "enum" && typeDef.enumValues) {
            content += this.generateEnumType(typeDef, "  ", mod);
            content += "\n";
          } else if (typeDef.kind === "object") {
            content += this.generateInterface(typeDef, "  ", mod);
            content += "\n";
            // Insert/Update/FilterVars inside namespace
            const tsName = this.getTypeScriptTypeName(typeDef.name);
            content += this.generateInsertType(tsName, typeDef, "  ");
            content += "\n";
            content += this.generateUpdateType(tsName, typeDef, "  ");
            content += "\n";
            content += this.generateFilterVarsType(tsName, typeDef, "  ");
            content += "\n";
          }
        }

        content += `}\n\n`;
      }

      // Generate utility types outside namespaces
      content += this.generateUtilityTypes();
    } else {
      // Flat output (existing behavior)
      for (const [_typeName, typeDef] of this.schema.types) {
        if (typeDef.kind === "enum" && typeDef.enumValues) {
          content += this.generateEnumType(typeDef);
          content += "\n";
        } else if (typeDef.kind === "object") {
          content += this.generateInterface(typeDef);
          content += "\n";
        }
      }

      // Generate utility types
      content += this.generateUtilityTypes();
    }

    const fileName = this.isMultiModule() ? "interfaces.ts" : "types.ts";

    return {
      path: `${this.config.outputDir}/${fileName}`,
      content: this.formatContent(content),
      type: this.isMultiModule() ? "interfaces" : "types"
    };
  }

  private generateInterface(
    typeDef: Context.TypeDef,
    indent: string = "",
    currentModule?: string
  ): string {
    const interfaceName = this.getTypeScriptTypeName(typeDef.name);
    let content = "";

    // Documentation comment
    content += `${indent}/**\n`;
    if (typeDef.annotations?.["description"]) {
      content += `${indent} * ${typeDef.annotations["description"]}\n`;
      content += `${indent} *\n`;
    }
    content += `${indent} * ${typeDef.name} type from EdgeQL schema\n`;
    content += `${indent} * Table: ${typeDef.tableName}\n`;
    content += `${indent} */\n`;

    // Interface declaration (with extends for inherited types)
    if (typeDef.parentTypes && typeDef.parentTypes.length > 0) {
      const parentNames = typeDef.parentTypes.map(p => currentModule ? this.resolveTypeReference(p, currentModule) : this.getTypeScriptTypeName(p));
      content += `${indent}export interface ${interfaceName} extends ${parentNames.join(", ")} {\n`;
    } else {
      content += `${indent}export interface ${interfaceName} {\n`;
    }

    // ID field (always present)
    content += `${indent}  /** Unique identifier */\n`;
    content += `${indent}  id: string;\n`;

    // Properties
    for (const [propName, prop] of typeDef.properties) {
      content += this.generatePropertyDefinition(propName, prop, indent);
    }

    // Links (relationships)
    for (const [linkName, link] of typeDef.links) {
      content += this.generateLinkDefinition(
        linkName,
        link,
        indent,
        currentModule
      );
    }

    content += `${indent}}\n`;

    return content;
  }

  private generateEnumType(
    typeDef: Context.TypeDef,
    indent: string = "",
    _currentModule?: string
  ): string {
    const typeName = this.getTypeScriptTypeName(typeDef.name);
    let content = "";

    content += `${indent}/**\n`;
    content += `${indent} * ${typeDef.name} enum type from EdgeQL schema\n`;
    content += `${indent} */\n`;

    const values = (typeDef.enumValues ?? [])
      .map(v => `"${v}"`)
      .join(" | ");

    content += `${indent}export type ${typeName} = ${values || "never"};\n`;

    return content;
  }

  private generatePropertyDefinition(
    name: string,
    prop: Context.PropertyDef,
    indent: string = ""
  ): string {
    let content = "";

    // Use edgeqlType when available for accurate type display and mapping
    const typeForMapping = prop.edgeqlType ?? prop.type;

    // Build JSDoc tags for constraints, readonly, default, and annotations
    const jsdocTags: string[] = [];

    // Emit @description from annotations
    if (prop.annotations?.["description"]) {
      jsdocTags.push(`@description ${prop.annotations["description"]}`);
    }

    if (prop.readonly) {
      jsdocTags.push("@readonly");
    }

    if (prop.hasDefault) {
      jsdocTags.push("@default");
    }

    if (prop.constraints && prop.constraints.length > 0) {
      for (const constraint of prop.constraints) {
        if (constraint.args && constraint.args.length > 0) {
          jsdocTags.push(
            `@constraint ${constraint.name}(${constraint.args.join(", ")})`
          );
        } else {
          jsdocTags.push(`@constraint ${constraint.name}`);
        }
      }
    }

    // Generate JSDoc: multi-line when tags are present, single-line otherwise
    if (jsdocTags.length > 0) {
      content += `${indent}  /**\n`;
      content += `${indent}   * ${typeForMapping}${prop.required ? " (required)" : ""}\n`;
      for (const tag of jsdocTags) {
        content += `${indent}   * ${tag}\n`;
      }
      content += `${indent}   */\n`;
    } else {
      content += `${indent}  /** ${typeForMapping}${prop.required ? " (required)" : ""} */\n`;
    }

    // Property declaration
    const tsType = Types.mapEdgeQLTypeToTypeScript(
      typeForMapping,
      prop.required,
      prop.multi
    );
    const optional = prop.required ? "" : "?";

    content += `${indent}  ${name}${optional}: ${tsType};\n`;

    return content;
  }

  private generateLinkDefinition(
    name: string,
    link: Context.LinkDef,
    indent: string = "",
    currentModule?: string
  ): string {
    let content = "";

    // Link documentation
    const relationshipType = link.multi ? "many" : "one";
    content += `${indent}  /** Link to ${link.target} (${relationshipType}${link.required ? ", required" : ""}) */\n`;

    // Link declaration
    const targetType = currentModule ? this.resolveTypeReference(link.target, currentModule) : this.getTypeScriptTypeName(link.target);
    let tsType = targetType;

    if (link.multi) {
      tsType = `${targetType}[]`;
    }

    if (!link.required) {
      tsType += " | null";
    }

    const optional = link.required ? "" : "?";
    content += `${indent}  ${name}${optional}: ${tsType};\n`;

    return content;
  }

  private generateQueryBuilders(): Types.GeneratedFile {
    let content = "";

    // File header
    content += this.generateFileHeader("Query Builders");
    content += "\n";

    const multiModule = this.isMultiModule();

    // Import types - different source file in multi-module mode
    const typesImport = multiModule ? "./interfaces.ts" : "./types.ts";
    content += `import * as Types from "${typesImport}";\n`;
    content += `import { DiscClient } from "./client.ts";\n\n`;

    // Generate builder for each type
    for (const [_typeName, typeDef] of this.schema.types) {
      if (typeDef.kind === "object") {
        content += this.generateQueryBuilder(typeDef, multiModule);
        content += "\n";
      }
    }

    return {
      path: `${this.config.outputDir}/queries.ts`,
      content: this.formatContent(content),
      type: "queries"
    };
  }

  private generateQueryBuilder(
    typeDef: Context.TypeDef,
    multiModule: boolean = false
  ): string {
    const typeName = this.getTypeScriptTypeName(typeDef.name);
    const builderName = `${typeName}QueryBuilder`;

    // EdgeQL type name: qualified for non-default modules
    const edgeqlTypeName = (multiModule && typeDef.module && typeDef.module !== "default") ? `${typeDef.module}::${typeDef.name}` : typeDef.name;

    // TypeScript type reference: namespaced in multi-module mode
    const typeRef = multiModule ? `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}` : `Types.${typeName}`;

    // FilterVars ref
    const filterVarsRef = multiModule ? `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}FilterVars` : `Types.${typeName}FilterVars`;

    // InsertRef
    const insertRef = multiModule ? `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}Insert` : `Types.${typeName}Insert`;

    // UpdateRef
    const updateRef = multiModule ? `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}Update` : `Types.${typeName}Update`;

    // Build the type casts map from property definitions (skip "id")
    const typeCastEntries: string[] = [];
    for (const [propName, prop] of typeDef.properties) {
      if (propName === "id")
        continue;
      const edgeqlType = prop.edgeqlType ?? prop.type;
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(edgeqlType);
      typeCastEntries.push(`    ${propName}: "${cast}"`);
    }

    let content = "";

    // Builder class
    content += `/**\n`;
    content += ` * Query builder for ${typeName}\n`;
    content += ` */\n`;
    content += `export class ${builderName} {\n`;

    // Static type casts map
    content += `  private static _typeCasts: Record<string, string> = {\n`;
    content += typeCastEntries.join(",\n");
    if (typeCastEntries.length > 0)
      content += ",\n";
    content += `  };\n\n`;

    content += `  constructor(private client: DiscClient) {}\n\n`;

    // Select methods
    content += `  /** Select all ${typeName} objects */\n`;
    content += `  async select(shape?: string): Promise<${typeRef}[]> {\n`;
    content += `    const query = shape \n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape}\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * }\`;\n`;
    content += `    return await this.client.query<${typeRef}[]>(query);\n`;
    content += `  }\n\n`;

    // Select by ID
    content += `  /** Select ${typeName} by ID */\n`;
    content += `  async selectById(id: string, shape?: string): Promise<${typeRef} | null> {\n`;
    content += `    const query = shape\n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape} filter .id = <uuid>$id\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * } filter .id = <uuid>$id\`;\n`;
    content += `    const results = await this.client.query<${typeRef}[]>(query, { id });\n`;
    content += `    return results[0] || null;\n`;
    content += `  }\n\n`;

    // Filter method
    content += `  /** Filter ${typeName} objects */\n`;
    content += `  async filter(condition: string, variables?: ${filterVarsRef}, shape?: string): Promise<${typeRef}[]> {\n`;
    content += `    const query = shape\n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape} filter \${condition}\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * } filter \${condition}\`;\n`;
    content += `    return await this.client.query<${typeRef}[]>(query, variables);\n`;
    content += `  }\n\n`;

    // Insert method
    content += `  /** Insert new ${typeName} */\n`;
    content += `  async insert(data: ${insertRef}): Promise<${typeRef}> {\n`;
    content += `    const assignments = Object.entries(data)\n`;
    content += `      .map(([key, value]) => \`\${key} := \${${builderName}._typeCasts[key] || "<str>"}$\${key}\`)\n`;
    content += `      .join(', ');\n`;
    content += `    const query = \`insert ${edgeqlTypeName} { \${assignments} }\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, data);\n`;
    content += `  }\n\n`;

    // Update method
    content += `  /** Update ${typeName} by ID */\n`;
    content += `  async update(id: string, data: ${updateRef}): Promise<${typeRef}> {\n`;
    content += `    const assignments = Object.entries(data)\n`;
    content += `      .map(([key, value]) => \`\${key} := \${${builderName}._typeCasts[key] || "<str>"}$\${key}\`)\n`;
    content += `      .join(', ');\n`;
    content += `    const query = \`update ${edgeqlTypeName} filter .id = <uuid>$id set { \${assignments} }\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, { id, ...data });\n`;
    content += `  }\n\n`;

    // Delete method
    content += `  /** Delete ${typeName} by ID */\n`;
    content += `  async delete(id: string): Promise<${typeRef}> {\n`;
    content += `    const query = \`delete ${edgeqlTypeName} filter .id = <uuid>$id\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, { id });\n`;
    content += `  }\n\n`;

    // Count method
    content += `  /** Count ${typeName} objects */\n`;
    content += `  async count(condition?: string, variables?: ${filterVarsRef}): Promise<number> {\n`;
    content += `    const query = condition\n`;
    content += `      ? \`select count(${edgeqlTypeName} filter \${condition})\`\n`;
    content += `      : \`select count(${edgeqlTypeName})\`;\n`;
    content += `    return await this.client.query<number>(query, variables);\n`;
    content += `  }\n`;

    content += `}\n`;

    return content;
  }

  private generateClient(): Types.GeneratedFile {
    let content = "";

    // File header
    content += this.generateFileHeader("Disc Client");
    content += "\n";

    const multiModule = this.isMultiModule();

    // Import from SDK. The default (./sdk/mod.ts) resolves alongside the
    // generated client because `disc codegen` materializes the embedded
    // SDK into `<outputDir>/sdk/` next to `client.ts`. Downstream
    // projects can still override via config. (P1-21)
    const sdkBase = this.config.sdkImportBase ?? "./sdk/mod.ts";
    content += `import { DiscClient as BaseClient, type DiscClientConfig } from "${sdkBase}";\n`;
    content += `export type { DiscClientConfig } from "${sdkBase}";\n`;
    content += `export { AuthManager, SubscriptionClient } from "${sdkBase}";\n`;
    content += `import * as Queries from "./queries.ts";\n\n`;

    // Typed client class extending SDK client with query builders
    content += `/**\n`;
    content += ` * Type-safe Disc database client with query builders\n`;
    content += ` */\n`;
    content += `export class DiscClient extends BaseClient {\n`;

    if (multiModule) {
      // Group by module with comment headers
      const groups = this.groupTypesByModule();
      const sortedModules = Array.from(groups.keys()).sort((a, b) => {
        if (a === "default")
          return -1;
        if (b === "default")
          return 1;
        return a.localeCompare(b);
      });

      for (const mod of sortedModules) {
        const types = groups.get(mod)!;
        const objectTypes = types.filter(t => t.kind === "object");
        if (objectTypes.length === 0)
          continue;

        content += `  // ${mod} module\n`;
        for (const typeDef of objectTypes) {
          const builderName = `${this.getTypeScriptTypeName(typeDef.name)}QueryBuilder`;
          const propertyName = typeDef.name.toLowerCase();
          content += `  readonly ${propertyName}: Queries.${builderName};\n`;
        }
      }
    } else {
      // Query builder properties
      for (const [typeName, typeDef] of this.schema.types) {
        if (typeDef.kind === "object") {
          const builderName = `${this.getTypeScriptTypeName(typeName)}QueryBuilder`;
          const propertyName = typeName.toLowerCase();
          content += `  /** Query builder for ${typeName} */\n`;
          content += `  readonly ${propertyName}: Queries.${builderName};\n`;
        }
      }
    }

    content += `\n`;

    // Constructor
    content += `  constructor(config?: DiscClientConfig) {\n`;
    content += `    super(config);\n`;

    // Initialize query builders
    for (const [typeName, typeDef] of this.schema.types) {
      if (typeDef.kind !== "object")
        continue;
      const builderName = `${this.getTypeScriptTypeName(typeName)}QueryBuilder`;
      const propertyName = typeName.toLowerCase();
      content += `    this.${propertyName} = new Queries.${builderName}(this);\n`;
    }

    content += `  }\n`;
    content += `}\n`;

    return {
      path: `${this.config.outputDir}/client.ts`,
      content: this.formatContent(content),
      type: "client"
    };
  }

  private generateIndexFile(): Types.GeneratedFile {
    let content = "";

    // File header
    content += this.generateFileHeader("Generated API");
    content += "\n";

    const multiModule = this.isMultiModule();
    const typesFile = multiModule ? "./interfaces.ts" : "./types.ts";

    // Re-exports
    content += `// Type definitions\n`;
    content += `export * from "${typesFile}";\n\n`;

    content += `// Query builders\n`;
    content += `export * from "./queries.ts";\n\n`;

    content += `// Client\n`;
    content += `export * from "./client.ts";\n\n`;

    // SDK re-exports
    content += `// SDK re-exports\n`;
    content += `export { AuthManager, SubscriptionClient } from "./client.ts";\n\n`;

    // Default export
    content += `// Default client export\n`;
    content += `import { DiscClient } from "./client.ts";\n`;
    content += `export default DiscClient;\n`;

    return {
      path: `${this.config.outputDir}/index.ts`,
      content: this.formatContent(content),
      type: "index"
    };
  }

  private generateUtilityTypes(): string {
    let content = "";

    content += `/**\n`;
    content += ` * Utility types for EdgeQL operations\n`;
    content += ` */\n\n`;

    content += `/** Query result wrapper */\n`;
    content += `export interface QueryResult<T> {\n`;
    content += `  data: T;\n`;
    content += `  extensions?: {\n`;
    content += `    durationMs?: number;\n`;
    content += `    queryHash?: string;\n`;
    content += `    sql?: string;\n`;
    content += `  };\n`;
    content += `}\n\n`;

    content += `/** Query error */\n`;
    content += `export interface QueryError {\n`;
    content += `  message: string;\n`;
    content += `  locations?: Array<{ line: number; column: number }>;\n`;
    content += `  path?: Array<string | number>;\n`;
    content += `  extensions?: Record<string, any>;\n`;
    content += `}\n\n`;

    // Only generate Insert/Update/FilterVars in utility section for flat (non-module) output
    if (!this.isMultiModule()) {
      content += `/** Insert/Update/FilterVars data types */\n`;
      for (const [typeName, typeDef] of this.schema.types) {
        // Skip enum types — they don't have insert/update/filter types
        if (typeDef.kind === "enum") {
          continue;
        }

        const tsTypeName = this.getTypeScriptTypeName(typeName);

        // Generate Insert interface with smart rules
        content += this.generateInsertType(tsTypeName, typeDef);
        content += "\n";

        // Generate Update interface with smart rules
        content += this.generateUpdateType(tsTypeName, typeDef);
        content += "\n";

        // Generate FilterVars interface for typed filter/count parameters
        content += this.generateFilterVarsType(tsTypeName, typeDef);
        content += "\n";
      }
    }

    return content;
  }

  private generateInsertType(
    tsTypeName: string,
    typeDef: Context.TypeDef,
    indent: string = ""
  ): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}Insert {\n`;

    for (const [propName, prop] of typeDef.properties) {
      // Exclude id (auto-generated UUID)
      if (propName === "id")
        continue;

      // Exclude computed properties
      if (prop.computed)
        continue;

      // Exclude readonly properties that have a default (e.g., created_at)
      if (prop.readonly && prop.hasDefault)
        continue;

      const typeForMapping = prop.edgeqlType ?? prop.type;
      const tsType = Types.mapEdgeQLTypeToTypeScript(
        typeForMapping,
        true, // always use non-nullable base type
        prop.multi
      );

      // Properties with defaults are optional in insert even if required in schema
      const isOptional = !prop.required || prop.hasDefault;
      const optional = isOptional ? "?" : "";

      content += `${indent}  ${propName}${optional}: ${tsType};\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  private generateUpdateType(
    tsTypeName: string,
    typeDef: Context.TypeDef,
    indent: string = ""
  ): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}Update {\n`;

    for (const [propName, prop] of typeDef.properties) {
      // Exclude id
      if (propName === "id")
        continue;

      // Exclude computed properties
      if (prop.computed)
        continue;

      // Exclude readonly properties
      if (prop.readonly)
        continue;

      const typeForMapping = prop.edgeqlType ?? prop.type;
      const tsType = Types.mapEdgeQLTypeToTypeScript(
        typeForMapping,
        true, // always use non-nullable base type
        prop.multi
      );

      // Everything in update is optional
      content += `${indent}  ${propName}?: ${tsType};\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  private generateFilterVarsType(
    tsTypeName: string,
    typeDef: Context.TypeDef,
    indent: string = ""
  ): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}FilterVars {\n`;

    for (const [propName, prop] of typeDef.properties) {
      const typeForMapping = prop.edgeqlType ?? prop.type;
      const tsType = Types.mapEdgeQLTypeToTypeScript(
        typeForMapping,
        true, // always use non-nullable base type
        prop.multi
      );

      content += `${indent}  ${propName}?: ${tsType};\n`;
    }

    // Index signature for flexibility
    content += `${indent}  [key: string]: unknown;\n`;
    content += `${indent}}\n`;
    return content;
  }

  private generateFileHeader(description: string): string {
    const timestamp = new Date().toISOString();
    return `/**\n` +
      ` * ${description}\n` +
      ` * Generated by Disc TypeScript Codegen\n` +
      ` * Generated at: ${timestamp}\n` +
      ` * \n` +
      ` * DO NOT EDIT THIS FILE MANUALLY\n` +
      ` */\n`;
  }

  private getTypeScriptTypeName(edgeqlTypeName: string): string {
    const prefix = this.config.typePrefix || "";
    const suffix = this.config.interfaceSuffix || "";
    return `${prefix}${edgeqlTypeName}${suffix}`;
  }

  private formatContent(content: string): string {
    if (!this.config.formatOutput) {
      return content;
    }

    // Simple formatting - in production, you'd use a proper formatter like Prettier
    return content
      .replace(/\n\n\n+/g, "\n\n") // Remove excessive newlines
      .trim() + "\n"; // Ensure single trailing newline
  }
}
