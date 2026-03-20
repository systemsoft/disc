/**
 * Schema Manager - bridges SDL parsing, query compilation context, and migration planning
 *
 * Connects three currently disconnected systems:
 * - SDL parsing (schema/parser.ts + schema/converter.ts) -> Module[]
 * - Query compilation context (compiler/context.ts) -> Schema with TypeDef/PropertyDef/LinkDef
 * - Migration planning (migration/engine.ts) -> MigrationPlan
 */

import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { SDLParser } from "../schema/parser.ts";
import { Module, SDLConverter } from "../schema/converter.ts";
import {
  AccessPolicy as SDLAccessPolicy,
  AliasDeclaration,
  Constraint as SDLConstraint,
  Expression,
  GlobalDeclaration,
  LinkDeclaration,
  ScalarTypeDeclaration,
  TriggerDeclaration,
  TypeDeclaration,
} from "../schema/ast.ts";
import { adaptAccessPolicies } from "../access/policy-adapter.ts";
import { getBuiltinFunctions } from "../compiler/builtin-functions.ts";
import {
  AliasDef,
  GlobalDef,
  LinkDef,
  PropertyConstraint,
  PropertyDef,
  RewriteDef,
  Schema,
  TriggerDef,
  TypeDef,
} from "../compiler/context.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

/**
 * SDL type name to SQL column type mapping
 */
const SDL_TO_SQL_TYPE_MAP: Record<string, string> = {
  "str": "text",
  "bool": "boolean",
  "int16": "smallint",
  "int32": "integer",
  "int64": "bigint",
  "float32": "real",
  "float64": "double precision",
  "bigint": "numeric",
  "decimal": "numeric",
  "uuid": "uuid",
  "datetime": "timestamptz",
  "duration": "interval",
  "bytes": "bytea",
  "json": "jsonb",
  "sequence": "bigint",
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
  "multirange<cal::local_datetime>": "tsmultirange",
};

/**
 * Convert a PascalCase type name to a snake_case table name
 *
 * Examples:
 *   User -> user
 *   BlogPost -> blog_post
 *   HTTPRequest -> http_request
 */
function typeNameToTableName(typeName: string): string {
  return typeName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

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
    name: { parts: string[] };
    params?: { name: { parts: string[] }; params?: unknown[] }[];
  },
): string {
  let result = typeRef.name.parts.join("::");
  if (typeRef.params && typeRef.params.length > 0) {
    result += `<${
      typeRef.params.map((p) =>
        typeRefToSdlString(
          p as {
            name: { parts: string[] };
            params?: { name: { parts: string[] }; params?: unknown[] }[];
          },
        )
      ).join(", ")
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
      if (typeof expr.value === "string") return `'${expr.value}'`;
      return String(expr.value);
    case "PathExpression": {
      // EdgeQL expression tokens (from parseEdgeQLExpression) are stored as
      // individual tokens in the path array.  Detect them by checking whether
      // the first token is a query keyword and join with spaces instead of
      // dots so the expression round-trips correctly through the EdgeQL parser.
      const edgeqlKeywords = new Set([
        "select",
        "insert",
        "update",
        "delete",
        "with",
        "for",
        "group",
      ]);
      if (
        expr.path.length > 0 &&
        edgeqlKeywords.has(expr.path[0].toLowerCase())
      ) {
        return expr.path.join(" ");
      }
      return expr.path.join(".");
    }
    case "FunctionCall":
      return `${expr.name.parts.join("::")}(${
        expr.args.map(stringifyExpression).join(", ")
      })`;
    case "BinaryOp":
      return `${stringifyExpression(expr.left)} ${expr.op} ${
        stringifyExpression(expr.right)
      }`;
    case "UnaryOp":
      return `${expr.op} ${stringifyExpression(expr.operand)}`;
    case "TypeCast":
      return `<${expr.type.name.parts.join("::")}>${
        stringifyExpression(expr.expr)
      }`;
    case "Parameter":
      return `$${expr.name}`;
    case "ConditionalExpression":
      return `${stringifyExpression(expr.consequent)} if ${
        stringifyExpression(expr.test)
      } else ${stringifyExpression(expr.alternate)}`;
    default:
      return String((expr as { value?: unknown }).value ?? "");
  }
}

/**
 * Extract PropertyConstraint[] from SDL Constraint AST nodes.
 */
function extractPropertyConstraints(
  sdlConstraints: SDLConstraint[] | undefined,
): PropertyConstraint[] | undefined {
  if (!sdlConstraints || sdlConstraints.length === 0) {
    return undefined;
  }

  return sdlConstraints.map((c) => {
    const constraint: PropertyConstraint = {
      name: c.name?.value ?? "unknown",
    };
    if (c.args && c.args.length > 0) {
      constraint.args = c.args.map(stringifyExpression);
    }
    return constraint;
  });
}

export interface SchemaManagerOptions {
  pool?: ConnectionPool;
  dryRun?: boolean;
  onSchemaChange?: (schema: Schema) => void;
}

export class SchemaManager {
  private pool?: ConnectionPool;
  private dryRun: boolean;
  private engine?: MigrationEngine;
  private currentModules: Module[] | null = null;
  private currentSchema: Schema | null = null;
  private onSchemaChange?: (schema: Schema) => void;

  constructor(options: SchemaManagerOptions) {
    this.pool = options.pool;
    this.dryRun = options.dryRun ?? false;
    this.onSchemaChange = options.onSchemaChange;
  }

  /**
   * Parse SDL source text into Module[] representation.
   *
   * Creates an SDLParser to tokenize and parse the source into an SDLDocument,
   * then uses SDLConverter to normalize into Module[].
   */
  parseSDL(source: string): Result<Module[], MigrationError> {
    try {
      const parser = new SDLParser(source);
      const document = parser.parse();
      const converter = new SDLConverter();
      const modules = converter.convertToModules(document);
      return Ok(modules);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to parse SDL: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
    const converter = new SDLConverter();

    // First pass: collect abstract link declarations for link inheritance
    const abstractLinks = new Map<string, LinkDeclaration>();
    for (const module of modules) {
      for (const item of module.items) {
        if (
          item.kind === "LinkDeclaration" &&
          (item as LinkDeclaration).abstract
        ) {
          const linkDecl = item as LinkDeclaration;
          abstractLinks.set(linkDecl.name.value, linkDecl);
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
            expression,
          };
          if (targetType) {
            aliasDef.targetType = targetType;
          }

          aliases.set(aliasName, aliasDef);
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
            pgSettingName: `disc.global_${moduleName}__${globalName}`,
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
          const isEnum = scalarDecl.extending?.some((ext) =>
            ext.name.parts[0] === "enum"
          ) ?? false;

          if (isEnum) {
            types.set(scalarName, {
              name: scalarName,
              kind: "enum",
              tableName: typeNameToTableName(scalarName),
              properties: new Map(),
              links: new Map(),
              enumValues: [],
            });
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
          columnName: "id",
        });

        const links = new Map<string, LinkDef>();

        // Extract properties from the type declaration
        const propDeclarations = converter.extractProperties(typeDecl);
        for (const propDecl of propDeclarations) {
          const propName = propDecl.name.value;
          const sdlTypeName = typeRefToSdlString(propDecl.type);
          const sqlType = sdlTypeToSqlType(sdlTypeName);

          const constraints = extractPropertyConstraints(
            propDecl.constraints,
          );

          // Extract rewrites from the property declaration
          const rewrites: RewriteDef[] | undefined =
            propDecl.rewrites && propDecl.rewrites.length > 0
              ? propDecl.rewrites.map((r) => ({
                events: [...r.events],
                body: r.using,
              }))
              : undefined;

          properties.set(propName, {
            name: propName,
            type: sqlType,
            required: propDecl.required ?? false,
            multi: propDecl.multi ?? false,
            columnName: propName,
            edgeqlType: sdlTypeName,
            readonly: propDecl.readonly ?? false,
            hasDefault: propDecl.default !== undefined,
            computed: propDecl.computed !== undefined,
            constraints,
            rewrites,
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
              if (!abstractLink) continue;

              // Merge inherited properties (concrete wins)
              if (abstractLink.properties) {
                const ownPropNames = new Set(
                  (linkDecl.properties ?? []).map((p) => p.name.value),
                );
                const inherited = abstractLink.properties.filter(
                  (p) => !ownPropNames.has(p.name.value),
                );
                if (inherited.length > 0) {
                  if (!linkDecl.properties) linkDecl.properties = [];
                  linkDecl.properties.push(...inherited);
                }
              }

              // Merge inherited constraints
              if (abstractLink.constraints) {
                if (!linkDecl.constraints) linkDecl.constraints = [];
                linkDecl.constraints.push(...abstractLink.constraints);
              }
            }
          }

          const linkName = linkDecl.name.value;
          const targetName = linkDecl.target.name.parts.join("::");
          const isMulti = linkDecl.multi ?? false;

          links.set(linkName, {
            name: linkName,
            target: targetName,
            required: linkDecl.required ?? false,
            multi: isMulti,
            columnName: isMulti ? undefined : `${linkName}_id`,
          });
        }

        // Extract access policies from the type declaration
        const sdlPolicies = typeDecl.members.filter(
          (m): m is SDLAccessPolicy => m.kind === "AccessPolicy",
        );
        const accessPolicies = sdlPolicies.length > 0
          ? adaptAccessPolicies(typeName, sdlPolicies)
          : undefined;

        // Extract triggers from the type declaration
        const triggerDecls = typeDecl.members.filter(
          (m): m is TriggerDeclaration => m.kind === "TriggerDeclaration",
        );
        const triggers: TriggerDef[] | undefined = triggerDecls.length > 0
          ? triggerDecls.map((t) => ({
            name: t.name.value,
            timing: t.timing,
            events: [...t.events],
            scope: t.scope,
            body: stringifyExpression(t.body),
          }))
          : undefined;

        // Extract inheritance info from SDL AST
        const isAbstract = typeDecl.abstract ?? false;
        const parentTypeNames = typeDecl.extending?.map(
          (ext) => ext.name.parts.join("::"),
        );

        const typeDef: TypeDef = {
          name: typeName,
          kind: "object",
          tableName,
          properties,
          links,
          accessPolicies,
          triggers,
        };

        if (isAbstract) {
          typeDef.abstract = true;
        }
        if (parentTypeNames && parentTypeNames.length > 0) {
          typeDef.parentTypes = parentTypeNames;
        }

        types.set(typeName, typeDef);
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
        const parentDef = types.get(parentName);
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

    for (const [typeName, typeDef] of types) {
      for (const [_linkName, linkDef] of typeDef.links) {
        if (!linkDef.multi) {
          continue;
        }

        const targetTypeDef = types.get(linkDef.target);
        if (!targetTypeDef) {
          continue;
        }

        // First try: single-link backlink on the target type
        let foundBacklink = false;
        for (const [candidateName, candidateLink] of targetTypeDef.links) {
          if (!candidateLink.multi && candidateLink.target === typeName) {
            linkDef.backlink = candidateName;
            foundBacklink = true;
            break;
          }
        }

        // Second try: many-to-many — target has a reciprocal multi-link
        if (!foundBacklink) {
          const tableName = typeDef.tableName;
          const junctionTable = `${tableName}_${linkDef.name}`;

          linkDef.junctionTable = junctionTable;
          linkDef.junctionSourceColumn = "source_id";
          linkDef.junctionTargetColumn = "target_id";

          // Mark the reciprocal link on the target type if it exists
          for (
            const [_candidateName, candidateLink] of targetTypeDef.links
          ) {
            if (candidateLink.multi && candidateLink.target === typeName) {
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
      functions: getBuiltinFunctions(),
    };
    if (aliases.size > 0) {
      schema.aliases = aliases;
    }
    if (globals.size > 0) {
      schema.globals = globals;
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
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    // Parse SDL
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }
    const newModules = parseResult.value;

    // Ensure engine exists
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before applySchema().",
        ),
      );
    }

    // Plan migration: diff currentModules vs newModules
    const planResult = this.engine.planMigration(
      this.currentModules,
      newModules,
    );
    if (!planResult.ok) {
      return planResult;
    }
    const plan = planResult.value;

    // If dryRun, skip execution
    if (this.dryRun) {
      // Update internal state even in dry-run so subsequent calls see the new schema
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);

      // Return synthetic results for each planned migration
      const results: Types.MigrationResult[] = plan.migrations.map((m) => ({
        "success": true,
        "migrationId": m.id,
        "appliedAt": new Date(),
        "durationMs": 0,
      }));
      return Ok(results);
    }

    // Execute the migration plan
    const execResult = await this.engine.executeMigration(plan);
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
    sdlSource: string,
  ): Result<Types.MigrationPlan, MigrationError> {
    // Parse SDL
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }
    const newModules = parseResult.value;

    // Ensure engine exists
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before planSchema().",
        ),
      );
    }

    // Plan migration: diff currentModules vs newModules
    return this.engine.planMigration(this.currentModules, newModules);
  }

  /**
   * Extract DDL statements from a migration plan.
   *
   * Pass-through to the migration engine's DDL generator. Returns the array
   * of SQL strings that would be executed if the plan were applied.
   */
  generateDDL(
    plan: Types.MigrationPlan,
  ): Result<string[], MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before generateDDL().",
        ),
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
    plan: Types.MigrationPlan,
  ): Result<void, MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before validateMigration().",
        ),
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
          "SchemaManager not initialized. Call initialize() before rollbackLastMigration().",
        ),
      );
    }

    return await this.engine.executeRollback(await this.getLatestMigrationId());
  }

  /**
   * Rollback all migrations applied after the specified migration ID.
   * The target migration itself is preserved.
   */
  async rollbackToMigration(
    migrationId: string,
  ): Promise<Result<void, MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before rollbackToMigration().",
        ),
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
          "SchemaManager not initialized. Call initialize() before getMigrationStatus().",
        ),
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
      latestMigration: status.latestMigration
        ? {
          id: status.latestMigration.id,
          name: status.latestMigration.name,
          appliedAt: status.latestMigration.appliedAt,
        }
        : null,
    });
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
          "SchemaManager not initialized. Call initialize() before getMigrationHistory().",
        ),
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
   */
  async initialize(): Promise<void> {
    const config: Types.MigrationConfig = {
      "migrationsDir": "",
      "schemaFile": "",
      "databaseUrl": "",
      "dryRun": this.dryRun,
      "autoApprove": true,
      "backupBeforeMigration": false,
      "rollbackOnError": true,
      "connectionPool": this.pool,
    };

    this.engine = new MigrationEngine(config);

    if (this.pool) {
      await this.engine.initialize();
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
