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
  TypeDeclaration,
} from "../schema/ast.ts";
import { adaptAccessPolicies } from "../access/policy-adapter.ts";
import { getBuiltinFunctions } from "../compiler/builtin-functions.ts";
import { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";
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
  return SDL_TO_SQL_TYPE_MAP[sdlType] ?? "text";
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
    const converter = new SDLConverter();

    for (const module of modules) {
      for (const item of module.items) {
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
          const sdlTypeName = propDecl.type.name.parts.join("::");
          const sqlType = sdlTypeToSqlType(sdlTypeName);

          properties.set(propName, {
            name: propName,
            type: sqlType,
            required: propDecl.required ?? false,
            multi: propDecl.multi ?? false,
            columnName: propName,
          });
        }

        // Extract links from the type declaration
        const linkDeclarations = converter.extractLinks(typeDecl);
        for (const linkDecl of linkDeclarations) {
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

        types.set(typeName, {
          name: typeName,
          kind: "object",
          tableName,
          properties,
          links,
          accessPolicies,
        });
      }
    }

    // Second pass: resolve backlinks for multi-links.
    // For each type's multi-link, check if the target type has a single link
    // pointing back to this type. If so, set linkDef.backlink to that reverse
    // link's name so the compiler can generate correct JOIN conditions.
    for (const [typeName, typeDef] of types) {
      for (const [_linkName, linkDef] of typeDef.links) {
        if (!linkDef.multi) {
          continue;
        }

        const targetTypeDef = types.get(linkDef.target);
        if (!targetTypeDef) {
          continue;
        }

        // Find a single (non-multi) link on the target that points back to
        // this type
        for (const [candidateName, candidateLink] of targetTypeDef.links) {
          if (!candidateLink.multi && candidateLink.target === typeName) {
            linkDef.backlink = candidateName;
            break;
          }
        }
      }
    }

    return {
      types,
      functions: getBuiltinFunctions(),
    };
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
