/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * TypeScript emitter on the codegen IR.
 *
 * Consumes the language-neutral IR (`codegen/ir.ts`) and produces the
 * production TypeScript client output. It reads only IR nodes (plus the shared
 * scalar/cast helpers in `types.ts`) and never re-derives schema semantics —
 * insert/update/filter inclusion and optionality come from the IR's
 * denormalized shapes. Output is regression-guarded by the golden snapshots in
 * `codegen/emit-typescript.test.ts`.
 */

/*** IMPORT ------------------------------------------- ***/

import { default as dedent } from "@netopwibby/dedent";

/*** UTILITY ------------------------------------------ ***/

import * as Types from "./types.ts";
import { inferComputedTupleFields } from "./computed-tuple-inference.ts";
import type {
  CodegenIR,
  EnumType,
  Field,
  ObjectType,
  QualifiedName,
  ScalarKind,
  ShapeField,
  TypeRef
} from "./ir.ts";

/*** EXPORT ------------------------------------------- ***/

/** Emit the TypeScript client files from the IR. */
export function emitTypeScript(ir: CodegenIR, config: Types.CodegenConfig): Types.GeneratedFile[] {
  return new TypeScriptEmitter(ir, config).generate();
}

/*** HELPER ------------------------------------------- ***/

/** ScalarKind -> EdgeQL display/mapping string (the `cal::` family carries its module). */
const CAL_SCALARS: ReadonlySet<ScalarKind> = new Set<ScalarKind>([
  "local_datetime",
  "local_date",
  "local_time",
  "relative_duration",
  "date_duration"
]);

function scalarKindToEdgeQL(kind: ScalarKind): string {
  return CAL_SCALARS.has(kind) ? `cal::${kind}` : kind;
}

/**
 * Reconstruct the EdgeQL type string a field carried before IR conversion, for
 * both JSDoc display and the scalar/cast mapping. Scalars and the fixture set
 * round-trip 1:1; collections are rebuilt structurally.
 */
function typeRefToEdgeQL(ref: TypeRef): string {
  switch (ref.kind) {
    case "scalar":
      return scalarKindToEdgeQL(ref.scalar);
    case "enum":
      return ref.name.name;
    case "object":
      return qualifiedToTarget(ref.name);
    case "array":
      return `array<${typeRefToEdgeQL(ref.element)}>`;
    case "range":
      return `range<${typeRefToEdgeQL(ref.element)}>`;
    case "multirange":
      return `multirange<${typeRefToEdgeQL(ref.element)}>`;
    case "tuple":
      return `tuple<${ref.elements.map(typeRefToEdgeQL).join(", ")}>`;
    case "named_tuple":
      return `tuple<${ref.elements.map(e => `${e.name}: ${typeRefToEdgeQL(e.type)}`).join(", ")}>`;
    case "shape":
      return ref.object.name;
  }
}

/** Render a QualifiedName as the link/target display string (`module::Name`, bare for default). */
function qualifiedToTarget(qn: QualifiedName): string {
  return qn.module === "default" ? qn.name : `${qn.module}::${qn.name}`;
}

/** required iff cardinality is a required arm. */
function isRequired(cardinality: string): boolean {
  return cardinality === "One" || cardinality === "AtLeastOne";
}

/** multi iff cardinality is a multi arm. */
function isMulti(cardinality: string): boolean {
  return cardinality === "Many" || cardinality === "AtLeastOne";
}

class TypeScriptEmitter {
  private config: Types.CodegenConfig;
  private ir: CodegenIR;

  constructor(ir: CodegenIR, config: Types.CodegenConfig) {
    this.ir = ir;
    this.config = config;
  }

  generate(): Types.GeneratedFile[] {
    const files: Types.GeneratedFile[] = [];

    files.push(this.generateTypeDefinitions());

    if (this.config.includeQueryBuilders)
      files.push(this.generateQueryBuilders());

    if (this.config.includeClient)
      files.push(this.generateClient());

    files.push(this.generateIndexFile());

    return files;
  }

  // -- IR navigation --------------------------------------------------------

  /** All object types in emission order (module order, objects within a module). */
  private allObjects(): ObjectType[] {
    return this.ir.modules.flatMap(m => m.objects);
  }

  private bareTargetName(qn: QualifiedName): string {
    return qn.name;
  }

  /** Look up an object's base field by name (links carry their target ref here). */
  private fieldByName(obj: ObjectType, name: string): Field | undefined {
    return obj.fields.find(f => f.name === name);
  }

  private formatContent(content: string): string {
    if (!this.config.formatOutput)
      return content;

    return content
      .replace(/\n\n\n+/g, "\n\n")
      .trim() + "\n";
  }

  private getModuleNamespace(moduleName: string): string {
    return moduleName === "default" ? "$default" : moduleName;
  }

  private getTypeScriptTypeName(edgeqlTypeName: string): string {
    const prefix = this.config.typePrefix || "";
    const suffix = this.config.interfaceSuffix || "";
    return `${prefix}${edgeqlTypeName}${suffix}`;
  }

  private isMultiModule(): boolean {
    return this.ir.multiModule;
  }

  /** IR analogue of resolveTypeReference: namespace-qualify a target out of currentModule. */
  private resolveTypeReference(qn: QualifiedName, currentModule: string): string {
    const tsName = this.getTypeScriptTypeName(qn.name);
    if (qn.module === currentModule)
      return tsName;
    return `${this.getModuleNamespace(qn.module)}.${tsName}`;
  }

  /** Resolve a link/parent target to its TS reference, honoring flat vs multi-module. */
  private targetRef(qn: QualifiedName, currentModule?: string): string {
    return currentModule ?
      this.resolveTypeReference(qn, currentModule) :
      this.getTypeScriptTypeName(qn.name);
  }

  // -- File header ----------------------------------------------------------

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

  // -- Type definitions -----------------------------------------------------

  private generateTypeDefinitions(): Types.GeneratedFile {
    let content = "";

    content += this.generateFileHeader("Type Definitions");
    content += "\n";

    if (this.isMultiModule()) {
      for (const module of this.ir.modules) {
        const ns = this.getModuleNamespace(module.name);
        content += `export namespace ${ns} {\n`;

        for (const enumType of module.enums) {
          content += this.generateEnumType(enumType, "  ");
          content += "\n";
        }

        for (const obj of module.objects) {
          content += this.generateInterface(obj, "  ", module.name);
          content += "\n";
          const tsName = this.getTypeScriptTypeName(obj.name.name);
          content += this.generateInsertType(tsName, obj, "  ");
          content += "\n";
          content += this.generateUpdateType(tsName, obj, "  ");
          content += "\n";
          content += this.generateFilterVarsType(tsName, obj, "  ");
          content += "\n";
          content += this.generateFilterType(obj, "  ", module.name);
          content += "\n";
          content += this.generateSelectType(obj, "  ", module.name);
          content += "\n";
        }

        content += `}\n\n`;
      }

      content += this.generateUtilityTypes();
    } else {
      for (const module of this.ir.modules) {
        for (const enumType of module.enums) {
          content += this.generateEnumType(enumType);
          content += "\n";
        }
        for (const obj of module.objects) {
          content += this.generateInterface(obj);
          content += "\n";
        }
      }

      content += this.generateUtilityTypes();
    }

    const fileName = this.isMultiModule() ? "interfaces.ts" : "types.ts";

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/${fileName}`,
      type: this.isMultiModule() ? "interfaces" : "types"
    };
  }

  private generateEnumType(enumType: EnumType, indent: string = ""): string {
    const typeName = this.getTypeScriptTypeName(enumType.name.name);
    let content = "";

    content += `${indent}/**\n`;
    content += `${indent} * ${enumType.name.name} enum type from EdgeQL schema\n`;
    content += `${indent} */\n`;

    const values = enumType
      .members
      .map(v => `"${v}"`)
      .join(" | ");

    content += `${indent}export type ${typeName} = ${values || "never"};\n`;
    return content;
  }

  private generateInterface(obj: ObjectType, indent: string = "", currentModule?: string): string {
    const interfaceName = this.getTypeScriptTypeName(obj.name.name);
    let content = "";

    content += `${indent}/**\n`;

    if (obj.description) {
      content += `${indent} * ${obj.description}\n`;
      content += `${indent} *\n`;
    }

    content += `${indent} * ${obj.name.name} type from EdgeQL schema\n`;
    content += `${indent} * Table: ${obj.tableName}\n`;
    content += `${indent} */\n`;

    if (obj.parentTypes && obj.parentTypes.length > 0) {
      const parentNames = obj.parentTypes.map(p => this.targetRef(p, currentModule));
      content += `${indent}export interface ${interfaceName} extends ${parentNames.join(", ")} {\n`;
    } else {
      content += `${indent}export interface ${interfaceName} {\n`;
    }

    content += `${indent}  /** Unique identifier */\n`;
    content += `${indent}  id: string;\n`;

    for (const field of obj.fields) {
      if (field.isLink)
        continue;
      if (field.name === "id")
        continue;
      content += this.generatePropertyDefinition(field, indent);
    }

    for (const field of obj.fields) {
      if (!field.isLink)
        continue;
      content += this.generateLinkDefinition(field, indent, currentModule);
    }

    content += `${indent}}\n`;
    return content;
  }

  private generatePropertyDefinition(field: Field, indent: string = ""): string {
    let content = "";

    const typeForMapping = field.sourceType;
    const docType = typeForMapping === "auto" ? "(computed)" : typeForMapping;
    const required = isRequired(field.cardinality);
    const multi = isMulti(field.cardinality);

    const jsdocTags: string[] = [];

    if (field.description)
      jsdocTags.push(`@description ${field.description}`);

    if (field.readonly)
      jsdocTags.push("@readonly");

    if (field.hasDefault)
      jsdocTags.push("@default");

    if (field.constraints && field.constraints.length > 0) {
      for (const constraint of field.constraints) {
        if (constraint.args && constraint.args.length > 0)
          jsdocTags.push(`@constraint ${constraint.name}(${constraint.args.join(", ")})`);
        else
          jsdocTags.push(`@constraint ${constraint.name}`);
      }
    }

    if (jsdocTags.length > 0) {
      content += `${indent}  /**\n`;
      content += `${indent}   * ${docType}${required ? " (required)" : ""}\n`;

      for (const tag of jsdocTags) {
        content += `${indent}   * ${tag}\n`;
      }

      content += `${indent}   */\n`;
    } else {
      content += `${indent}  /** ${docType}${required ? " (required)" : ""} */\n`;
    }

    const tsType = Types.mapEdgeQLTypeToTypeScript(typeForMapping, required, multi);
    const optional = required ? "" : "?";

    content += `${indent}  ${field.name}${optional}: ${tsType};\n`;
    return content;
  }

  private generateLinkDefinition(field: Field, indent: string = "", currentModule?: string): string {
    let content = "";

    const target = field.type.kind === "object" ? field.type.name : { module: "default", name: "unknown" };
    const required = isRequired(field.cardinality);
    const multi = isMulti(field.cardinality);

    const relationshipType = multi ? "many" : "one";
    // Echo the raw link target spelling (e.g. "default::Customer"), as the
    // generator does, rather than a canonicalized bare name.
    content += `${indent}  /** Link to ${field.sourceType} (${relationshipType}${required ? ", required" : ""}) */\n`;

    const targetType = this.targetRef(target, currentModule);
    let tsType = targetType;

    if (multi)
      tsType = `${targetType}[]`;

    if (!required)
      tsType += " | null";

    const optional = required ? "" : "?";
    content += `${indent}  ${field.name}${optional}: ${tsType};\n`;

    return content;
  }

  // -- Insert / Update ------------------------------------------------------

  private generateInsertType(tsTypeName: string, obj: ObjectType, indent: string = ""): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}Insert {\n`;

    for (const sf of obj.shapes.insert.fields) {
      if (sf.isLink) {
        content += this.linkShapeFieldInsert(sf, obj, indent);
        continue;
      }

      const base = this.fieldByName(obj, sf.name);
      const src = base ? base.sourceType : typeRefToEdgeQL(sf.type);
      const tsType = Types.mapEdgeQLTypeToTypeScript(src, true, isMulti(sf.cardinality));
      const optional = sf.optional ? "?" : "";
      content += `${indent}  ${sf.name}${optional}: ${tsType};\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  private linkShapeFieldInsert(sf: ShapeField, obj: ObjectType, indent: string): string {
    const base = this.fieldByName(obj, sf.name);
    const target = base && base.type.kind === "object" ? base.type.name : { module: "default", name: "unknown" };
    const optional = sf.optional ? "?" : "";
    let content = "";

    if (isMulti(sf.cardinality)) {
      content += `${indent}  /** UUIDs of linked ${this.bareTargetName(target)} (assigns the full set) */\n`;
      content += `${indent}  ${sf.name}${optional}: string[];\n`;
      return content;
    }

    content += `${indent}  /** UUID of the linked ${base ? base.sourceType : qualifiedToTarget(target)} */\n`;
    content += `${indent}  ${sf.name}${optional}: string;\n`;
    return content;
  }

  private generateUpdateType(tsTypeName: string, obj: ObjectType, indent: string = ""): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}Update {\n`;

    for (const sf of obj.shapes.update.fields) {
      if (sf.isLink) {
        content += this.linkShapeFieldUpdate(sf, obj, indent);
        continue;
      }

      const base = this.fieldByName(obj, sf.name);
      const src = base ? base.sourceType : typeRefToEdgeQL(sf.type);
      const tsType = Types.mapEdgeQLTypeToTypeScript(src, true, isMulti(sf.cardinality));
      content += `${indent}  ${sf.name}?: ${tsType};\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  private linkShapeFieldUpdate(sf: ShapeField, obj: ObjectType, indent: string): string {
    const base = this.fieldByName(obj, sf.name);
    const target = base && base.type.kind === "object" ? base.type.name : { module: "default", name: "unknown" };
    let content = "";

    if (isMulti(sf.cardinality)) {
      content += `${indent}  /** UUIDs of linked ${this.bareTargetName(target)}: an array replaces the whole set; { add, remove } applies a delta */\n`;
      content += `${indent}  ${sf.name}?: string[] | { add?: string[]; remove?: string[] };\n`;
      return content;
    }

    content += `${indent}  /** UUID of the linked ${base ? base.sourceType : qualifiedToTarget(target)} */\n`;
    content += `${indent}  ${sf.name}?: string;\n`;
    return content;
  }

  // -- FilterVars / Filter / Select -----------------------------------------

  private generateFilterVarsType(tsTypeName: string, obj: ObjectType, indent: string = ""): string {
    let content = "";
    content += `${indent}export interface ${tsTypeName}FilterVars {\n`;

    for (const fv of obj.shapes.filterVars.fields) {
      const base = this.fieldByName(obj, fv.name);
      const multi = base ? isMulti(base.cardinality) : false;
      const src = base ? base.sourceType : typeRefToEdgeQL(fv.type);
      const tsType = Types.mapEdgeQLTypeToTypeScript(src, true, multi);
      content += `${indent}  ${fv.name}?: ${tsType};\n`;
    }

    content += `${indent}  [key: string]: unknown;\n`;
    content += `${indent}}\n`;

    return content;
  }

  private generateFilterType(obj: ObjectType, indent: string = "", currentModule?: string): string {
    const tsTypeName = this.getTypeScriptTypeName(obj.name.name);
    let content = "";
    content += `${indent}export interface ${tsTypeName}Filter {\n`;

    for (const field of obj.fields) {
      if (field.isLink)
        continue;

      // Computed named-tuple property (e.g. `counts := (videos := count(...))`):
      // emit a typed nested filter `counts?: { videos?: number | Op<…> }`.
      // Computed props we can't infer are omitted (rather than emitting a
      // broken `unknown | Op<unknown>` field).
      if (field.isComputed) {
        const inferred = field.computedExpr ?
          inferComputedTupleFields(field.computedExpr) :
          null;
        if (!inferred)
          continue;
        const inner = Object
          .entries(inferred)
          .map(([name, edgeqlType]) => {
            const ts = Types.mapEdgeQLTypeToTypeScript(edgeqlType, true, false);
            const op = this.getOperatorHelperFor(edgeqlType, ts);
            return `${name}?: ${ts} | ${op}`;
          })
          .join("; ");
        content += `${indent}  ${field.name}?: { ${inner} };\n`;
        continue;
      }

      const edgeqlType = field.sourceType;
      const tsType = Types.mapEdgeQLTypeToTypeScript(edgeqlType, true, isMulti(field.cardinality));
      const opHelper = this.getOperatorHelperFor(edgeqlType, tsType);
      content += `${indent}  ${field.name}?: ${tsType} | ${opHelper};\n`;
    }

    for (const field of obj.fields) {
      if (!field.isLink)
        continue;
      const target = field.type.kind === "object" ? field.type.name : { module: "default", name: "unknown" };
      const targetTs = this.targetRef(target, currentModule);
      content += `${indent}  ${field.name}?: ${targetTs}Filter;\n`;
    }

    content += `${indent}  select?: ${tsTypeName}Select;\n`;
    content += `${indent}  order_by?: string | string[];\n`;
    content += `${indent}  limit?: number;\n`;
    content += `${indent}  offset?: number;\n`;
    content += `${indent}}\n`;

    return content;
  }

  private generateSelectType(obj: ObjectType, indent: string = "", currentModule?: string): string {
    const tsTypeName = this.getTypeScriptTypeName(obj.name.name);
    let content = "";
    content += `${indent}export interface ${tsTypeName}Select {\n`;

    content += `${indent}  "*"?: boolean;\n`;
    content += `${indent}  order_by?: string | string[];\n`;

    for (const field of obj.fields) {
      if (field.isLink)
        continue;
      content += `${indent}  ${field.name}?: boolean;\n`;
    }

    for (const field of obj.fields) {
      if (!field.isLink)
        continue;
      const target = field.type.kind === "object" ? field.type.name : { module: "default", name: "unknown" };
      const targetTs = this.targetRef(target, currentModule);
      content += `${indent}  ${field.name}?: boolean | ${targetTs}Select;\n`;
    }

    content += `${indent}}\n`;
    return content;
  }

  // -- Utility types --------------------------------------------------------

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

    content += this.generateOperatorHelpers();

    if (!this.isMultiModule()) {
      content += `/** Insert/Update/FilterVars/Filter/Select data types */\n`;

      for (const obj of this.allObjects()) {
        const tsTypeName = this.getTypeScriptTypeName(obj.name.name);

        content += this.generateInsertType(tsTypeName, obj);
        content += "\n";
        content += this.generateUpdateType(tsTypeName, obj);
        content += "\n";
        content += this.generateFilterVarsType(tsTypeName, obj);
        content += "\n";
        content += this.generateFilterType(obj);
        content += "\n";
        content += this.generateSelectType(obj);
        content += "\n";
      }
    }

    return content;
  }

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

  // -- Query builders -------------------------------------------------------

  private generateQueryBuilders(): Types.GeneratedFile {
    let content = "";

    content += this.generateFileHeader("Query Builders");
    content += "\n";

    const multiModule = this.isMultiModule();

    const typesImport = multiModule ? "./interfaces.ts" : "./types.ts";
    const sdkBase = this.config.sdkImportBase ?? "./sdk/mod.ts";
    content += `import * as Types from "${typesImport}";\n`;
    content += `import { DiscClient } from "./client.ts";\n`;
    content += `import { compileFilter, escapeEdgeQLIdent, type FilterArg, type TypeInfo } from "${sdkBase}";\n\n`;

    for (const obj of this.allObjects()) {
      content += this.generateQueryBuilder(obj, multiModule);
      content += "\n";
    }

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/queries.ts`,
      type: "queries"
    };
  }

  private generateQueryBuilder(obj: ObjectType, multiModule: boolean = false): string {
    const typeName = this.getTypeScriptTypeName(obj.name.name);
    const builderName = `${typeName}QueryBuilder`;
    const module = obj.name.module;

    const edgeqlTypeName = (multiModule && module && module !== "default") ?
      `${module}::${obj.name.name}` :
      obj.name.name;

    const ns = this.getModuleNamespace(module || "default");
    const typeRef = multiModule ? `Types.${ns}.${typeName}` : `Types.${typeName}`;
    const filterVarsRef = multiModule ? `Types.${ns}.${typeName}FilterVars` : `Types.${typeName}FilterVars`;
    const filterRef = multiModule ? `Types.${ns}.${typeName}Filter` : `Types.${typeName}Filter`;
    const insertRef = multiModule ? `Types.${ns}.${typeName}Insert` : `Types.${typeName}Insert`;
    const updateRef = multiModule ? `Types.${ns}.${typeName}Update` : `Types.${typeName}Update`;

    const typeCastEntries: string[] = [];

    for (const field of obj.fields) {
      if (field.isLink || field.isComputed || field.name === "id")
        continue;
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(field.sourceType);
      typeCastEntries.push(`    ${field.name}: "${cast}"`);
    }

    const multiLinkTargetEntries: string[] = [];

    for (const field of obj.fields) {
      if (!field.isLink || field.isComputed)
        continue;
      const target = field.type.kind === "object" ? field.type.name : { module: "default", name: "unknown" };
      if (isMulti(field.cardinality)) {
        multiLinkTargetEntries.push(`    ${field.name}: "${this.bareTargetName(target)}"`);
        continue;
      }
      typeCastEntries.push(`    ${field.name}: "<uuid>"`);
    }

    const typeInfoCastEntries: string[] = [];
    // Computed named-tuple props the filter compiler can recurse into:
    // `counts: { videos: "<int64>", … }`.
    const typeInfoComputedEntries: string[] = [];

    for (const field of obj.fields) {
      if (field.isLink)
        continue;
      if (field.isComputed) {
        const inferred = field.computedExpr ?
          inferComputedTupleFields(field.computedExpr) :
          null;
        if (inferred) {
          const casts = Object
            .entries(inferred)
            .map(([name, edgeqlType]) => `${name}: "${Types.mapEdgeQLTypeToEdgeQLCast(edgeqlType)}"`)
            .join(", ");
          typeInfoComputedEntries.push(`      ${field.name}: { ${casts} }`);
        }
        continue;
      }
      const cast = Types.mapEdgeQLTypeToEdgeQLCast(field.sourceType);
      typeInfoCastEntries.push(`      ${field.name}: "${cast}"`);
    }

    const typeInfoLinkEntries: string[] = [];

    for (const field of obj.fields) {
      if (!field.isLink)
        continue;
      const target = field.type.kind === "object" ? field.type.name : { module: "default", name: "unknown" };
      const targetBuilder = `${this.getTypeScriptTypeName(target.name)}QueryBuilder`;
      typeInfoLinkEntries.push(`      ${field.name}: () => ${targetBuilder}._typeInfo`);
    }

    let content = "";

    content += `/**\n`;
    content += ` * Query builder for ${typeName}\n`;
    content += ` */\n`;
    content += `export class ${builderName} {\n`;

    content += `  private static _typeCasts: Record<string, string> = {\n`;
    content += typeCastEntries.join(",\n");

    if (typeCastEntries.length > 0)
      content += ",\n";

    content += `  };\n\n`;

    content += `  private static _multiLinkTargets: Record<string, string> = {\n`;
    content += multiLinkTargetEntries.join(",\n");

    if (multiLinkTargetEntries.length > 0)
      content += ",\n";

    content += `  };\n\n`;

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

    content += `  /** Select all ${typeName} objects */\n`;
    content += `  async select(shape?: string): Promise<${typeRef}[]> {\n`;
    content += `    const query = shape \n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape}\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * }\`;\n`;
    content += `    return await this.client.query<${typeRef}[]>(query);\n`;
    content += `  }\n\n`;

    content += `  /** Select ${typeName} by ID */\n`;
    content += `  async selectById(id: string, shape?: string): Promise<${typeRef} | null> {\n`;
    content += `    const query = shape\n`;
    content += `      ? \`select ${edgeqlTypeName} \${shape} filter .id = <uuid>$id\`\n`;
    content += `      : \`select ${edgeqlTypeName} { * } filter .id = <uuid>$id\`;\n`;
    content += `    const results = await this.client.query<${typeRef}[]>(query, { id });\n`;
    content += `    return results[0] || null;\n`;
    content += `  }\n\n`;

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

    content += `  /** Delete ${typeName} by ID */\n`;
    content += `  async delete(id: string): Promise<${typeRef}> {\n`;
    content += `    const query = \`delete ${edgeqlTypeName} filter .id = <uuid>$id\`;\n`;
    content += `    return await this.client.query<${typeRef}>(query, { id });\n`;
    content += `  }\n\n`;

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

  // -- Client ---------------------------------------------------------------

  private generateClient(): Types.GeneratedFile {
    let content = "";

    content += this.generateFileHeader("Disc Client");
    content += "\n";

    const multiModule = this.isMultiModule();

    const sdkBase = this.config.sdkImportBase ?? "./sdk/mod.ts";
    content += `import { DiscClient as BaseClient, type DiscClientConfig } from "${sdkBase}";\n`;
    content += `export type { DiscClientConfig } from "${sdkBase}";\n`;
    content += `export { and, AuthManager, not, or, SubscriptionClient } from "${sdkBase}";\n`;
    content += `import * as Queries from "./queries.ts";\n\n`;

    content += `/**\n`;
    content += ` * Type-safe Disc database client with query builders\n`;
    content += ` */\n`;
    content += `export class DiscClient extends BaseClient {\n`;

    const schemaEpoch = this.config.schemaEpoch;

    if (schemaEpoch !== undefined)
      content += `  static readonly SCHEMA_EPOCH = ${JSON.stringify(schemaEpoch)};\n\n`;

    if (multiModule) {
      for (const module of this.ir.modules) {
        if (module.objects.length === 0)
          continue;

        content += `  // ${module.name} module\n`;

        for (const obj of module.objects) {
          const builderName = `${this.getTypeScriptTypeName(obj.name.name)}QueryBuilder`;
          const propertyName = obj.name.name.toLowerCase();
          content += `  readonly ${propertyName}: Queries.${builderName};\n`;
        }
      }
    } else {
      for (const obj of this.allObjects()) {
        const builderName = `${this.getTypeScriptTypeName(obj.name.name)}QueryBuilder`;
        const propertyName = obj.name.name.toLowerCase();
        content += `  /** Query builder for ${obj.name.name} */\n`;
        content += `  readonly ${propertyName}: Queries.${builderName};\n`;
      }
    }

    content += `\n`;

    content += `  constructor(config?: DiscClientConfig) {\n`;
    content += `    super(config);\n`;

    if (schemaEpoch !== undefined)
      content += `    this.schemaEpoch = DiscClient.SCHEMA_EPOCH;\n`;

    for (const obj of this.allObjects()) {
      const builderName = `${this.getTypeScriptTypeName(obj.name.name)}QueryBuilder`;
      const propertyName = obj.name.name.toLowerCase();
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

  // -- Index ----------------------------------------------------------------

  private generateIndexFile(): Types.GeneratedFile {
    let content = "";

    content += this.generateFileHeader("Generated API");
    content += "\n";

    const multiModule = this.isMultiModule();
    const typesFile = multiModule ? "./interfaces.ts" : "./types.ts";

    content += `// Type definitions\n`;
    content += `export * from "${typesFile}";\n\n`;

    content += `// Query builders\n`;
    content += `export * from "./queries.ts";\n\n`;

    content += `// Client\n`;
    content += `export * from "./client.ts";\n\n`;

    content += `// SDK re-exports\n`;
    content += `export { and, AuthManager, not, or, SubscriptionClient } from "./client.ts";\n\n`;

    content += `// Default client export\n`;
    content += `import { DiscClient } from "./client.ts";\n`;
    content += `export default DiscClient;\n`;

    return {
      content: this.formatContent(content),
      path: `${this.config.outputDir}/index.ts`,
      type: "index"
    };
  }
}
