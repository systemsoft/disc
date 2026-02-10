/**
 * TypeScript Type Generator
 * Generates TypeScript interfaces from EdgeQL schema
 */

import * as Context from "../compiler/context.ts";
import * as Types from "./types.ts";

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
      this.type_mappings.set(mapping.edgeql_type, mapping);
    });
  }

  generate(): Types.CodegenResult {
    const result: Types.CodegenResult = {
      files: [],
      warnings: [],
      errors: [],
    };

    try {
      // Generate type definitions
      if (this.config.target === "client" || this.config.target === "both") {
        const typesFile = this.generateTypeDefinitions();
        result.files.push(typesFile);
      }

      // Generate query builders
      if (this.config.include_query_builders) {
        const queryFile = this.generateQueryBuilders();
        result.files.push(queryFile);
      }

      // Generate client
      if (this.config.include_client) {
        const clientFile = this.generateClient();
        result.files.push(clientFile);
      }

      // Generate index file
      const indexFile = this.generateIndexFile();
      result.files.push(indexFile);

      console.log(`✅ Generated ${result.files.length} TypeScript files`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      result.errors.push(errorMessage);
    }

    return result;
  }

  private generateTypeDefinitions(): Types.GeneratedFile {
    let content = "";
    
    // File header
    content += this.generateFileHeader("Type Definitions");
    content += "\n";

    // Generate interfaces for each type
    for (const [typeName, typeDef] of this.schema.types) {
      if (typeDef.kind === "object") {
        content += this.generateInterface(typeDef);
        content += "\n";
      }
    }

    // Generate utility types
    content += this.generateUtilityTypes();

    return {
      path: `${this.config.output_dir}/types.ts`,
      content: this.formatContent(content),
      type: "types",
    };
  }

  private generateInterface(typeDef: Context.TypeDef): string {
    const interfaceName = this.getTypeScriptTypeName(typeDef.name);
    let content = "";

    // Documentation comment
    content += `/**\n`;
    content += ` * ${typeDef.name} type from EdgeQL schema\n`;
    content += ` * Table: ${typeDef.tableName}\n`;
    content += ` */\n`;

    // Interface declaration
    content += `export interface ${interfaceName} {\n`;

    // ID field (always present)
    content += `  /** Unique identifier */\n`;
    content += `  id: string;\n`;

    // Properties
    for (const [propName, prop] of typeDef.properties) {
      content += this.generatePropertyDefinition(propName, prop);
    }

    // Links (relationships)
    for (const [linkName, link] of typeDef.links) {
      content += this.generateLinkDefinition(linkName, link);
    }

    content += `}\n`;

    return content;
  }

  private generatePropertyDefinition(name: string, prop: Context.PropertyDef): string {
    let content = "";
    
    // Property documentation
    content += `  /** ${prop.type}${prop.required ? " (required)" : ""} */\n`;
    
    // Property declaration
    const tsType = Types.mapEdgeQLTypeToTypeScript(prop.type, prop.required, prop.multi);
    const optional = prop.required ? "" : "?";
    
    content += `  ${name}${optional}: ${tsType};\n`;
    
    return content;
  }

  private generateLinkDefinition(name: string, link: Context.LinkDef): string {
    let content = "";
    
    // Link documentation  
    const relationshipType = link.multi ? "many" : "one";
    content += `  /** Link to ${link.target} (${relationshipType}${link.required ? ", required" : ""}) */\n`;
    
    // Link declaration
    const targetType = this.getTypeScriptTypeName(link.target);
    let tsType = targetType;
    
    if (link.multi) {
      tsType = `${targetType}[]`;
    }
    
    if (!link.required) {
      tsType += " | null";
    }
    
    const optional = link.required ? "" : "?";
    content += `  ${name}${optional}: ${tsType};\n`;
    
    return content;
  }

  private generateQueryBuilders(): Types.GeneratedFile {
    let content = "";
    
    // File header
    content += this.generateFileHeader("Query Builders");
    content += "\n";

    // Import types
    content += `import * as Types from "./types.ts";\n`;
    content += `import { DiscClient } from "./client.ts";\n\n`;

    // Generate builder for each type
    for (const [typeName, typeDef] of this.schema.types) {
      if (typeDef.kind === "object") {
        content += this.generateQueryBuilder(typeDef);
        content += "\n";
      }
    }

    return {
      path: `${this.config.output_dir}/queries.ts`,
      content: this.formatContent(content),
      type: "queries",
    };
  }

  private generateQueryBuilder(typeDef: Context.TypeDef): string {
    const typeName = this.getTypeScriptTypeName(typeDef.name);
    const builderName = `${typeName}QueryBuilder`;
    
    let content = "";

    // Builder class
    content += `/**\n`;
    content += ` * Query builder for ${typeName}\n`;
    content += ` */\n`;
    content += `export class ${builderName} {\n`;
    content += `  constructor(private client: DiscClient) {}\n\n`;

    // Select methods
    content += `  /** Select all ${typeName} objects */\n`;
    content += `  async select(shape?: string): Promise<Types.${typeName}[]> {\n`;
    content += `    const query = shape \n`;
    content += `      ? \`select ${typeDef.name} \${shape}\`\n`;
    content += `      : \`select ${typeDef.name} { * }\`;\n`;
    content += `    return await this.client.query<Types.${typeName}[]>(query);\n`;
    content += `  }\n\n`;

    // Select by ID
    content += `  /** Select ${typeName} by ID */\n`;
    content += `  async selectById(id: string, shape?: string): Promise<Types.${typeName} | null> {\n`;
    content += `    const query = shape\n`;
    content += `      ? \`select ${typeDef.name} \${shape} filter .id = <uuid>$id\`\n`;
    content += `      : \`select ${typeDef.name} { * } filter .id = <uuid>$id\`;\n`;
    content += `    const results = await this.client.query<Types.${typeName}[]>(query, { id });\n`;
    content += `    return results[0] || null;\n`;
    content += `  }\n\n`;

    // Filter method
    content += `  /** Filter ${typeName} objects */\n`;
    content += `  async filter(condition: string, variables?: Record<string, any>, shape?: string): Promise<Types.${typeName}[]> {\n`;
    content += `    const query = shape\n`;
    content += `      ? \`select ${typeDef.name} \${shape} filter \${condition}\`\n`;
    content += `      : \`select ${typeDef.name} { * } filter \${condition}\`;\n`;
    content += `    return await this.client.query<Types.${typeName}[]>(query, variables);\n`;
    content += `  }\n\n`;

    // Insert method
    content += `  /** Insert new ${typeName} */\n`;
    content += `  async insert(data: Partial<Omit<Types.${typeName}, 'id'>>): Promise<Types.${typeName}> {\n`;
    content += `    const assignments = Object.entries(data)\n`;
    content += `      .map(([key, value]) => \`\${key} := <str>$\${key}\`)\n`;
    content += `      .join(', ');\n`;
    content += `    const query = \`insert ${typeDef.name} { \${assignments} }\`;\n`;
    content += `    return await this.client.query<Types.${typeName}>(query, data);\n`;
    content += `  }\n\n`;

    // Update method  
    content += `  /** Update ${typeName} by ID */\n`;
    content += `  async update(id: string, data: Partial<Omit<Types.${typeName}, 'id'>>): Promise<Types.${typeName}> {\n`;
    content += `    const assignments = Object.entries(data)\n`;
    content += `      .map(([key, value]) => \`\${key} := <str>$\${key}\`)\n`;
    content += `      .join(', ');\n`;
    content += `    const query = \`update ${typeDef.name} filter .id = <uuid>$id set { \${assignments} }\`;\n`;
    content += `    return await this.client.query<Types.${typeName}>(query, { id, ...data });\n`;
    content += `  }\n\n`;

    // Delete method
    content += `  /** Delete ${typeName} by ID */\n`;
    content += `  async delete(id: string): Promise<Types.${typeName}> {\n`;
    content += `    const query = \`delete ${typeDef.name} filter .id = <uuid>$id\`;\n`;
    content += `    return await this.client.query<Types.${typeName}>(query, { id });\n`;
    content += `  }\n\n`;

    // Count method
    content += `  /** Count ${typeName} objects */\n`;
    content += `  async count(condition?: string, variables?: Record<string, any>): Promise<number> {\n`;
    content += `    const query = condition\n`;
    content += `      ? \`select count(${typeDef.name} filter \${condition})\`\n`;
    content += `      : \`select count(${typeDef.name})\`;\n`;
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

    // Imports
    content += `import * as Types from "./types.ts";\n`;
    content += `import * as Queries from "./queries.ts";\n\n`;

    // Client configuration interface
    content += `export interface DiscClientConfig {\n`;
    content += `  host?: string;\n`;
    content += `  port?: number;\n`;
    content += `  protocol?: "http" | "https";\n`;
    content += `  timeout?: number;\n`;
    content += `  headers?: Record<string, string>;\n`;
    content += `}\n\n`;

    // Main client class
    content += `/**\n`;
    content += ` * Type-safe Disc database client\n`;
    content += ` */\n`;
    content += `export class DiscClient {\n`;
    content += `  private baseUrl: string;\n`;
    content += `  private timeout: number;\n`;
    content += `  private headers: Record<string, string>;\n\n`;

    // Query builders
    for (const [typeName, typeDef] of this.schema.types) {
      if (typeDef.kind === "object") {
        const builderName = `${this.getTypeScriptTypeName(typeName)}QueryBuilder`;
        const propertyName = typeName.toLowerCase();
        content += `  /** Query builder for ${typeName} */\n`;
        content += `  readonly ${propertyName}: Queries.${builderName};\n`;
      }
    }

    content += `\n`;

    // Constructor
    content += `  constructor(config: DiscClientConfig = {}) {\n`;
    content += `    const host = config.host || "localhost";\n`;
    content += `    const port = config.port || 5656;\n`;
    content += `    const protocol = config.protocol || "http";\n`;
    content += `    this.baseUrl = \`\${protocol}://\${host}:\${port}\`;\n`;
    content += `    this.timeout = config.timeout || 30000;\n`;
    content += `    this.headers = {\n`;
    content += `      "Content-Type": "application/json",\n`;
    content += `      ...config.headers,\n`;
    content += `    };\n\n`;

    // Initialize query builders
    for (const [typeName] of this.schema.types) {
      const builderName = `${this.getTypeScriptTypeName(typeName)}QueryBuilder`;
      const propertyName = typeName.toLowerCase();
      content += `    this.${propertyName} = new Queries.${builderName}(this);\n`;
    }

    content += `  }\n\n`;

    // Raw query method
    content += `  /** Execute raw EdgeQL query */\n`;
    content += `  async query<T = any>(query: string, variables?: Record<string, any>): Promise<T> {\n`;
    content += `    const response = await fetch(\`\${this.baseUrl}/query\`, {\n`;
    content += `      method: "POST",\n`;
    content += `      headers: this.headers,\n`;
    content += `      body: JSON.stringify({ query, variables }),\n`;
    content += `      signal: AbortSignal.timeout(this.timeout),\n`;
    content += `    });\n\n`;
    content += `    if (!response.ok) {\n`;
    content += `      throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);\n`;
    content += `    }\n\n`;
    content += `    const result = await response.json();\n\n`;
    content += `    if (result.errors && result.errors.length > 0) {\n`;
    content += `      throw new Error(\`EdgeQL Error: \${result.errors[0].message}\`);\n`;
    content += `    }\n\n`;
    content += `    return result.data;\n`;
    content += `  }\n\n`;

    // Transaction support
    content += `  /** Execute queries in transaction */\n`;
    content += `  async transaction<T>(queries: (client: DiscClient) => Promise<T>): Promise<T> {\n`;
    content += `    // TODO: Implement transaction support\n`;
    content += `    // For now, just execute the queries directly\n`;
    content += `    return await queries(this);\n`;
    content += `  }\n\n`;

    // Health check
    content += `  /** Check server health */\n`;
    content += `  async health(): Promise<{ status: string; uptime_ms: number }> {\n`;
    content += `    const response = await fetch(\`\${this.baseUrl}/health\`);\n`;
    content += `    return await response.json();\n`;
    content += `  }\n\n`;

    // Server stats
    content += `  /** Get server statistics */\n`;
    content += `  async stats(): Promise<Record<string, any>> {\n`;
    content += `    const response = await fetch(\`\${this.baseUrl}/stats\`);\n`;
    content += `    return await response.json();\n`;
    content += `  }\n`;

    content += `}\n`;

    return {
      path: `${this.config.output_dir}/client.ts`,
      content: this.formatContent(content),
      type: "client",
    };
  }

  private generateIndexFile(): Types.GeneratedFile {
    let content = "";
    
    // File header
    content += this.generateFileHeader("Generated API");
    content += "\n";

    // Re-exports
    content += `// Type definitions\n`;
    content += `export * from "./types.ts";\n\n`;
    
    content += `// Query builders\n`;
    content += `export * from "./queries.ts";\n\n`;
    
    content += `// Client\n`;
    content += `export * from "./client.ts";\n\n`;

    // Default export
    content += `// Default client export\n`;
    content += `import { DiscClient } from "./client.ts";\n`;
    content += `export default DiscClient;\n`;

    return {
      path: `${this.config.output_dir}/index.ts`,
      content: this.formatContent(content),
      type: "index",
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
    content += `    duration_ms?: number;\n`;
    content += `    query_hash?: string;\n`;
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

    content += `/** Insert/Update data types */\n`;
    for (const [typeName] of this.schema.types) {
      const tsTypeName = this.getTypeScriptTypeName(typeName);
      content += `export type ${tsTypeName}Insert = Omit<${tsTypeName}, 'id'>;\n`;
      content += `export type ${tsTypeName}Update = Partial<${tsTypeName}Insert>;\n`;
    }

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
    const prefix = this.config.type_prefix || "";
    const suffix = this.config.interface_suffix || "";
    return `${prefix}${edgeqlTypeName}${suffix}`;
  }

  private formatContent(content: string): string {
    if (!this.config.format_output) {
      return content;
    }

    // Simple formatting - in production, you'd use a proper formatter like Prettier
    return content
      .replace(/\n\n\n+/g, "\n\n") // Remove excessive newlines
      .trim() + "\n"; // Ensure single trailing newline
  }
}