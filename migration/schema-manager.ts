/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema Manager - bridges SDL parsing, query compilation context, and migration planning
 *
 * Connects three currently disconnected systems:
 * - SDL parsing (schema/parser.ts + schema/converter.ts) -> Module[]
 * - Query compilation context (compiler/context.ts) -> Schema with TypeDef/PropertyDef/LinkDef
 * - Migration planning (migration/engine.ts) -> MigrationPlan
 */

import { adaptAccessPolicies } from "../access/policy-adapter.ts";
import { getBuiltinFunctions } from "../compiler/builtin-functions.ts";
import {
  AbstractAnnotationDef,
  AliasDef,
  GlobalDef,
  IndexDef,
  LinkDef,
  PropertyConstraint,
  PropertyDef,
  RewriteDef,
  Schema,
  TriggerDef,
  TypeDef
} from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationError } from "../lib/errors.ts";
import {
  propNameToColumnName,
  typeNameToTableName
} from "../lib/identifiers.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import {
  AccessPolicy as SDLAccessPolicy,
  AliasDeclaration,
  Annotation as SDLAnnotation,
  AnnotationDeclaration,
  Constraint as SDLConstraint,
  Expression,
  GlobalDeclaration,
  LinkDeclaration,
  ScalarTypeDeclaration,
  TriggerDeclaration,
  TypeDeclaration
} from "../schema/ast.ts";
import {
  Module,
  normalizeModules,
  SDLConverter
} from "../schema/converter.ts";
import { sdlExpressionToEdgeQL } from "../schema/expression-printer.ts";
import { SDLParser } from "../schema/parser.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

/**
 * SDL type name to SQL column type mapping
 */
const SDL_TO_SQL_TYPE_MAP: Record<string, string> = {
  str: "text",
  bool: "boolean",
  int16: "smallint",
  int32: "integer",
  int64: "bigint",
  float32: "real",
  float64: "double precision",
  bigint: "numeric",
  decimal: "numeric",
  uuid: "uuid",
  datetime: "timestamptz",
  duration: "interval",
  bytes: "bytea",
  json: "jsonb",
  sequence: "bigint",
  "cal::local_datetime": "timestamp",
  "cal::local_date": "date",
  "cal::local_time": "time",
  "cal::relative_duration": "interval",
  "cal::date_duration": "interval",
  // Array types
  "array<str>": "text[]",
  "array<int16>": "smallint[]",
  "array<int32>": "integer[]",
  "array<int64>": "bigint[]",
  "array<float32>": "real[]",
  "array<float64>": "double precision[]",
  "array<bool>": "boolean[]",
  "array<uuid>": "uuid[]",
  "array<datetime>": "timestamptz[]",
  "array<json>": "jsonb[]",
  "array<bytes>": "bytea[]",
  "array<bigint>": "numeric[]",
  "array<decimal>": "numeric[]",
  "array<cal::local_date>": "date[]",
  "array<cal::local_time>": "time[]",
  "array<cal::local_datetime>": "timestamp[]",
  // Range types
  "range<int32>": "int4range",
  "range<int64>": "int8range",
  "range<float64>": "numrange",
  "range<decimal>": "numrange",
  "range<datetime>": "tstzrange",
  "range<cal::local_date>": "daterange",
  "range<cal::local_datetime>": "tsrange",
  // Multirange types
  "multirange<int32>": "int4multirange",
  "multirange<int64>": "int8multirange",
  "multirange<float64>": "nummultirange",
  "multirange<decimal>": "nummultirange",
  "multirange<datetime>": "tstzmultirange",
  "multirange<cal::local_date>": "datemultirange",
  "multirange<cal::local_datetime>": "tsmultirange"
};

/**
 * Map an SDL type name to a SQL column type
 */
function sdlTypeToSqlType(sdlType: string): string {
  if (SDL_TO_SQL_TYPE_MAP[sdlType]) {
    return SDL_TO_SQL_TYPE_MAP[sdlType];
  }

  // Tuple types map to jsonb (PostgreSQL has no native tuple type)
  if (sdlType.startsWith("tuple<")) {
    return "jsonb";
  }

  return "text";
}

/**
 * Build a full SDL type string from a TypeRef, including type parameters.
 * For example: range<int32>, multirange<cal::local_date>
 */
function typeRefToSdlString(
  typeRef: {
    name: { parts: string[]; };
    params?: { name: { parts: string[]; }; params?: unknown[]; }[];
  }
): string {
  let result = typeRef.name.parts.join("::");
  if (typeRef.params && typeRef.params.length > 0) {
    result += `<${
      typeRef
        .params
        .map(p =>
          typeRefToSdlString(
            p as {
              name: { parts: string[]; };
              params?: { name: { parts: string[]; }; params?: unknown[]; }[];
            }
          )
        )
        .join(", ")
    }>`;
  }
  return result;
}

/**
 * Stringify an SDL Expression node into a human-readable string.
 * Used for rendering constraint arguments, trigger bodies, and
 * computed property expressions.
 */
function stringifyExpression(expr: Expression): string {
  switch (expr.kind) {
    case "Literal":
      if (typeof expr.value === "string") {
        return `'${expr.value}'`;
      }
      return String(expr.value);
    case "PathExpression": {
      // EdgeQL expression tokens (from parseEdgeQLExpression) are stored as
      // individual tokens in the path array. Detect them by checking whether
      // the first token is a query keyword and join with spaces instead of
      // dots so the expression round-trips correctly through the EdgeQL parser.
      const edgeqlKeywords = new Set([
        "select",
        "insert",
        "update",
        "delete",
        "with",
        "for",
        "group"
      ]);
      if (
        expr.path.length > 0 &&
        edgeqlKeywords.has(expr.path[0].toLowerCase())
      ) {
        return expr.path.join(" ");
      }
      // The SDL parser's parsePath emits `["", "name"]` style arrays where
      // separator dots and identifier tokens are interleaved (e.g. `.name`
      // → `[".", "name"]`). Joining with another `.` would double-up to
      // `..name`. Concatenate without a separator so the dots that the
      // tokenizer already captured stand in as the separators.
      if (expr.path.some(p => p === ".")) {
        return expr.path.join("");
      }
      return expr.path.join(".");
    }
    case "FunctionCall":
      return `${expr.name.parts.join("::")}(${expr.args.map(stringifyExpression).join(", ")})`;
    case "BinaryOp":
      return `${stringifyExpression(expr.left)} ${expr.op} ${stringifyExpression(expr.right)}`;
    case "UnaryOp":
      return `${expr.op} ${stringifyExpression(expr.operand)}`;
    case "TypeCast":
      return `<${expr.type.name.parts.join("::")}>${stringifyExpression(expr.expr)}`;
    case "Parameter":
      return `$${expr.name}`;
    case "ConditionalExpression":
      return `${stringifyExpression(expr.consequent)} if ${stringifyExpression(expr.test)} else ${stringifyExpression(expr.alternate)}`;
    case "TupleExpression":
      return `(${expr.elements.map(stringifyExpression).join(", ")})`;
    default:
      return String((expr as { value?: unknown; }).value ?? "");
  }
}

/**
 * Extract PropertyConstraint[] from SDL Constraint AST nodes.
 */
function extractPropertyConstraints(
  sdlConstraints: SDLConstraint[] | undefined
): PropertyConstraint[] | undefined {
  if (!sdlConstraints || sdlConstraints.length === 0) {
    return undefined;
  }

  return sdlConstraints.map(c => {
    const constraint: PropertyConstraint = {
      name: c.name?.value ?? "unknown"
    };
    if (c.args && c.args.length > 0) {
      constraint.args = c.args.map(stringifyExpression);
    }
    return constraint;
  });
}

function extractAnnotationMap(
  annotations: SDLAnnotation[] | undefined
): Record<string, string> | undefined {
  if (!annotations || annotations.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const ann of annotations) {
    const name = ann.name.parts.join("::");
    result[name] = ann.value ? stringifyExpression(ann.value) : "true";
  }
  return result;
}

export interface SchemaManagerOptions {
  pool?: ConnectionPool;
  dryRun?: boolean;
  onSchemaChange?: (schema: Schema) => void;
  /**
   * Optional progress listener forwarded to the underlying MigrationEngine.
   * Receives per-step events for plan/migration/DDL execution.
   * (gh/geldata#7490)
   */
  onProgress?: Types.MigrationProgressListener;
}

export class SchemaManager {
  private pool?: ConnectionPool;
  private dryRun: boolean;
  private engine?: MigrationEngine;
  private currentModules: Module[] | null = null;
  private currentSchema: Schema | null = null;
  private onSchemaChange?: (schema: Schema) => void;
  private onProgress?: Types.MigrationProgressListener;

  constructor(options: SchemaManagerOptions) {
    this.pool = options.pool;
    this.dryRun = options.dryRun ?? false;
    this.onSchemaChange = options.onSchemaChange;
    this.onProgress = options.onProgress;
  }

  /**
   * Parse SDL source text into Module[] representation.
   *
   * Creates an SDLParser to tokenize and parse the source into an SDLDocument,
   * then uses SDLConverter to normalize into Module[].
   */
  parseSDL(source: string): Result<Module[], MigrationError> {
    try {
      // P2-06: parse with error recovery so all SDL syntax errors surface
      // in a single MigrationError message instead of just the first one.
      // Callers that previously matched on the first-error string will
      // still find their error in the multi-line list.
      const parser = new SDLParser(source);
      const { document, errors } = parser.parseWithRecovery();
      if (errors.length > 0) {
        const lines = errors
          .map(e => {
            const hint = e.context?.hint;
            return hint ?
              `  • ${e.message}\n      Hint: ${hint}` :
              `  • ${e.message}`;
          })
          .join("\n");
        return Err(
          new MigrationError(
            `Failed to parse SDL (${errors.length} error${errors.length === 1 ? "" : "s"}):\n${lines}`
          )
        );
      }
      const converter = new SDLConverter();
      const modules = converter.convertToModules(document);
      return Ok(modules);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to parse SDL: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Convert Module[] (SDL AST) into a Schema suitable for the query compiler.
   *
   * This is a pure bridge function with no side effects. It iterates through
   * each module's TypeDeclarations and converts them into TypeDef objects
   * with PropertyDef and LinkDef maps.
   */
  modulesToSchema(modules: Module[]): Schema {
    const types = new Map<string, TypeDef>();
    const aliases = new Map<string, AliasDef>();
    const globals = new Map<string, GlobalDef>();
    const abstractAnnotations = new Map<string, AbstractAnnotationDef>();
    const converter = new SDLConverter();

    // First pass: collect abstract link and annotation declarations, plus a
    // global set of object type names. The SDL parser uses arrow shorthand
    // (`name -> Type`) for both scalar properties and object links — only
    // the target type's kind can distinguish them, and that's a
    // cross-module question. We need every object type's name (bare AND
    // module-qualified) before extracting members so link-vs-property
    // classification works regardless of declaration order.
    const abstractLinks = new Map<string, LinkDeclaration>();
    const objectTypeNames = new Set<string>();
    for (const module of modules) {
      for (const item of module.items) {
        // Collect abstract annotation declarations
        if (item.kind === "AnnotationDeclaration") {
          const annDecl = item as AnnotationDeclaration;
          const annName = annDecl.name.value;
          const annDef: AbstractAnnotationDef = { name: annName };
          if (annDecl.type) {
            annDef.type = annDecl.type.name.parts.join("::");
          }
          abstractAnnotations.set(annName, annDef);
        }

        if (
          item.kind === "LinkDeclaration" &&
          (item as LinkDeclaration).abstract
        ) {
          const linkDecl = item as LinkDeclaration;
          abstractLinks.set(linkDecl.name.value, linkDecl);
        }

        if (item.kind === "TypeDeclaration") {
          const name = (item as TypeDeclaration).name.value;
          objectTypeNames.add(name);
          objectTypeNames.add(`${module.name}::${name}`);
        }
      }
    }

    for (const module of modules) {
      for (const item of module.items) {
        // Handle alias declarations
        if (item.kind === "AliasDeclaration") {
          const aliasDecl = item as AliasDeclaration;
          const aliasName = aliasDecl.name.value;
          const expression = stringifyExpression(aliasDecl.using);

          // Attempt to detect targetType from the expression.
          // If the expression is a PathExpression starting with a type name,
          // or a select/filter over a type, extract that type name.
          let targetType: string | undefined;
          if (aliasDecl.using.kind === "PathExpression") {
            // e.g., alias := User  or  alias := User.posts
            const firstSegment = aliasDecl.using.path[0];
            if (firstSegment && /^[A-Z]/.test(firstSegment)) {
              targetType = firstSegment;
            }
          } else if (aliasDecl.using.kind === "FunctionCall") {
            // Could be a select-like function, check first arg
            if (aliasDecl.using.args.length > 0) {
              const firstArg = aliasDecl.using.args[0];
              if (
                firstArg.kind === "PathExpression" &&
                firstArg.path[0] &&
                /^[A-Z]/.test(firstArg.path[0])
              ) {
                targetType = firstArg.path[0];
              }
            }
          }

          const aliasDef: AliasDef = {
            name: aliasName,
            expression
          };
          if (targetType) {
            aliasDef.targetType = targetType;
          }

          const aliasKey = module.name === "default" ?
            aliasName :
            `${module.name}::${aliasName}`;
          aliases.set(aliasKey, aliasDef);
          continue;
        }

        // Handle global declarations
        if (item.kind === "GlobalDeclaration") {
          const globalDecl = item as GlobalDeclaration;
          const globalName = globalDecl.name.value;
          const moduleName = module.name;
          const qualifiedName = `${moduleName}::${globalName}`;
          const edgeqlType = typeRefToSdlString(globalDecl.type);
          const pgType = sdlTypeToSqlType(edgeqlType);

          const globalDef: GlobalDef = {
            name: globalName,
            module: moduleName,
            type: edgeqlType,
            pgType,
            required: globalDecl.required ?? false,
            multi: globalDecl.multi ?? false,
            readonly: globalDecl.readonly ?? false,
            pgSettingName: `disc.global_${moduleName}__${globalName}`
          };

          if (globalDecl.default) {
            globalDef.default = stringifyExpression(globalDecl.default);
          }

          globals.set(qualifiedName, globalDef);
          continue;
        }

        // Handle scalar enum types
        if (item.kind === "ScalarTypeDeclaration") {
          const scalarDecl = item as ScalarTypeDeclaration;
          const scalarName = scalarDecl.name.value;

          // Detect enum scalars: scalar type Status extending enum<...>
          // The extending TypeRef name will be "enum" if the parser captured it
          const enumExt = scalarDecl.extending?.find(
            ext => ext.name.parts[0] === "enum"
          );
          if (enumExt) {
            // The SDL parser wraps each `"VALUE"` literal as a TypeRef whose
            // qualified name is the string value (see `parseTypeParam` in
            // schema/parser.ts). Pull the values back out so the runtime
            // Schema knows what the enum accepts — without this, codegen,
            // drift detection, and the EdgeQL→SQL compiler's enum-cast
            // path can't tell the type apart from any other unknown name.
            const enumValues = (enumExt.params ?? []).map(p => p.name.parts.join("::"));
            const enumDef: TypeDef = {
              name: scalarName,
              kind: "enum",
              tableName: typeNameToTableName(scalarName),
              properties: new Map(),
              links: new Map(),
              enumValues,
              module: module.name
            };
            // Store under the bare name so `<LogLevel>` lookups in cast
            // expressions resolve regardless of which module declared the
            // enum. Also store under the module-qualified name so existing
            // call sites that pass `logger::LogLevel` still find it.
            types.set(scalarName, enumDef);
            if (module.name !== "default") {
              types.set(`${module.name}::${scalarName}`, enumDef);
            }
          }

          continue;
        }

        if (item.kind !== "TypeDeclaration") {
          continue;
        }

        const typeDecl = item as TypeDeclaration;
        const typeName = typeDecl.name.value;
        const tableName = typeNameToTableName(typeName);

        // Start with implicit id property
        const properties = new Map<string, PropertyDef>();
        properties.set("id", {
          name: "id",
          type: "uuid",
          required: true,
          multi: false,
          columnName: "id"
        });

        const links = new Map<string, LinkDef>();

        // Extract properties from the type declaration
        const propDeclarations = converter.extractProperties(typeDecl);
        for (const propDecl of propDeclarations) {
          const propName = propDecl.name.value;
          const sdlTypeName = typeRefToSdlString(propDecl.type);

          // Reclassify: SDL colon-form `name: ObjectType` parses as a
          // PropertyDeclaration but is semantically a link whenever the
          // target is an object type. Build a LinkDef so DDL lays down a
          // proper FK column (not a `text` column with the class name as a
          // string) and codegen routes the reference through namespace-aware
          // type resolution. Mirrors the arrow-shorthand reclassification
          // below (which handles `name -> ScalarType` in the inverse
          // direction).
          const isObjectTarget = objectTypeNames.has(sdlTypeName) ||
            objectTypeNames.has(sdlTypeName.replace(/^default::/, ""));
          if (isObjectTarget && !propDecl.computed) {
            const linkAnnotations = extractAnnotationMap(propDecl.annotations);
            const isMultiLink = propDecl.multi ?? false;
            links.set(propName, {
              name: propName,
              target: sdlTypeName,
              required: propDecl.required ?? false,
              multi: isMultiLink,
              // Same column convention as the LinkDeclaration branch below:
              // single links live in a snake_case `<name>_id` FK column,
              // multi links in a junction table (no inline column).
              columnName: isMultiLink ?
                undefined :
                `${propNameToColumnName(propName)}_id`,
              computed: propDecl.computed !== undefined,
              annotations: linkAnnotations
            });
            continue;
          }

          const sqlType = sdlTypeToSqlType(sdlTypeName);

          const constraints = extractPropertyConstraints(
            propDecl.constraints
          );

          // Extract rewrites from the property declaration
          const rewrites: RewriteDef[] | undefined = propDecl.rewrites && propDecl.rewrites.length > 0 ?
            propDecl.rewrites.map(r => ({
              events: [...r.events],
              body: r.using
            })) :
            undefined;

          const propAnnotations = extractAnnotationMap(
            propDecl.annotations
          );

          // Stringify the computed expression so the compiler can re-parse
          // and inline it at shape-element resolution. Without this, a
          // computed property like `expires := .created + ...` would emit
          // a column reference to a non-existent `expires` column.
          const computedExpr = propDecl.computed ?
            sdlExpressionToEdgeQL(propDecl.computed) :
            undefined;

          properties.set(propName, {
            name: propName,
            type: sqlType,
            required: propDecl.required ?? false,
            multi: propDecl.multi ?? false,
            columnName: propNameToColumnName(propName),
            edgeqlType: sdlTypeName,
            readonly: propDecl.readonly ?? false,
            hasDefault: propDecl.default !== undefined,
            computed: propDecl.computed !== undefined,
            computedExpr,
            constraints,
            rewrites,
            annotations: propAnnotations
          });
        }

        // Extract links from the type declaration, resolving link inheritance
        const linkDeclarations = converter.extractLinks(typeDecl);
        for (const linkDecl of linkDeclarations) {
          // Resolve link inheritance: merge properties and constraints
          // from abstract links into this concrete link
          if (linkDecl.extending) {
            for (const baseRef of linkDecl.extending) {
              const baseName = baseRef.name.parts.join("::");
              const abstractLink = abstractLinks.get(baseName);
              if (!abstractLink) {
                continue;
              }

              // Merge inherited properties (concrete wins)
              if (abstractLink.properties) {
                const ownPropNames = new Set(
                  (linkDecl.properties ?? []).map(p => p.name.value)
                );
                const inherited = abstractLink.properties.filter(
                  p => !ownPropNames.has(p.name.value)
                );
                if (inherited.length > 0) {
                  if (!linkDecl.properties) {
                    linkDecl.properties = [];
                  }
                  linkDecl.properties.push(...inherited);
                }
              }

              // Merge inherited constraints
              if (abstractLink.constraints) {
                if (!linkDecl.constraints) {
                  linkDecl.constraints = [];
                }
                linkDecl.constraints.push(...abstractLink.constraints);
              }
            }
          }

          const linkName = linkDecl.name.value;
          const targetName = linkDecl.target.name.parts.join("::");
          const isMulti = linkDecl.multi ?? false;

          const linkAnnotations = extractAnnotationMap(
            linkDecl.annotations
          );

          // Reclassify: SDL arrow shorthand `name -> ScalarType` parses as
          // a LinkDeclaration but is semantically a property whenever the
          // target isn't an object type. Build a PropertyDef directly from
          // the LinkDecl AST so the body's default/readonly/constraints
          // carry over (they're captured by parseLinkBody).
          const isObjectTarget = objectTypeNames.has(targetName) ||
            objectTypeNames.has(targetName.replace(/^default::/, ""));
          if (!isObjectTarget) {
            const sqlType = sdlTypeToSqlType(targetName);
            const linkConstraints = extractPropertyConstraints(
              linkDecl.constraints
            );
            properties.set(linkName, {
              name: linkName,
              type: sqlType,
              required: linkDecl.required ?? false,
              multi: isMulti,
              columnName: propNameToColumnName(linkName),
              edgeqlType: targetName,
              readonly: linkDecl.readonly ?? false,
              hasDefault: linkDecl.default !== undefined,
              computed: linkDecl.computed !== undefined,
              constraints: linkConstraints,
              annotations: linkAnnotations
            });
            continue;
          }

          links.set(linkName, {
            name: linkName,
            target: targetName,
            required: linkDecl.required ?? false,
            multi: isMulti,
            // FK column name is snake_case so Postgres' unquoted-identifier
            // lowercasing doesn't break round-tripping (e.g. `payoutAddresses_id`
            // would lowercase to `payoutaddresses_id` and miss the column).
            columnName: isMulti ?
              undefined :
              `${propNameToColumnName(linkName)}_id`,
            computed: linkDecl.computed ? true : undefined,
            annotations: linkAnnotations
          });
        }

        // Extract access policies from the type declaration
        const sdlPolicies = typeDecl.members.filter(
          (m): m is SDLAccessPolicy => m.kind === "AccessPolicy"
        );
        const accessPolicies = sdlPolicies.length > 0 ?
          adaptAccessPolicies(typeName, sdlPolicies) :
          undefined;

        // Extract indexes from the type declaration. SDL `index on (.foo)`
        // surfaces here as `AST.Index` members; we stringify the `on`
        // expression via the existing helper so the EdgeQL compiler and
        // introspection endpoint can both render them.
        const indexDecls = converter.extractIndexes(typeDecl);
        const indexes: IndexDef[] | undefined = indexDecls.length > 0 ?
          indexDecls.map(idx => ({
            name: idx.name?.value,
            expression: stringifyExpression(idx.on)
          })) :
          undefined;

        // Extract triggers from the type declaration
        const triggerDecls = typeDecl.members.filter(
          (m): m is TriggerDeclaration => m.kind === "TriggerDeclaration"
        );
        const triggers: TriggerDef[] | undefined = triggerDecls.length > 0 ?
          triggerDecls.map(t => ({
            name: t.name.value,
            timing: t.timing,
            events: [...t.events],
            scope: t.scope,
            body: stringifyExpression(t.body)
          })) :
          undefined;

        // Extract inheritance info from SDL AST
        const isAbstract = typeDecl.abstract ?? false;
        const parentTypeNames = typeDecl.extending?.map(
          ext => ext.name.parts.join("::")
        );

        // Extract type-level annotations from type members
        const typeAnnotationMembers = typeDecl.members.filter(
          (m): m is SDLAnnotation => m.kind === "Annotation"
        );
        const typeAnnotations = extractAnnotationMap(
          typeAnnotationMembers.length > 0 ? typeAnnotationMembers : undefined
        );

        const typeDef: TypeDef = {
          name: typeName,
          kind: "object",
          tableName,
          properties,
          links,
          accessPolicies,
          triggers,
          annotations: typeAnnotations,
          indexes
        };

        if (isAbstract) {
          typeDef.abstract = true;
        }
        if (parentTypeNames && parentTypeNames.length > 0) {
          typeDef.parentTypes = parentTypeNames;
        }

        typeDef.module = module.name;
        const typeKey = module.name === "default" ?
          typeName :
          `${module.name}::${typeName}`;
        types.set(typeKey, typeDef);
      }
    }

    // Second pass: resolve type hierarchy — populate subtypes, merge
    // inherited properties/links, and set discriminator columns.
    // Supports multiple inheritance: each parent contributes properties/links.
    for (const [_typeName, typeDef] of types) {
      if (!typeDef.parentTypes || typeDef.parentTypes.length === 0) {
        continue;
      }

      for (const parentName of typeDef.parentTypes) {
        // Look up by literal name first, then strip a `default::` prefix —
        // types in the default module are stored under their bare key (see
        // line 737-740), so `extending default::BaseRecord` from another
        // module would otherwise silently fail to find its parent.
        let parentDef = types.get(parentName);
        if (!parentDef && parentName.startsWith("default::")) {
          parentDef = types.get(parentName.slice("default::".length));
        }
        if (!parentDef) {
          continue;
        }

        // Register this type as a subtype of each parent
        if (!parentDef.subtypes) {
          parentDef.subtypes = [];
        }
        parentDef.subtypes.push(typeDef.name);

        // Set discriminator column on parent
        parentDef.discriminatorColumn = "__type__";

        // Merge inherited properties: add parent props that child doesn't have
        for (const [propName, propDef] of parentDef.properties) {
          if (!typeDef.properties.has(propName)) {
            typeDef.properties.set(propName, { ...propDef });
          }
        }

        // Merge inherited links: add parent links that child doesn't have
        for (const [linkName, linkDef] of parentDef.links) {
          if (!typeDef.links.has(linkName)) {
            typeDef.links.set(linkName, { ...linkDef });
          }
        }
      }
    }

    // Third pass: resolve backlinks and junction tables for multi-links.
    // For each type's multi-link, check if the target type has a single
    // link pointing back (backlink) or a reciprocal multi-link
    // (many-to-many via junction table).
    const resolvedJunctions = new Set<string>();

    // Cross-module-aware lookup: SDL stores `linkDef.target` verbatim from
    // the source text (often unqualified, e.g. `multi options -> PaymentOption`
    // from inside `payment::`), but `types` is keyed by qualified name for
    // non-default modules. Try the verbatim key, then a same-module qualified
    // key (so `PaymentOption` resolves to `payment::PaymentOption` when the
    // owner is in `payment::`), and finally strip a `default::` prefix.
    const resolveLinkTarget = (
      target: string,
      ownerModule: string | undefined
    ): TypeDef | undefined => {
      const direct = types.get(target);
      if (direct)
        return direct;
      if (!target.includes("::") && ownerModule && ownerModule !== "default") {
        const qualified = types.get(`${ownerModule}::${target}`);
        if (qualified)
          return qualified;
      }
      if (target.startsWith("default::")) {
        return types.get(target.slice("default::".length));
      }
      return undefined;
    };

    for (const [typeName, typeDef] of types) {
      for (const [_linkName, linkDef] of typeDef.links) {
        if (!linkDef.multi) {
          continue;
        }

        const targetTypeDef = resolveLinkTarget(linkDef.target, typeDef.module);
        if (!targetTypeDef) {
          continue;
        }

        // First try: single-link backlink on the target type. Resolve each
        // candidate's `target` (often unqualified in SDL) to its TypeDef and
        // compare by reference — comparing the raw string against `typeName`
        // breaks across modules (`PaymentOption` vs `payment::PaymentOption`).
        let foundBacklink = false;
        for (const [candidateName, candidateLink] of targetTypeDef.links) {
          if (candidateLink.multi)
            continue;
          const candidateTarget = resolveLinkTarget(
            candidateLink.target,
            targetTypeDef.module
          );
          if (candidateTarget === typeDef) {
            linkDef.backlink = candidateName;
            foundBacklink = true;
            break;
          }
        }

        // Second try: many-to-many — target has a reciprocal multi-link
        if (!foundBacklink) {
          // If the reciprocal pass already assigned this link a canonical
          // junction table (with swapped source/target columns), don't
          // overwrite — that would break the agreement that both sides
          // share one physical junction table.
          if (linkDef.junctionTable) {
            continue;
          }
          const tableName = typeDef.tableName;
          const junctionTable = `${tableName}_${linkDef.name}`;

          linkDef.junctionTable = junctionTable;
          linkDef.junctionSourceColumn = "source_id";
          linkDef.junctionTargetColumn = "target_id";

          // Mark the reciprocal link on the target type if it exists
          for (
            const [_candidateName, candidateLink] of targetTypeDef.links
          ) {
            if (!candidateLink.multi)
              continue;
            const candidateTarget = resolveLinkTarget(
              candidateLink.target,
              targetTypeDef.module
            );
            if (candidateTarget === typeDef) {
              // Use canonical ordering to avoid duplicate junction tables:
              // the junction table belongs to whichever type comes first
              // alphabetically
              const pairKey = [typeName, linkDef.target].sort().join("|");
              if (!resolvedJunctions.has(pairKey)) {
                resolvedJunctions.add(pairKey);
                // The reciprocal link uses the OTHER side's junction table
                // with swapped source/target columns
                candidateLink.junctionTable = junctionTable;
                candidateLink.junctionSourceColumn = "target_id";
                candidateLink.junctionTargetColumn = "source_id";
              }
              break;
            }
          }
        }
      }
    }

    const schema: Schema = {
      types,
      functions: getBuiltinFunctions()
    };
    if (aliases.size > 0) {
      schema.aliases = aliases;
    }
    if (globals.size > 0) {
      schema.globals = globals;
    }
    if (abstractAnnotations.size > 0) {
      schema.abstractAnnotations = abstractAnnotations;
    }
    return schema;
  }

  /**
   * Parse SDL source, diff against current schema, plan and optionally execute
   * a migration, then update internal state.
   *
   * Returns the migration results on success.
   */
  async applySchema(
    sdlSource: string,
    options?: { allowUnsafe?: boolean; skipHistory?: boolean; }
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    // Parse SDL
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }
    // Reclassify arrow shorthand `name -> ScalarType` as properties before
    // the differ sees the AST. Without this, the differ treats every arrow
    // as a link and emits FK constraints to non-existent scalar tables
    // (e.g. `REFERENCES datetime (id)`).
    const newModules = normalizeModules(parseResult.value);

    // Ensure engine exists
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before applySchema()."
        )
      );
    }

    // Hash-fallback baseline check (see applyModules for details).
    if (
      this.currentModules === null &&
      this.engine.appliedMigrationCount() > 0
    ) {
      const latestHash = this.engine.getLatestAppliedSchemaHash();
      const newHash = this.engine.hashSchemaForBaseline(newModules);
      if (latestHash !== null && latestHash === newHash) {
        this.currentModules = newModules;
        this.currentSchema = this.modulesToSchema(newModules);
        this.onSchemaChange?.(this.currentSchema);
        return Ok([]);
      }
      if (latestHash !== null && latestHash !== newHash) {
        return Err(
          new MigrationError(
            "Schema changes detected but the applied baseline can't be reconstructed: " +
              "the latest disc_migrations row was recorded before schema snapshots were stored. " +
              "Re-apply the existing schema once to record a baseline, then re-run `disc migrate`. " +
              "If the database is empty / stale, delete the disc_migrations table and retry."
          )
        );
      }
    }

    // Plan migration: diff currentModules vs newModules
    const planResult = this.engine.planMigration(
      this.currentModules,
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }
    const plan = planResult.value;

    // Early-return for no-op plans (no operations to apply). See
    // applyModules() for the same guard — keeps disc_migrations clean
    // when a fresh process re-applies an unchanged schema.
    if (plan.operationsCount === 0) {
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);
      return Ok([]);
    }

    // gh/geldata#1838 + gh/geldata#1840: refuse data-destroying *and*
    // ambiguous ops by default. Callers pass `{ allowUnsafe: true }` to
    // bypass — the CLI exposes this via `--unsafe`. Dry-run still
    // surfaces the list (caller renders it) but doesn't refuse, since
    // dry-run mutates nothing.
    if (!options?.allowUnsafe && !this.dryRun) {
      const flagged = this.engine.classifyUnsafeOperations(plan);
      if (flagged.length > 0) {
        const lines = flagged.map(u => `  - [${u.classification}] ${u.operation}: ${u.reason}`);
        const unsafeCount = flagged.filter(u => u.classification === "unsafe").length;
        const ambiguousCount = flagged.length - unsafeCount;
        const summary = [
          unsafeCount > 0 ? `${unsafeCount} unsafe` : null,
          ambiguousCount > 0 ? `${ambiguousCount} ambiguous` : null
        ]
          .filter(Boolean)
          .join(" + ");
        return Err(
          new MigrationError(
            `Migration contains ${summary} operation(s):\n${lines.join("\n")}\n\nPass { allowUnsafe: true } (or --unsafe at the CLI) to apply anyway.`
          )
        );
      }
    }

    // If dryRun, skip execution
    if (this.dryRun) {
      // Update internal state even in dry-run so subsequent calls see the new schema
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);

      // Return synthetic results for each planned migration
      const results: Types.MigrationResult[] = plan.migrations.map(m => ({
        success: true,
        migrationId: m.id,
        appliedAt: new Date(),
        durationMs: 0
      }));
      return Ok(results);
    }

    // Execute the migration plan. `skipHistory` (gh/geldata#3761) is
    // the `db push` path — DDL still applies, but the engine doesn't
    // record the migration in `disc_migrations`.
    const execResult = await this.engine.executeMigration(plan, {
      skipHistory: options?.skipHistory,
      postStateModules: newModules
    });
    if (!execResult.ok) {
      return execResult;
    }

    // Update internal state on success
    this.currentModules = newModules;
    this.currentSchema = this.modulesToSchema(newModules);
    this.onSchemaChange?.(this.currentSchema);

    return execResult;
  }

  /**
   * Parse SDL and generate a migration plan without executing it.
   *
   * This is the planning-only path used by `disc migrate --create`. It parses
   * the SDL source, diffs against the current schema state, and returns the
   * resulting MigrationPlan. No DDL is executed and no internal state is
   * mutated.
   */
  planSchema(
    sdlSource: string
  ): Result<Types.MigrationPlan, MigrationError> {
    // Parse SDL
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }
    // Reclassify scalar arrows as properties so the differ doesn't emit
    // FK constraints to scalar "tables".
    const newModules = normalizeModules(parseResult.value);

    // Ensure engine exists
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before planSchema()."
        )
      );
    }

    // Plan migration: diff currentModules vs newModules
    return this.engine.planMigration(this.currentModules, newModules);
  }

  /**
   * Apply pre-parsed Module[] (multi-file schema path).
   *
   * Mirrors `applySchema()` but skips the parseSDL step — callers that have
   * already merged Module arrays from multiple `.disc` files (via
   * `Codegen.loadMultiFileSchemaModules`) feed them straight in. Diff,
   * unsafe-op gating, dry-run handling, and engine execution behave
   * identically to `applySchema()`.
   */
  async applyModules(
    rawModules: Module[],
    options?: { allowUnsafe?: boolean; skipHistory?: boolean; }
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before applyModules()."
        )
      );
    }

    // Reclassify scalar arrows as properties so the differ doesn't emit
    // FK constraints to scalar "tables".
    const newModules = normalizeModules(rawModules);

    // Hash-fallback baseline check: when `currentModules` couldn't be
    // primed (latest applied migration row pre-dates the schema_modules
    // column) but the engine has applied migrations recorded, comparing
    // the new schema's hash against the latest applied schema_hash lets
    // us detect the no-op case without a baseline. Without this, we'd
    // diff against null and emit "create everything" ops that collide
    // with existing types/tables.
    if (
      this.currentModules === null &&
      this.engine.appliedMigrationCount() > 0
    ) {
      const latestHash = this.engine.getLatestAppliedSchemaHash();
      const newHash = this.engine.hashSchemaForBaseline(newModules);
      if (latestHash !== null && latestHash === newHash) {
        // No-op: schema unchanged since last migrate. Adopt newModules
        // as the baseline so subsequent calls on this instance don't
        // re-trigger the fallback, and backfill the row in disc_migrations
        // so future runs prime directly from schema_modules.
        this.currentModules = newModules;
        this.currentSchema = this.modulesToSchema(newModules);
        this.onSchemaChange?.(this.currentSchema);
        if (!this.dryRun) {
          await this.engine.backfillLatestAppliedModules(newModules);
        }
        return Ok([]);
      }
      if (latestHash !== null && latestHash !== newHash) {
        return Err(
          new MigrationError(
            "Schema changes detected but the applied baseline can't be reconstructed: " +
              "the latest disc_migrations row was recorded before schema snapshots were stored. " +
              "Re-apply the existing schema once to record a baseline, then re-run `disc migrate`. " +
              "If the database is empty / stale, delete the disc_migrations table and retry."
          )
        );
      }
    }

    const planResult = this.engine.planMigration(
      this.currentModules,
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }
    const plan = planResult.value;

    // Early-return for no-op plans: the differ found zero changes
    // between the current baseline and the new schema. Without this,
    // executeMigration would still record an empty row in disc_migrations
    // (no DDL runs, but the bookkeeping insert fires), bloating history
    // with synthetic "nothing changed" entries on every re-apply.
    if (plan.operationsCount === 0) {
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);
      return Ok([]);
    }

    if (!options?.allowUnsafe && !this.dryRun) {
      const flagged = this.engine.classifyUnsafeOperations(plan);
      if (flagged.length > 0) {
        const lines = flagged.map(u => `  - [${u.classification}] ${u.operation}: ${u.reason}`);
        const unsafeCount = flagged.filter(u => u.classification === "unsafe").length;
        const ambiguousCount = flagged.length - unsafeCount;
        const summary = [
          unsafeCount > 0 ? `${unsafeCount} unsafe` : null,
          ambiguousCount > 0 ? `${ambiguousCount} ambiguous` : null
        ]
          .filter(Boolean)
          .join(" + ");
        return Err(
          new MigrationError(
            `Migration contains ${summary} operation(s):\n${lines.join("\n")}\n\nPass { allowUnsafe: true } (or --unsafe at the CLI) to apply anyway.`
          )
        );
      }
    }

    if (this.dryRun) {
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);

      const results: Types.MigrationResult[] = plan.migrations.map(m => ({
        success: true,
        migrationId: m.id,
        appliedAt: new Date(),
        durationMs: 0
      }));
      return Ok(results);
    }

    const execResult = await this.engine.executeMigration(plan, {
      skipHistory: options?.skipHistory,
      postStateModules: newModules
    });
    if (!execResult.ok) {
      return execResult;
    }

    this.currentModules = newModules;
    this.currentSchema = this.modulesToSchema(newModules);
    this.onSchemaChange?.(this.currentSchema);

    return execResult;
  }

  /**
   * Plan a migration from pre-parsed Module[] without executing.
   *
   * Multi-file twin of `planSchema()`. Used by `disc migrate --create
   * --schema-dir` to generate a plan from merged module arrays.
   */
  planModules(
    rawModules: Module[]
  ): Result<Types.MigrationPlan, MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before planModules()."
        )
      );
    }

    const newModules = normalizeModules(rawModules);
    return this.engine.planMigration(this.currentModules, newModules);
  }

  /**
   * Extract DDL statements from a migration plan.
   *
   * Pass-through to the migration engine's DDL generator. Returns the array
   * of SQL strings that would be executed if the plan were applied.
   */
  generateDDL(
    plan: Types.MigrationPlan
  ): Result<string[], MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before generateDDL()."
        )
      );
    }

    return this.engine.generateDDL(plan);
  }

  /**
   * Validate that a migration plan is safe to apply.
   *
   * Delegates to the migration engine's validation logic which checks for
   * breaking changes, data loss risks, and structural issues. Returns
   * ok(undefined) when the plan passes validation.
   */
  validateMigration(
    plan: Types.MigrationPlan
  ): Result<void, MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before validateMigration()."
        )
      );
    }

    const result = this.engine.validateMigration(plan);
    if (!result.ok) {
      return result;
    }

    // Engine returns Result<boolean>, normalize to Result<void>
    return Ok(undefined);
  }

  /**
   * Rollback the most recently applied migration.
   *
   * Loads the latest migration from the tracker and delegates rollback
   * execution to the migration engine. Warning: rolling back a DROP TABLE
   * cannot restore data.
   */
  async rollbackLastMigration(): Promise<Result<void, MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before rollbackLastMigration()."
        )
      );
    }

    return await this.engine.executeRollback(await this.getLatestMigrationId());
  }

  /**
   * Rollback all migrations applied after the specified migration ID.
   * The target migration itself is preserved.
   */
  async rollbackToMigration(
    migrationId: string
  ): Promise<Result<void, MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before rollbackToMigration()."
        )
      );
    }

    return await this.engine.executeRollbackTo(migrationId);
  }

  /**
   * Get migration status information.
   */
  async getMigrationStatus(): Promise<
    Result<
      {
        applied: number;
        currentSchemaHash: string | null;
        latestMigration: {
          id: string;
          name: string;
          appliedAt: Date;
        } | null;
      },
      MigrationError
    >
  > {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before getMigrationStatus()."
        )
      );
    }

    const statusResult = await this.engine.getMigrationStatus();
    if (!statusResult.ok) {
      return statusResult;
    }

    const status = statusResult.value;
    return Ok({
      applied: status.applied,
      currentSchemaHash: status.currentSchemaHash,
      latestMigration: status.latestMigration ?
        {
          id: status.latestMigration.id,
          name: status.latestMigration.name,
          appliedAt: status.latestMigration.appliedAt
        } :
        null
    });
  }

  /**
   * Detect connections from a running Disc server attached to the
   * same database (gh/geldata#9034). Used by `disc migrate` as a
   * preflight: if a server is connected, its in-memory schema cache
   * will go stale after migration unless the operator triggers a
   * reload. Returns the list of `(pid, application_name)` pairs the
   * scan found. Best-effort — silently returns an empty list on
   * permission errors (operator may have restricted
   * `pg_stat_activity`).
   */
  async detectRunningServers(): Promise<
    Result<Array<{ pid: number; applicationName: string; }>, MigrationError>
  > {
    if (!this.pool) {
      // Dry-run / no pool — nothing to probe.
      return Ok([]);
    }
    try {
      const conn = await this.pool.acquire();
      try {
        // Filter to disc-server tagged connections that aren't this
        // CLI session. `pg_backend_pid()` excludes our own row even
        // though our app name should be `disc-cli`.
        const result = await conn.query(
          `SELECT pid, COALESCE(application_name, '') AS application_name
             FROM pg_stat_activity
            WHERE application_name = 'disc-server'
              AND pid <> pg_backend_pid()`
        );
        const rows = result.rows.map(r => ({
          pid: Number((r as Record<string, unknown>).pid),
          applicationName: String(
            (r as Record<string, unknown>).application_name
          )
        }));
        return Ok(rows);
      } finally {
        this.pool.release(conn);
      }
    } catch (err) {
      // pg_stat_activity may be restricted on hardened deployments;
      // fail soft so the migration itself isn't blocked.
      return Err(
        new MigrationError(
          `running-server probe failed: ${(err as Error).message}`
        )
      );
    }
  }

  /**
   * Preview the migration operations that would run if the given SDL
   * were applied against the current state, without executing them.
   * Used by `disc migrate --status` to surface drift between the SDL
   * file on disk and the applied schema (gh/geldata#8899).
   */
  previewMigrationOps(
    sdlSource: string
  ): Result<Types.MigrationOperation[], MigrationError> {
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }

    return this.previewMigrationOpsFromModules(parseResult.value);
  }

  /**
   * Multi-file twin of `previewMigrationOps()`. Skips the parseSDL step so
   * callers that already merged Module[] from several `.disc` files (via
   * `Codegen.loadMultiFileSchemaModules`) can drift-check without
   * re-serializing back to SDL.
   */
  previewMigrationOpsFromModules(
    rawModules: Module[]
  ): Result<Types.MigrationOperation[], MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before previewMigrationOpsFromModules()."
        )
      );
    }

    const newModules = normalizeModules(rawModules);
    const planResult = this.engine.planMigration(
      this.currentModules,
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }

    const ops: Types.MigrationOperation[] = [];
    for (const m of planResult.value.migrations) {
      ops.push(...m.operations);
    }
    return Ok(ops);
  }

  /**
   * Get full migration history, ordered by applied_at DESC.
   */
  async getMigrationHistory(): Promise<
    Result<Types.MigrationHistoryEntry[], MigrationError>
  > {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before getMigrationHistory()."
        )
      );
    }

    return await this.engine.getMigrationHistory();
  }

  /**
   * Get the ID of the latest applied migration. Throws if no migrations exist.
   */
  private async getLatestMigrationId(): Promise<string> {
    const statusResult = await this.engine!.getMigrationStatus();
    if (!statusResult.ok) {
      throw statusResult.error;
    }

    const latest = statusResult.value.latestMigration;
    if (!latest) {
      throw new MigrationError("No migrations have been applied");
    }

    return latest.id;
  }

  /**
   * Prime the SchemaManager's "currently applied" baseline from an
   * existing SDL string without running any migrations. Used by the
   * live-schema-diff admin endpoint (Bundle K — Disc #3a) so a fresh
   * SchemaManager instance per request can still produce a correct
   * diff against the running server's schema.
   *
   * Returns Err if the baseline SDL fails to parse — callers should
   * surface that as a server-side data-integrity issue.
   */
  loadBaseline(sdlSource: string): Result<void, MigrationError> {
    const parseResult = this.parseSDL(sdlSource);

    if (!parseResult.ok)
      return Err(parseResult.error);

    /*** Match the normalization every other SDL-ingesting path applies (see applySchema,
         planMigrationFromSDL, etc). Without this, the baseline keeps arrow-syntax fields as links
         while applySchema normalizes them to properties — every existing field then diffs as a
         DropLink, falsely tripping the unsafe-op gate. ***/
    const normalized = normalizeModules(parseResult.value);
    this.currentModules = normalized;
    this.currentSchema = this.modulesToSchema(normalized);

    return Ok(undefined);
  }

  /**
   * Get the current compiler Schema, or null if no schema has been loaded.
   */
  getSchema(): Schema | null {
    return this.currentSchema;
  }

  /**
   * Get the current Module[] representation, or null if no schema has been loaded.
   */
  getModules(): Module[] | null {
    return this.currentModules;
  }

  /**
   * Initialize the SchemaManager. If a ConnectionPool was provided, creates
   * and initializes a MigrationEngine backed by that pool.
   *
   * After engine initialization, primes `currentModules` from the latest
   * applied migration's stored schema_modules (when available). Without
   * this, a fresh `disc migrate` against a previously-migrated DB would
   * diff against null and emit "create everything" ops that collide with
   * existing types/tables.
   */
  async initialize(): Promise<void> {
    const config: Types.MigrationConfig = {
      migrationsDir: "",
      schemaFile: "",
      databaseUrl: "",
      dryRun: this.dryRun,
      autoApprove: true,
      backupBeforeMigration: false,
      rollbackOnError: true,
      connectionPool: this.pool,
      onProgress: this.onProgress
    };

    this.engine = new MigrationEngine(config);

    if (this.pool) {
      await this.engine.initialize();

      // Prime the baseline from the latest applied migration's stored
      // schema modules. Rows from before this column existed will return
      // null — for those we fall back to schema_hash comparison inside
      // applyModules/applySchema (no-op when hashes match, error
      // otherwise).
      const baseline = this.engine.getLatestAppliedModules();
      if (baseline !== null) {
        this.currentModules = normalizeModules(baseline);
        this.currentSchema = this.modulesToSchema(this.currentModules);
      }
    }
  }

  /**
   * Close the underlying MigrationEngine and release resources.
   */
  async close(): Promise<void> {
    if (this.engine) {
      await this.engine.close();
      this.engine = undefined;
    }
  }
}
