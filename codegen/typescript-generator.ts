/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * TypeScript Type Generator
 * Generates TypeScript interfaces from EdgeQL schema
 */

/*** IMPORT ------------------------------------------- ***/

import { default as dedent } from "@netopwibby/dedent";

/*** UTILITY ------------------------------------------ ***/

import * as Context from "../compiler/context.ts";
import * as Types from "./types.ts";
import { getLogger } from "../lib/logger.ts";
import { inferComputedTupleFields } from "./computed-tuple-inference.ts";

const log = getLogger("codegen");

/*** EXPORT ------------------------------------------- ***/

export class TypeScriptGenerator {
  private config: Types.CodegenConfig;
  private schema: Context.Schema;
  private type_mappings: Map<string, Types.TypeMapping>;

  constructor(schema: Context.Schema, config: Types.CodegenConfig) {
    this.schema = schema;
    this.config = config;
    this.type_mappings = new Map();

    /*** Initialize built-in type mappings ***/
    Types.DEFAULT_TYPE_MAPPINGS.forEach(mapping => {
      this.type_mappings.set(mapping.edgeqlType, mapping);
    });
  }

  generate(): Types.CodegenResult {
    const result: Types.CodegenResult = {
      errors: [],
      files: [],
      warnings: []
    };

    try {
      /*** Generate type definitions (always needed for all targets) ***/
      const typesFile = this.generateTypeDefinitions();
      result.files.push(typesFile);

      /*** Generate query builders ***/
      if (this.config.includeQueryBuilders) {
        const queryFile = this.generateQueryBuilders();
        result.files.push(queryFile);
      }

      /*** Generate client ***/
      if (this.config.includeClient) {
        const clientFile = this.generateClient();
        result.files.push(clientFile);
      }

      /*** Generate index file ***/
      const indexFile = this.generateIndexFile();
      result.files.push(indexFile);

      log.info("TypeScript files generated", { count: result.files.length });
    } catch (error) {
      const errorMessage = error instanceof Error ?
        error.message :
        "Unknown error";
      result.errors.push(errorMessage);
    }

    return result;
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Strip a module qualifier from a link target (e.g. "default::Tag" → "Tag").
   * Multi-link junction-write subqueries and doc comments reference the bare
   * target type name.
   */
  private bareTargetName(target: string): string {
    return target.includes("::") ? target.split("::").pop()! : target;
  }

  private formatContent(content: string): string {
    if (!this.config.formatOutput)
      return content;

    /*** Simple formatting - in production, you’d use a proper formatter like Prettier ***/
    return content
      .replace(/\n\n\n+/g, "\n\n") /*** Remove excessive newlines ***/
      .trim() + "\n"; /*** Ensure single trailing newline ***/
  }

  private generateClient(): Types.GeneratedFile {
    let content = "";

    /*** File header ***/
    content += this.generateFileHeader("Disc Client");
    content += "\n";

    const multiModule = this.isMultiModule();

    /*** Import from SDK. The default (./sdk/mod.ts) resolves alongside the generated client because
         `disc codegen` materializes the embedded SDK into `<outputDir>/sdk/` next to `client.ts`.
         Downstream projects can still override via config. ***/
    const sdkBase = this.config.sdkImportBase ?? "./sdk/mod.ts";
    content += `import { DiscClient as BaseClient, type DiscClientConfig } from "${sdkBase}";\n`;
    content += `export type { DiscClientConfig } from "${sdkBase}";\n`;
    /*** Re-export combinators so callers can `import { and, or, not } from "./client.ts"` alongside
         the generated DiscClient — one import path for the whole filter API. ***/
    content += `export { and, AuthManager, not, or, SubscriptionClient } from "${sdkBase}";\n`;
    content += `import * as Queries from "./queries.ts";\n\n`;

    /*** Typed client class extending SDK client with query builders ***/
    content += `/**\n`;
    content += ` * Type-safe Disc database client with query builders\n`;
    content += ` */\n`;
    content += `export class DiscClient extends BaseClient {\n`;

    if (multiModule) {
      /*** Group by module with comment headers ***/
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
      /*** Query builder properties ***/
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

    /*** Constructor ***/
    content += `  constructor(config?: DiscClientConfig) {\n`;
    content += `    super(config);\n`;

    /*** Initialize query builders. Use typeDef.name (always bare) rather than the schema map key —
         non-default modules are keyed as "module::Type", and that "::" would land verbatim in the
         emitted property and class identifiers, breaking parse. Matches the property
         declaration above. ***/
    for (const [_typeName, typeDef] of this.schema.types) {
      if (typeDef.kind !== "object")
        continue;

      const builderName = `${this.getTypeScriptTypeName(typeDef.name)}QueryBuilder`;
      const propertyName = typeDef.name.toLowerCase();
      content += `    this.${propertyName} = new Queries.${builderName}(this);\n`;
    }

    content += `  }\n`;
    content += `}\n`;

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/client.ts`,
      type: "client"
    };
  }

  private generateEnumType(typeDef: Context.TypeDef, indent: string = "", _currentModule?: string): string {
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

  private generateFileHeader(description: string): string {
    const timestamp = new Date().toISOString();

    return dedent`
      /**
        * ${description}
        * Generated by Disc TypeScript Codegen
        * Generated at: ${timestamp}
        *
        * DO NOT EDIT THIS FILE MANUALLY
        */
    `;
  }

  /**
   * Per-type Filter interface. Scalar fields accept either a bare value
   * (equality sugar) or the matching operator helper; links recurse into
   * the target type’s Filter; reserved keys (`select`, `order_by`, `limit`,
   * `offset`) shape the query result.
   */
  private generateFilterType(typeDef: Context.TypeDef, indent: string = "", currentModule?: string): string {
    const tsTypeName = this.getTypeScriptTypeName(typeDef.name);
    let content = "";
    content += `${indent}export interface ${tsTypeName}Filter {\n`;

    for (const [propName, prop] of typeDef.properties) {
      // Computed named-tuple property (e.g. `counts := (videos := count(...))`):
      // emit a typed nested filter `counts?: { videos?: number | Op<…> }`.
      // Computed props we can't infer are omitted (rather than emitting a
      // broken `unknown | Op<unknown>` field).
      if (prop.computed) {
        const fields = prop.computedExpr ?
          inferComputedTupleFields(prop.computedExpr) :
          null;
        if (!fields) {
          continue;
        }
        const inner = Object
          .entries(fields)
          .map(([field, edgeqlType]) => {
            const ts = Types.mapEdgeQLTypeToTypeScript(edgeqlType, true, false);
            const op = this.getOperatorHelperFor(edgeqlType, ts);
            return `${field}?: ${ts} | ${op}`;
          })
          .join("; ");
        content += `${indent}  ${propName}?: { ${inner} };\n`;
        continue;
      }

      const typeForMapping = prop.edgeqlType ?? prop.type;
      const tsType = Types.mapEdgeQLTypeToTypeScript(typeForMapping, true, prop.multi);
      const opHelper = this.getOperatorHelperFor(typeForMapping, tsType);
      content += `${indent}  ${propName}?: ${tsType} | ${opHelper};\n`;
    }

    for (const [linkName, link] of typeDef.links) {
      const targetTs = currentModule ?
        this.resolveTypeReference(link.target, currentModule) :
        this.getTypeScriptTypeName(link.target);

      content += `${indent}  ${linkName}?: ${targetTs}Filter;\n`;
    }

    content += `${indent}  select?: ${tsTypeName}Select;\n`;
    content += `${indent}  order_by?: string | string[];\n`;
    content += `${indent}  limit?: number;\n`;
    content += `${indent}  offset?: number;\n`;
    content += `${indent}}\n`;

    return content;
  }

  private generateFilterVarsType(tsTypeName: string, typeDef: Context.TypeDef, indent: string = ""): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}FilterVars {\n`;

    for (const [propName, prop] of typeDef.properties) {
      const typeForMapping = prop.edgeqlType ?? prop.type;

      const tsType = Types.mapEdgeQLTypeToTypeScript(
        typeForMapping,
        true, /*** always use non-nullable base type ***/
        prop.multi
      );

      content += `${indent}  ${propName}?: ${tsType};\n`;
    }

    /*** Index signature for flexibility ***/
    content += `${indent}  [key: string]: unknown;\n`;
    content += `${indent}}\n`;

    return content;
  }

  private generateIndexFile(): Types.GeneratedFile {
    let content = "";

    /*** File header ***/
    content += this.generateFileHeader("Generated API");
    content += "\n";

    const multiModule = this.isMultiModule();
    const typesFile = multiModule ? "./interfaces.ts" : "./types.ts";

    /*** Re-exports ***/
    content += `// Type definitions\n`;
    content += `export * from "${typesFile}";\n\n`;

    content += `// Query builders\n`;
    content += `export * from "./queries.ts";\n\n`;

    content += `// Client\n`;
    content += `export * from "./client.ts";\n\n`;

    /*** SDK re-exports ***/
    content += `// SDK re-exports\n`;
    content += `export { and, AuthManager, not, or, SubscriptionClient } from "./client.ts";\n\n`;

    /*** Default export ***/
    content += `// Default client export\n`;
    content += `import { DiscClient } from "./client.ts";\n`;
    content += `export default DiscClient;\n`;

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/index.ts`,
      type: "index"
    };
  }

  private generateInsertType(tsTypeName: string, typeDef: Context.TypeDef, indent: string = ""): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}Insert {\n`;

    for (const [propName, prop] of typeDef.properties) {
      /*** Exclude id (auto-generated UUID) ***/
      if (propName === "id")
        continue;

      /*** Exclude computed properties ***/
      if (prop.computed)
        continue;

      /*** Exclude readonly properties that have a default (e.g., created_at) ***/
      if (prop.readonly && prop.hasDefault)
        continue;

      const typeForMapping = prop.edgeqlType ?? prop.type;

      const tsType = Types.mapEdgeQLTypeToTypeScript(
        typeForMapping,
        true, /*** always use non-nullable base type ***/
        prop.multi
      );

      /*** Properties with defaults are optional in insert even if required in schema ***/
      const isOptional = !prop.required || prop.hasDefault;
      const optional = isOptional ? "?" : "";

      content += `${indent}  ${propName}${optional}: ${tsType};\n`;
    }

    /*** Links. Single links are settable by target UUID — insert() casts them as <uuid> and the
         compiler maps the link onto its FK column. Multi links assign the full set by target UUID
         array — insert() turns that into a junction-write subquery. Computed links aren't stored,
         so they're excluded either way. ***/
    for (const [linkName, link] of typeDef.links) {
      if (link.computed)
        continue;

      const optional = link.required ? "" : "?";

      if (link.multi) {
        content += `${indent}  /** UUIDs of linked ${this.bareTargetName(link.target)} (assigns the full set) */\n`;
        content += `${indent}  ${linkName}${optional}: string[];\n`;
        continue;
      }

      content += `${indent}  /** UUID of the linked ${link.target} */\n`;
      content += `${indent}  ${linkName}${optional}: string;\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  private generateInterface(typeDef: Context.TypeDef, indent: string = "", currentModule?: string): string {
    const interfaceName = this.getTypeScriptTypeName(typeDef.name);
    let content = "";

    /*** Documentation comment ***/
    content += `${indent}/**\n`;

    if (typeDef.annotations?.["description"]) {
      content += `${indent} * ${typeDef.annotations["description"]}\n`;
      content += `${indent} *\n`;
    }

    content += `${indent} * ${typeDef.name} type from EdgeQL schema\n`;
    content += `${indent} * Table: ${typeDef.tableName}\n`;
    content += `${indent} */\n`;

    /*** Interface declaration (with extends for inherited types) ***/
    if (typeDef.parentTypes && typeDef.parentTypes.length > 0) {
      const parentNames = typeDef.parentTypes.map(p =>
        currentModule ?
          this.resolveTypeReference(p, currentModule) :
          this.getTypeScriptTypeName(p)
      );

      content += `${indent}export interface ${interfaceName} extends ${parentNames.join(", ")} {\n`;
    } else {
      content += `${indent}export interface ${interfaceName} {\n`;
    }

    /*** ID field (always present). Schema-manager seeds every type with an implicit `id` property;
         skip it in the iteration below to avoid the duplicate `id: string;` declaration TS
         would reject. ***/
    content += `${indent}  /** Unique identifier */\n`;
    content += `${indent}  id: string;\n`;

    /*** Properties ***/
    for (const [propName, prop] of typeDef.properties) {
      if (propName === "id")
        continue;

      content += this.generatePropertyDefinition(propName, prop, indent);
    }

    /*** Links (relationships) ***/
    for (const [linkName, link] of typeDef.links) {
      content += this.generateLinkDefinition(linkName, link, indent, currentModule);
    }

    content += `${indent}}\n`;
    return content;
  }

  private generateLinkDefinition(name: string, link: Context.LinkDef, indent: string = "", currentModule?: string): string {
    let content = "";

    /*** Link documentation ***/
    const relationshipType = link.multi ? "many" : "one";
    content += `${indent}  /** Link to ${link.target} (${relationshipType}${link.required ? ", required" : ""}) */\n`;

    /*** Link declaration ***/
    const targetType = currentModule ?
      this.resolveTypeReference(link.target, currentModule) :
      this.getTypeScriptTypeName(link.target);

    let tsType = targetType;

    if (link.multi)
      tsType = `${targetType}[]`;

    if (!link.required)
      tsType += " | null";

    const optional = link.required ? "" : "?";
    content += `${indent}  ${name}${optional}: ${tsType};\n`;

    return content;
  }

  /**
   * Operator helper interfaces emitted once per file. Op<T> is equality+set
   * (`eq`, `ne`, `in`, `not_in`); OrdOp<T> adds ordered comparisons; StrOp
   * adds string-only `like`/`ilike`. Per-field filter values are a union of
   * the bare scalar (equality) and the matching operator helper.
   */
  private generateOperatorHelpers(): string {
    return dedent`
      /** Equality + set operators — available on every scalar field */
      export interface Op<T> {
        eq?: T;
        ne?: T;
        in?: T[];
        not_in?: T[];
      }

      /** Ordered operators — numbers, dates, durations */
      export interface OrdOp<T> extends Op<T> {
        gt?: T;
        gte?: T;
        lt?: T;
        lte?: T;
      }

      /** String operators — adds pattern matching to ordered string ops */
      export interface StrOp extends OrdOp<string> {
        like?: string;
        ilike?: string;
      }
    `;
  }

  private generatePropertyDefinition(name: string, prop: Context.PropertyDef, indent: string = ""): string {
    let content = "";

    /*** Use edgeqlType when available for accurate type display and mapping ***/
    const typeForMapping = prop.edgeqlType ?? prop.type;

    /*** Computed properties carry the parser’s `auto` placeholder; render them as `(computed)` in
         JSDoc rather than leaking the keyword. ***/
    const docType = typeForMapping === "auto" ? "(computed)" : typeForMapping;

    /*** Build JSDoc tags for constraints, readonly, default, and annotations ***/
    const jsdocTags: string[] = [];

    /*** Emit @description from annotations ***/
    if (prop.annotations?.["description"])
      jsdocTags.push(`@description ${prop.annotations["description"]}`);

    if (prop.readonly)
      jsdocTags.push("@readonly");

    if (prop.hasDefault)
      jsdocTags.push("@default");

    if (prop.constraints && prop.constraints.length > 0) {
      for (const constraint of prop.constraints) {
        if (constraint.args && constraint.args.length > 0)
          jsdocTags.push(`@constraint ${constraint.name}(${constraint.args.join(", ")})`);
        else
          jsdocTags.push(`@constraint ${constraint.name}`);
      }
    }

    /*** Generate JSDoc: multi-line when tags are present, single-line otherwise ***/
    if (jsdocTags.length > 0) {
      content += `${indent}  /**\n`;
      content += `${indent}   * ${docType}${prop.required ? " (required)" : ""}\n`;

      for (const tag of jsdocTags) {
        content += `${indent}   * ${tag}\n`;
      }

      content += `${indent}   */\n`;
    } else {
      content += `${indent}  /** ${docType}${prop.required ? " (required)" : ""} */\n`;
    }

    /*** Property declaration ***/
    const tsType = Types.mapEdgeQLTypeToTypeScript(typeForMapping, prop.required, prop.multi);
    const optional = prop.required ? "" : "?";

    content += `${indent}  ${name}${optional}: ${tsType};\n`;
    return content;
  }

  private generateQueryBuilder(typeDef: Context.TypeDef, multiModule: boolean = false): string {
    const typeName = this.getTypeScriptTypeName(typeDef.name);
    const builderName = `${typeName}QueryBuilder`;

    /*** EdgeQL type name: qualified for non-default modules ***/
    const edgeqlTypeName = (multiModule && typeDef.module && typeDef.module !== "default") ?
      `${typeDef.module}::${typeDef.name}` :
      typeDef.name;

    /*** TypeScript type reference: namespaced in multi-module mode ***/
    const typeRef = multiModule ?
      `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}` :
      `Types.${typeName}`;

    /*** FilterVars ref ***/
    const filterVarsRef = multiModule ?
      `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}FilterVars` :
      `Types.${typeName}FilterVars`;

    /*** Filter ref (Stage A) — used by the new object-shaped filter() signature ***/
    const filterRef = multiModule ?
      `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}Filter` :
      `Types.${typeName}Filter`;

    /*** InsertRef ***/
    const insertRef = multiModule ?
      `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}Insert` :
      `Types.${typeName}Insert`;

    /*** UpdateRef ***/
    const updateRef = multiModule ?
      `Types.${this.getModuleNamespace(typeDef.module || "default")}.${typeName}Update` :
      `Types.${typeName}Update`;

    /*** Build the type casts map from property definitions (skip "id" and computed properties —
         computed values are read-only outputs with no sensible cast, and including them would emit
         `<auto>` literals). ***/
    const typeCastEntries: string[] = [];

    for (const [propName, prop] of typeDef.properties) {
      if (propName === "id" || prop.computed)
        continue;

      const edgeqlType = prop.edgeqlType ?? prop.type;
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(edgeqlType);
      typeCastEntries.push(`    ${propName}: "${cast}"`);
    }

    /*** Single links are set by target UUID, so insert()/update() cast them as <uuid> and the
         compiler maps the link name onto its FK column. Multi links go in _multiLinkTargets below
         (junction-write subquery, not a scalar cast); computed links (not stored) are excluded —
         matching the Insert/Update interfaces. ***/
    const multiLinkTargetEntries: string[] = [];

    for (const [linkName, link] of typeDef.links) {
      if (link.computed)
        continue;

      if (link.multi) {
        multiLinkTargetEntries.push(`    ${linkName}: "${this.bareTargetName(link.target)}"`);
        continue;
      }

      typeCastEntries.push(`    ${linkName}: "<uuid>"`);
    }

    /*** Build the typeInfo entries (Stage C). Includes id (queryable) and every link as a thunk
         into the target builder’s _typeInfo so the filter compiler can recurse across schemas
         without forward-reference gymnastics. Computed properties are skipped — you can’t filter on
         them and their cast would be the `<auto>` placeholder. ***/
    const typeInfoCastEntries: string[] = [];
    // Computed named-tuple props the filter compiler can recurse into:
    // `counts: { videos: "<int64>", … }`. Lets `{ counts: { videos: {gte} } }`
    // emit `.counts.videos >= <int64>$p` (the compiler inlines the field expr).
    const typeInfoComputedEntries: string[] = [];

    for (const [propName, prop] of typeDef.properties) {
      if (prop.computed) {
        const fields = prop.computedExpr ?
          inferComputedTupleFields(prop.computedExpr) :
          null;
        if (fields) {
          const casts = Object
            .entries(fields)
            .map(([field, edgeqlType]) => `${field}: "${Types.mapEdgeQLTypeToEdgeQLCast(edgeqlType)}"`)
            .join(", ");
          typeInfoComputedEntries.push(`      ${propName}: { ${casts} }`);
        }
        continue;
      }

      const edgeqlType = prop.edgeqlType ?? prop.type;
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(edgeqlType);
      typeInfoCastEntries.push(`      ${propName}: "${cast}"`);
    }

    const typeInfoLinkEntries: string[] = [];

    for (const [linkName, link] of typeDef.links) {
      /*** link.target may be module-qualified (e.g. "default::Merchant"); all builders share
           queries.ts and are referenced by bare class name, so drop the module prefix before
           composing the builder identifier. ***/
      const targetTypeName = link.target.includes("::") ?
        link.target.split("::").pop()! :
        link.target;

      const targetBuilder = `${this.getTypeScriptTypeName(targetTypeName)}QueryBuilder`;
      typeInfoLinkEntries.push(`      ${linkName}: () => ${targetBuilder}._typeInfo`);
    }

    let content = "";

    /*** Builder class ***/
    content += `/**\n`;
    content += ` * Query builder for ${typeName}\n`;
    content += ` */\n`;
    content += `export class ${builderName} {\n`;

    /*** Static type casts map ***/
    content += `  private static _typeCasts: Record<string, string> = {\n`;
    content += typeCastEntries.join(",\n");

    if (typeCastEntries.length > 0)
      content += ",\n";

    content += `  };\n\n`;

    /*** Static multi-link target map — link name → bare target EdgeQL type. insert()/update()
         build a `select <Target> filter .id in array_unpack(<array<uuid>>$...)` subquery from a
         UUID array param so junction rows are written/replaced/deltaed. ***/
    content += `  private static _multiLinkTargets: Record<string, string> = {\n`;
    content += multiLinkTargetEntries.join(",\n");

    if (multiLinkTargetEntries.length > 0)
      content += ",\n";

    content += `  };\n\n`;

    /*** Static typeInfo — consumed by the SDK’s compileFilter() at runtime. Public so cross-builder
         link thunks can reference it without breaking private-access. Sibling builders are
         generated into the same file so there’s no real encapsulation boundary to enforce. ***/
    content += `  static readonly _typeInfo: TypeInfo = {\n`;
    content += `    casts: {\n`;
    content += typeInfoCastEntries.join(",\n");

    if (typeInfoCastEntries.length > 0)
      content += ",\n";

    content += `    },\n`;
    content += `    links: {\n`;
    content += typeInfoLinkEntries.join(",\n");

    if (typeInfoLinkEntries.length > 0)
      content += ",\n";

    content += `    }`;

    if (typeInfoComputedEntries.length > 0) {
      content += `,\n    computed: {\n`;
      content += typeInfoComputedEntries.join(",\n");
      content += `\n    }`;
    }

    content += `\n  };\n\n`;
    content += `  constructor(private client: DiscClient) {}\n\n`;

    /*** Select methods ***/
    content += `  /** Select all ${typeName} objects */\n`;
    content += `  async select(shape?: string): Promise<${typeRef}[]> {\n`;
    content += `    const query = shape \n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape}\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * }\`;\n`;
    content += `    return await this.client.query<${typeRef}[]>(query);\n`;
    content += `  }\n\n`;

    /*** Select by ID ***/
    content += `  /** Select ${typeName} by ID */\n`;
    content += `  async selectById(id: string, shape?: string): Promise<${typeRef} | null> {\n`;
    content += `    const query = shape\n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape} filter .id = <uuid>$id\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * } filter .id = <uuid>$id\`;\n`;
    content += `    const results = await this.client.query<${typeRef}[]>(query, { id });\n`;
    content += `    return results[0] || null;\n`;
    content += `  }\n\n`;

    /*** Filter method (Stage C + D) — object-shaped filter compiled by the SDK. Reserved keys at
         the top level (select / order_by / limit / offset) are extracted by compileFilter and
         assembled here. ***/
    content += `  /** Filter ${typeName} objects */\n`;
    content += `  async filter(filter: FilterArg<${filterRef}>): Promise<${typeRef}[]> {\n`;
    content += `    const compiled = compileFilter("${edgeqlTypeName}", filter, ${builderName}._typeInfo);\n`;
    content += `    const shape = compiled.selectShape ?? "{ * }";\n`;
    content += `    const parts: string[] = [\`select ${edgeqlTypeName} \${shape}\`];\n`;
    content += `    if (compiled.clause) parts.push(\`filter \${compiled.clause}\`);\n`;
    content += `    if (compiled.orderBy) parts.push(compiled.orderBy);\n`;
    content += `    if (compiled.limit !== null) parts.push(\`limit \${compiled.limit}\`);\n`;
    content += `    if (compiled.offset !== null) parts.push(\`offset \${compiled.offset}\`);\n`;
    content += `    return await this.client.query<${typeRef}[]>(parts.join(" "), compiled.variables);\n`;
    content += `  }\n\n`;

    /*** Insert method. Multi-link keys assign the full set via a junction-write subquery built from
         a UUID array param; scalar/single-link keys keep the cast-and-bind path. ***/
    content += `  /** Insert new ${typeName} */\n`;
    content += `  async insert(data: ${insertRef}): Promise<${typeRef}> {\n`;
    content += `    const variables: Record<string, unknown> = {};\n`;
    content += `    const assignments = Object.entries(data).map(([key, value]) => {\n`;
    content += `      const target = ${builderName}._multiLinkTargets[key];\n`;
    content += `      if (target) {\n`;
    content += `        variables[key] = value;\n`;
    content += `        return \`\${escapeEdgeQLIdent(key)} := (select \${target} filter .id in array_unpack(<array<uuid>>$\${key}))\`;\n`;
    content += `      }\n`;
    content += `      variables[key] = value;\n`;
    content += `      return \`\${escapeEdgeQLIdent(key)} := \${${builderName}._typeCasts[key] || "<str>"}$\${key}\`;\n`;
    content += `    }).join(", ");\n`;
    content += `    const query = \`insert ${edgeqlTypeName} { \${assignments} }\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, variables);\n`;
    content += `  }\n\n`;

    /*** Update method. Multi-link keys branch on value shape: a bare array replaces the whole set
         (\`:=\`), while a { add, remove } object applies a junction delta (\`+=\` / \`-=\`) with
         distinct \`__add\` / \`__remove\` params so they never collide with each other or \`id\`.
         Scalar/single-link keys keep the cast-and-bind path. ***/
    content += `  /** Update ${typeName} by ID */\n`;
    content += `  async update(id: string, data: ${updateRef}): Promise<${typeRef}> {\n`;
    content += `    const variables: Record<string, unknown> = { id };\n`;
    content += `    const assignments: string[] = [];\n`;
    content += `    for (const [key, value] of Object.entries(data)) {\n`;
    content += `      const target = ${builderName}._multiLinkTargets[key];\n`;
    content += `      if (target) {\n`;
    content += `        if (Array.isArray(value)) {\n`;
    content += `          variables[key] = value;\n`;
    content += `          assignments.push(\`\${escapeEdgeQLIdent(key)} := (select \${target} filter .id in array_unpack(<array<uuid>>$\${key}))\`);\n`;
    content += `        } else {\n`;
    content += `          const delta = (value ?? {}) as { add?: string[]; remove?: string[] };\n`;
    content += `          if (delta.add) {\n`;
    content += `            variables[\`\${key}__add\`] = delta.add;\n`;
    content += `            assignments.push(\`\${escapeEdgeQLIdent(key)} += (select \${target} filter .id in array_unpack(<array<uuid>>$\${key}__add))\`);\n`;
    content += `          }\n`;
    content += `          if (delta.remove) {\n`;
    content += `            variables[\`\${key}__remove\`] = delta.remove;\n`;
    content +=
      `            assignments.push(\`\${escapeEdgeQLIdent(key)} -= (select \${target} filter .id in array_unpack(<array<uuid>>$\${key}__remove))\`);\n`;
    content += `          }\n`;
    content += `        }\n`;
    content += `        continue;\n`;
    content += `      }\n`;
    content += `      variables[key] = value;\n`;
    content += `      assignments.push(\`\${escapeEdgeQLIdent(key)} := \${${builderName}._typeCasts[key] || "<str>"}$\${key}\`);\n`;
    content += `    }\n`;
    content += `    const query = \`update ${edgeqlTypeName} filter .id = <uuid>$id set { \${assignments.join(", ")} }\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, variables);\n`;
    content += `  }\n\n`;

    /*** Delete method ***/
    content += `  /** Delete ${typeName} by ID */\n`;
    content += `  async delete(id: string): Promise<${typeRef}> {\n`;
    content += `    const query = \`delete ${edgeqlTypeName} filter .id = <uuid>$id\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, { id });\n`;
    content += `  }\n\n`;

    /*** Count method ***/
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

  private generateQueryBuilders(): Types.GeneratedFile {
    let content = "";

    /*** File header ***/
    content += this.generateFileHeader("Query Builders");
    content += "\n";

    const multiModule = this.isMultiModule();

    /*** Import types - different source file in multi-module mode ***/
    const typesImport = multiModule ? "./interfaces.ts" : "./types.ts";
    const sdkBase = this.config.sdkImportBase ?? "./sdk/mod.ts";
    content += `import * as Types from "${typesImport}";\n`;
    content += `import { DiscClient } from "./client.ts";\n`;
    content += `import { compileFilter, escapeEdgeQLIdent, type FilterArg, type TypeInfo } from "${sdkBase}";\n\n`;

    /*** Generate builder for each type ***/
    for (const [_typeName, typeDef] of this.schema.types) {
      if (typeDef.kind === "object") {
        content += this.generateQueryBuilder(typeDef, multiModule);
        content += "\n";
      }
    }

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/queries.ts`,
      type: "queries"
    };
  }

  /**
   * Per-type Select interface. Each scalar field is `boolean` (true to
   * include); each link is `boolean | TargetSelect` (true to pull all
   * fields, or a nested Select to narrow). When this Select is used as a
   * link's sub-shape, `order_by` orders that link's set; at the top level it
   * is ignored (use the sibling `order_by` on the filter instead).
   */
  private generateSelectType(typeDef: Context.TypeDef, indent: string = "", currentModule?: string): string {
    const tsTypeName = this.getTypeScriptTypeName(typeDef.name);
    let content = "";
    content += `${indent}export interface ${tsTypeName}Select {\n`;

    // Splat: include every scalar field. Combine with link keys to get all
    // scalars plus shaped links (e.g. `{ "*": true, posts: true }`).
    content += `${indent}  "*"?: boolean;\n`;
    // Order a link's set when this Select is a sub-shape: `-field` = desc.
    content += `${indent}  order_by?: string | string[];\n`;

    for (const [propName] of typeDef.properties) {
      content += `${indent}  ${propName}?: boolean;\n`;
    }

    for (const [linkName, link] of typeDef.links) {
      const targetTs = currentModule ?
        this.resolveTypeReference(link.target, currentModule) :
        this.getTypeScriptTypeName(link.target);

      content += `${indent}  ${linkName}?: boolean | ${targetTs}Select;\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  private generateTypeDefinitions(): Types.GeneratedFile {
    let content = "";

    /*** File header ***/
    content += this.generateFileHeader("Type Definitions");
    content += "\n";

    if (this.isMultiModule()) {
      /*** Namespaced output ***/
      const groups = this.groupTypesByModule();

      /*** Sort modules: default first, then alphabetical ***/
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
            /*** Insert/Update/FilterVars/Filter/Select inside namespace ***/
            const tsName = this.getTypeScriptTypeName(typeDef.name);
            content += this.generateInsertType(tsName, typeDef, "  ");
            content += "\n";
            content += this.generateUpdateType(tsName, typeDef, "  ");
            content += "\n";
            content += this.generateFilterVarsType(tsName, typeDef, "  ");
            content += "\n";
            content += this.generateFilterType(typeDef, "  ", mod);
            content += "\n";
            content += this.generateSelectType(typeDef, "  ", mod);
            content += "\n";
          }
        }

        content += `}\n\n`;
      }

      /*** Generate utility types outside namespaces ***/
      content += this.generateUtilityTypes();
    } else {
      /*** Flat output (existing behavior) ***/
      for (const [_typeName, typeDef] of this.schema.types) {
        if (typeDef.kind === "enum" && typeDef.enumValues) {
          content += this.generateEnumType(typeDef);
          content += "\n";
        } else if (typeDef.kind === "object") {
          content += this.generateInterface(typeDef);
          content += "\n";
        }
      }

      /*** Generate utility types ***/
      content += this.generateUtilityTypes();
    }

    const fileName = this.isMultiModule() ? "interfaces.ts" : "types.ts";

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/${fileName}`,
      type: this.isMultiModule() ? "interfaces" : "types"
    };
  }

  private generateUpdateType(tsTypeName: string, typeDef: Context.TypeDef, indent: string = ""): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}Update {\n`;

    for (const [propName, prop] of typeDef.properties) {
      /*** Exclude id ***/
      if (propName === "id")
        continue;

      /*** Exclude computed properties ***/
      if (prop.computed)
        continue;

      /*** Exclude readonly properties ***/
      if (prop.readonly)
        continue;

      const typeForMapping = prop.edgeqlType ?? prop.type;

      const tsType = Types.mapEdgeQLTypeToTypeScript(
        typeForMapping,
        true, /*** always use non-nullable base type ***/
        prop.multi
      );

      /*** Everything in update is optional ***/
      content += `${indent}  ${propName}?: ${tsType};\n`;
    }

    /*** Links — always optional in update. Single links take a UUID string (same convention as
         Insert). Multi links take either a bare array (replaces the whole set) or a delta object
         (`add` / `remove`). Computed links aren't stored, so they're excluded. ***/
    for (const [linkName, link] of typeDef.links) {
      if (link.computed)
        continue;

      if (link.multi) {
        content += `${indent}  /** UUIDs of linked ${this.bareTargetName(link.target)}: an array replaces the whole set; { add, remove } applies a delta */\n`;
        content += `${indent}  ${linkName}?: string[] | { add?: string[]; remove?: string[] };\n`;
        continue;
      }

      content += `${indent}  /** UUID of the linked ${link.target} */\n`;
      content += `${indent}  ${linkName}?: string;\n`;
    }

    content += `${indent}}\n`;
    return content;
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

    /*** Operator helpers — emitted once at file scope, referenced by every per-type Filter
         regardless of namespace nesting. ***/
    content += this.generateOperatorHelpers();

    /*** Only generate Insert/Update/FilterVars/Filter/Select in utility section for flat
         (non-module) output. Multi-module mode emits these inside their owning namespace
         in generateTypeDefinitions(). ***/
    if (!this.isMultiModule()) {
      content += `/** Insert/Update/FilterVars/Filter/Select data types */\n`;

      for (const [typeName, typeDef] of this.schema.types) {
        /*** Skip enum types — they don’t have insert/update/filter types ***/
        if (typeDef.kind === "enum")
          continue;

        const tsTypeName = this.getTypeScriptTypeName(typeName);

        /*** Generate Insert interface with smart rules ***/
        content += this.generateInsertType(tsTypeName, typeDef);
        content += "\n";

        /*** Generate Update interface with smart rules ***/
        content += this.generateUpdateType(tsTypeName, typeDef);
        content += "\n";

        /*** Generate FilterVars interface for typed filter/count parameters ***/
        content += this.generateFilterVarsType(tsTypeName, typeDef);
        content += "\n";

        /*** Generate Filter interface (object-shaped query API) ***/
        content += this.generateFilterType(typeDef);
        content += "\n";

        /*** Generate Select interface (shape narrowing for `select` reserved key) ***/
        content += this.generateSelectType(typeDef);
        content += "\n";
      }
    }

    return content;
  }

  /**
   * Pick the operator helper type for a field given its EdgeQL type.
   * - `str` → `StrOp` (concrete; carries `like`/`ilike`)
   * - numbers, dates, durations → `OrdOp<TsType>`
   * - bool, uuid, bytes, json, enums → `Op<TsType>` (equality only)
   */
  private getOperatorHelperFor(edgeqlType: string, tsType: string): string {
    if (edgeqlType === "str")
      return "StrOp";

    const orderedTypes = new Set([
      "int16",
      "int32",
      "int64",
      "float32",
      "float64",
      "decimal",
      "bigint",
      "datetime",
      "duration",
      "cal::local_datetime",
      "cal::local_date",
      "cal::local_time",
      "cal::relative_duration",
      "cal::date_duration"
    ]);

    if (orderedTypes.has(edgeqlType))
      return `OrdOp<${tsType}>`;

    return `Op<${tsType}>`;
  }

  /** Convert module name to TypeScript namespace name */
  private getModuleNamespace(moduleName: string): string {
    return moduleName === "default" ? "$default" : moduleName;
  }

  private getTypeScriptTypeName(edgeqlTypeName: string): string {
    const prefix = this.config.typePrefix || "";
    const suffix = this.config.interfaceSuffix || "";

    return `${prefix}${edgeqlTypeName}${suffix}`;
  }

  /** Group schema types by their module */
  private groupTypesByModule(): Map<string, Context.TypeDef[]> {
    const groups = new Map<string, Context.TypeDef[]>();

    for (const [_name, typeDef] of this.schema.types) {
      const mod = typeDef.module || "default";

      if (!groups.has(mod))
        groups.set(mod, []);

      groups.get(mod)!.push(typeDef);
    }

    return groups;
  }

  /** Check if schema has multi-module types */
  private isMultiModule(): boolean {
    for (const [_name, typeDef] of this.schema.types) {
      if (typeDef.module && typeDef.module !== "default")
        return true;
    }

    /*** Also check: if any type has module set at all (even all default), use namespace mode ***/
    for (const [_name, typeDef] of this.schema.types) {
      if (typeDef.module)
        return true;
    }

    return false;
  }

  /**
   * Resolve a type reference for cross-module use.
   * If target is in a different module from currentModule, prefix with namespace.
   * If same module, use bare name.
   */
  private resolveTypeReference(target: string, currentModule: string): string {
    /*** Check if target contains :: (qualified name like "payment::Transaction") ***/
    let targetModule = "default";
    let targetName = target;

    if (target.includes("::")) {
      const parts = target.split("::");
      targetModule = parts[0];
      targetName = parts[parts.length - 1];
    } else {
      /*** Try to find the type in the schema to determine its module ***/
      const typeDef = this.schema.types.get(target);

      if (typeDef?.module)
        targetModule = typeDef.module;
    }

    const tsName = this.getTypeScriptTypeName(targetName);

    if (targetModule === currentModule)
      return tsName;

    return `${this.getModuleNamespace(targetModule)}.${tsName}`;
  }
}
