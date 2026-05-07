/**
 * DDL Generator - converts migration operations to SQL DDL statements
 */

import * as Types from "./types.ts";
import { propNameToColumnName, typeNameToTableName } from "../lib/identifiers.ts";

// PostgreSQL 16 reserved keywords that cannot appear unquoted as identifiers.
// Source: https://www.postgresql.org/docs/16/sql-keywords-appendix.html
// (columns marked "reserved" and "reserved (can be function or type)"). We use
// the superset because both categories fail in table/column positions.
const RESERVED_PG_KEYWORDS = new Set<string>([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "authorization",
  "binary",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "collation",
  "column",
  "concurrently",
  "constraint",
  "create",
  "cross",
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "freeze",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "ilike",
  "in",
  "initially",
  "inner",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "lateral",
  "leading",
  "left",
  "like",
  "limit",
  "localtime",
  "localtimestamp",
  "natural",
  "not",
  "notnull",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "overlaps",
  "placing",
  "primary",
  "references",
  "returning",
  "right",
  "select",
  "session_user",
  "similar",
  "some",
  "symmetric",
  "system_user",
  "table",
  "tablesample",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "verbose",
  "when",
  "where",
  "window",
  "with",
  // Common non-standard additions that still conflict unquoted:
  "add",
  "alter",
  "cascade",
  "drop",
  "index",
  "key",
  "restrict",
  "update",
  "delete",
  "insert",
]);

export class DDLGenerator {
  /** Tracks junction tables already emitted in this DDL batch to avoid duplicates */
  private createdJunctionTables = new Set<string>();
  /**
   * Statements that must run AFTER all base `CREATE TABLE`s in the
   * batch — single-link FK constraints (`ALTER TABLE ADD CONSTRAINT`),
   * junction-table creation, and junction unique/index statements.
   * Without this two-phase emission, a junction table or single-link
   * FK might reference a table whose `CREATE TABLE` appears later in
   * the same migration, and PG rejects the FK.
   *
   * Cleared at the start of `generateDDL`; populated by the per-op
   * handlers when they encounter cross-table references.
   */
  private deferredStatements: string[] = [];
  /**
   * Names of user-declared enum scalars that should resolve to PG
   * `disc_enum_<name>` types instead of the default `TEXT` fallback in
   * `mapEdgeQLTypeToPostgreSQL`. Populated via {@link setEnumScalars}
   * — callers that don't set anything get the historical TEXT-fallback
   * behavior so direct/test callers without a schema context still
   * work. (gh/geldata#8517)
   */
  private enumScalars = new Set<string>();

  /**
   * Tell the generator which scalar names are enum-typed so column
   * emission resolves them to their PG enum type. Pass the post-state
   * schema's scalars — the cascade-ordering pass guarantees scalar
   * `CREATE TYPE`s fire before any column referencing them. Callers
   * who don't know (or don't need to know) about enum scalars can skip
   * this; column emission falls back to TEXT.
   */
  setEnumScalars(names: Iterable<string>): void {
    this.enumScalars = new Set(names);
  }

  generateDDL(operations: Types.MigrationOperation[]): string[] {
    this.createdJunctionTables.clear();
    this.deferredStatements = [];
    const statements: string[] = [];

    for (const operation of operations) {
      statements.push(...this.generateOperationDDL(operation));
    }

    // Two-phase emission: all base CREATE TABLEs first, then deferred
    // FK constraints + junction tables. By the time deferred runs, all
    // base tables in the batch exist, so cross-references resolve.
    statements.push(...this.deferredStatements);

    return statements;
  }

  /**
   * Generate rollback DDL statements for the given operations
   * These are the operations that would undo the forward migration
   */
  generateRollbackDDL(operations: Types.MigrationOperation[]): string[] {
    const statements: string[] = [];

    // Process operations in reverse order for rollback
    for (const operation of operations.reverse()) {
      statements.push(...this.generateRollbackOperationDDL(operation));
    }

    return statements;
  }

  private generateRollbackOperationDDL(
    operation: Types.MigrationOperation,
  ): string[] {
    switch (operation.kind) {
      case "CreateType":
        return this.generateRollbackCreateType(
          operation as Types.CreateTypeOperation,
        );
      case "DropType":
        return this.generateRollbackDropType(
          operation as Types.DropTypeOperation,
        );
      case "AlterType":
        return this.generateRollbackAlterType(
          operation as Types.AlterTypeOperation,
        );
      case "CreateTable":
        return this.generateRollbackCreateTable(
          operation as Types.CreateTableOperation,
        );
      case "DropTable":
        return this.generateRollbackDropTable(
          operation as Types.DropTableOperation,
        );
      case "AlterTable":
        return this.generateRollbackAlterTable(
          operation as Types.AlterTableOperation,
        );
      case "CreateIndex":
        return this.generateRollbackCreateIndex(
          operation as Types.CreateIndexOperation,
        );
      case "DropIndex":
        return this.generateRollbackDropIndex(
          operation as Types.DropIndexOperation,
        );
      case "CreateAlias":
        return [
          `-- Rollback: Alias "${(operation as Types.CreateAliasOperation).aliasName}" was compile-time only (no DDL to rollback)`,
        ];
      case "DropAlias":
        return [
          `-- Rollback: Alias "${(operation as Types.DropAliasOperation).aliasName}" was compile-time only (no DDL to rollback)`,
        ];
      case "CreateGlobal":
        return [
          `-- Rollback: Global "${(operation as Types.CreateGlobalOperation).module}::${
            (operation as Types.CreateGlobalOperation).name
          }" was compile-time only (no DDL to rollback)`,
        ];
      case "DropGlobal":
        return [
          `-- Rollback: Global "${(operation as Types.DropGlobalOperation).module}::${
            (operation as Types.DropGlobalOperation).name
          }" was compile-time only (no DDL to rollback)`,
        ];
      case "CreateScalar": {
        const op = operation as Types.CreateScalarOperation;
        if (op.baseType !== "enum") {
          return [
            `-- Rollback: scalar ${op.module}::${op.scalarName} was compile-time only`,
          ];
        }
        const typeName = this.enumTypeName(op.scalarName);
        return [
          `DROP TYPE IF EXISTS ${this.escapeIdentifier(typeName)};`,
        ];
      }
      case "DropScalar": {
        const op = operation as Types.DropScalarOperation;
        return [
          `-- MANUAL ROLLBACK REQUIRED: enum type ${op.module}::${op.scalarName} was dropped — original values lost`,
          `-- Restore from backup or recreate the CREATE TYPE statement manually.`,
        ];
      }
      case "AddEnumValue": {
        const op = operation as Types.AddEnumValueOperation;
        return [
          `-- MANUAL ROLLBACK REQUIRED: PG has no DROP VALUE`,
          `-- Removing '${op.value}' from enum '${op.scalarName}' requires recreating the type.`,
          `-- See RecreateScalar for the cascade-aware path.`,
        ];
      }
      case "RecreateScalar": {
        const op = operation as Types.RecreateScalarOperation;
        const typeName = this.enumTypeName(op.scalarName);
        const escaped = this.escapeIdentifier(typeName);
        const values = op.oldEnumValues
          .map((v) => `'${v.replace(/'/g, "''")}'`)
          .join(", ");
        return [
          `-- Rollback: restore previous enum values for ${typeName}`,
          `DROP TYPE IF EXISTS ${escaped};`,
          `CREATE TYPE ${escaped} AS ENUM (${values});`,
        ];
      }
      default:
        throw new Error(`Unsupported rollback operation: ${operation.kind}`);
    }
  }

  private generateOperationDDL(operation: Types.MigrationOperation): string[] {
    switch (operation.kind) {
      case "CreateType":
        return this.generateCreateType(operation as Types.CreateTypeOperation);
      case "DropType":
        return this.generateDropType(operation as Types.DropTypeOperation);
      case "AlterType":
        return this.generateAlterType(operation as Types.AlterTypeOperation);
      case "CreateTable":
        return this.generateCreateTable(
          operation as Types.CreateTableOperation,
        );
      case "DropTable":
        return this.generateDropTable(operation as Types.DropTableOperation);
      case "AlterTable":
        return this.generateAlterTable(operation as Types.AlterTableOperation);
      case "CreateIndex":
        return this.generateCreateIndex(
          operation as Types.CreateIndexOperation,
        );
      case "DropIndex":
        return this.generateDropIndex(operation as Types.DropIndexOperation);
      case "CreateAlias":
        return [
          `-- Alias "${(operation as Types.CreateAliasOperation).aliasName}" is a compile-time expression alias (no DDL required)`,
        ];
      case "DropAlias":
        return [
          `-- Alias "${(operation as Types.DropAliasOperation).aliasName}" removed (no DDL required, was compile-time only)`,
        ];
      case "CreateGlobal": {
        const createGlobalOp = operation as Types.CreateGlobalOperation;
        return [
          `-- global ${createGlobalOp.module}::${createGlobalOp.name}: ${createGlobalOp.type} (compile-time only)`,
        ];
      }
      case "DropGlobal": {
        const dropGlobalOp = operation as Types.DropGlobalOperation;
        return [
          `-- drop global ${dropGlobalOp.module}::${dropGlobalOp.name} (compile-time only)`,
        ];
      }
      case "CreateScalar":
        return this.generateCreateScalar(operation as Types.CreateScalarOperation);
      case "DropScalar":
        return this.generateDropScalar(operation as Types.DropScalarOperation);
      case "AddEnumValue":
        return this.generateAddEnumValue(
          operation as Types.AddEnumValueOperation,
        );
      case "RecreateScalar":
        return this.generateRecreateScalar(
          operation as Types.RecreateScalarOperation,
        );
      default:
        throw new Error(`Unsupported operation: ${operation.kind}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Scalar / enum DDL (gh/geldata#8517, #2564)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * PG enum type name. Disc maps a Disc-side enum scalar to a PG type
   * named by `enumTypeName(...)` so emitted DDL can reference it by a
   * deterministic identifier. The `disc_enum_` prefix avoids colliding
   * with any user-supplied PG type the operator might add via raw SQL.
   */
  private enumTypeName(scalarName: string): string {
    return `disc_enum_${scalarName.toLowerCase()}`;
  }

  private generateCreateScalar(
    operation: Types.CreateScalarOperation,
  ): string[] {
    if (operation.baseType !== "enum") {
      // Non-enum scalars are compile-time only today (Disc maps them to
      // the underlying PG type at column emission). No DDL needed.
      return [
        `-- scalar ${operation.module}::${operation.scalarName} extends ${operation.baseType} (compile-time only)`,
      ];
    }
    const typeName = this.enumTypeName(operation.scalarName);
    const values = (operation.enumValues ?? [])
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    return [
      `CREATE TYPE ${this.escapeIdentifier(typeName)} AS ENUM (${values});`,
    ];
  }

  private generateDropScalar(
    operation: Types.DropScalarOperation,
  ): string[] {
    const typeName = this.enumTypeName(operation.scalarName);
    return [
      `-- WARNING: DROP TYPE removes the enum and is destructive if any column still references it`,
      `DROP TYPE IF EXISTS ${this.escapeIdentifier(typeName)};`,
    ];
  }

  private generateAddEnumValue(
    operation: Types.AddEnumValueOperation,
  ): string[] {
    const typeName = this.enumTypeName(operation.scalarName);
    const value = `'${operation.value.replace(/'/g, "''")}'`;
    let placement = "";
    if (operation.before) {
      placement = ` BEFORE '${operation.before.replace(/'/g, "''")}'`;
    } else if (operation.after) {
      placement = ` AFTER '${operation.after.replace(/'/g, "''")}'`;
    }
    // PG ≥12 supports ADD VALUE inside a transaction. Disc bundles
    // PG16+ so this is always safe (Zonky's distribution channel).
    return [
      `ALTER TYPE ${this.escapeIdentifier(typeName)} ADD VALUE IF NOT EXISTS ${value}${placement};`,
    ];
  }

  /**
   * Recreate-with-cascade: PG has no `DROP VALUE` or in-place reorder,
   * so removing or reordering enum values requires destroying the type
   * and rebuilding it. Any column referencing the type must be dropped
   * first, then re-added with the new type. This emits a DO block that
   * fails loudly so an operator who runs it without first migrating
   * dependent columns gets a clear error rather than silent corruption.
   *
   * Disc's unsafe-gate refuses these without `--unsafe` (see
   * `MigrationEngine.classifyUnsafeOperations`).
   */
  private generateRecreateScalar(
    operation: Types.RecreateScalarOperation,
  ): string[] {
    const typeName = this.enumTypeName(operation.scalarName);
    const escaped = this.escapeIdentifier(typeName);
    const values = operation.enumValues
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    const reasonComment = operation.reason === "removed-values"
      ? "Removing enum values requires recreating the type (PG has no DROP VALUE)"
      : "Reordering enum values requires recreating the type (PG enum order is positional)";
    return [
      `-- WARNING: ${reasonComment}`,
      `-- Any column referencing ${typeName} must be migrated through a temporary text column.`,
      `-- The DO block below aborts if existing dependents would lose data; drop them first.`,
      `DO $$
DECLARE
  dep_count int;
BEGIN
  SELECT COUNT(*) INTO dep_count
  FROM pg_depend d
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.objid = (SELECT oid FROM pg_type WHERE typname = '${typeName}');
  IF dep_count > 0 THEN
    RAISE EXCEPTION 'Cannot recreate enum type ${typeName}: % column dependent(s) still exist. Drop them first or migrate via a text column.', dep_count;
  END IF;
END $$;`,
      `DROP TYPE IF EXISTS ${escaped};`,
      `CREATE TYPE ${escaped} AS ENUM (${values});`,
    ];
  }

  private generateCreateType(operation: Types.CreateTypeOperation): string[] {
    const statements: string[] = [];
    const tableName = typeNameToTableName(operation.typeName);

    // Generate column definitions from properties
    const columns: Types.ColumnDefinition[] = [
      // Always add an ID column
      {
        name: "id",
        type: "UUID",
        nullable: false,
        primaryKey: true,
        unique: false,
        default: "gen_random_uuid()",
      },
    ];

    // Add __type__ discriminator column for types participating in a hierarchy
    // (types that have subtypes OR types that have parentTypes)
    if (
      (operation.subtypes && operation.subtypes.length > 0) ||
      (operation.parentTypes && operation.parentTypes.length > 0)
    ) {
      columns.push({
        name: "__type__",
        type: "VARCHAR(255)",
        nullable: false,
        primaryKey: false,
        unique: false,
        default: `'${operation.typeName}'`,
      });
    }

    // Add property columns (skip computed properties — they're virtual, evaluated at query time)
    for (const property of operation.properties) {
      if (property.computed) continue;

      columns.push({
        name: propNameToColumnName(property.name),
        type: this.mapEdgeQLTypeToPostgreSQL(property.type),
        nullable: !property.required,
        primaryKey: false,
        unique: property.constraints.includes("exclusive"),
        default: property.default ? this.formatDefaultValue(property.default, property.type) : undefined,
      });
    }

    // Add foreign key columns for links
    for (const link of operation.links) {
      if (!link.multi) {
        // Single-valued link becomes a foreign key column
        columns.push({
          name: `${link.name}_id`,
          type: "UUID",
          nullable: !link.required,
          primaryKey: false,
          unique: false,
          references: {
            table: typeNameToTableName(link.target),
            column: "id",
            onDelete: link.onTargetDelete || "RESTRICT",
          },
        });
      }
    }

    // Generate CREATE TABLE statement WITHOUT inline FK constraints —
    // cross-table FKs are emitted later via `ALTER TABLE ADD CONSTRAINT`
    // so the migration can create types in any order without tripping
    // "relation does not exist" on a forward reference.
    statements.push(
      this.generateCreateTableFromColumns(tableName, columns, {
        inlineFKs: false,
      }),
    );

    // Defer single-link FKs to the second phase.
    for (const column of columns) {
      if (column.references) {
        this.deferredStatements.push(
          this.generateAddForeignKey(tableName, column),
        );
      }
    }

    // Generate junction tables for multi-valued links
    for (const link of operation.links) {
      if (link.multi) {
        const junctionTableName = `${tableName}_${link.name}`;

        // Skip if this exact junction table name was already created
        if (this.createdJunctionTables.has(junctionTableName)) {
          continue;
        }

        // For many-to-many between DIFFERENT types, check if the reciprocal
        // direction already created a junction table (e.g., "group_users"
        // already covers the "user_groups" relationship). Only applies when
        // source != target to avoid incorrectly deduplicating self-referencing
        // multi-links (e.g., User.friends and User.enemies).
        const targetTable = typeNameToTableName(link.target);
        if (tableName !== targetTable) {
          const reverseKey = `${targetTable}→${tableName}`;
          if (this.createdJunctionTables.has(reverseKey)) {
            continue;
          }
        }

        this.createdJunctionTables.add(junctionTableName);
        this.createdJunctionTables.add(`${tableName}→${targetTable}`);

        const junctionColumns: Types.ColumnDefinition[] = [
          {
            name: "source_id",
            type: "UUID",
            nullable: false,
            primaryKey: false,
            unique: false,
            references: {
              table: tableName,
              column: "id",
              onDelete: "CASCADE",
            },
          },
          {
            name: "target_id",
            type: "UUID",
            nullable: false,
            primaryKey: false,
            unique: false,
            references: {
              table: targetTable,
              column: "id",
              onDelete: "CASCADE",
            },
          },
        ];

        // Defer junction-table creation: it references base tables on
        // both sides and may be emitted before either of them exists.
        // Inline FKs are fine here because by the time deferred runs,
        // every base CREATE TABLE has already been executed.
        this.deferredStatements.push(
          this.generateCreateTableFromColumns(
            junctionTableName,
            junctionColumns,
            { inlineFKs: true },
          ),
        );

        // Add unique constraint to prevent duplicate links
        this.deferredStatements.push(
          `ALTER TABLE ${this.escapeIdentifier(junctionTableName)} ADD CONSTRAINT ${
            this.escapeIdentifier(`uk_${junctionTableName}_source_target`)
          } UNIQUE (source_id, target_id);`,
        );
      }
    }

    // Defer indexes on FK columns — must come after the FK constraint
    // exists (so PG agrees the column references something) and after
    // the table exists.
    for (const column of columns) {
      if (column.references) {
        this.deferredStatements.push(
          `CREATE INDEX ${this.escapeIdentifier(`idx_${tableName}_${column.name}`)} ON ${this.escapeIdentifier(tableName)} (${
            this.escapeIdentifier(column.name)
          });`,
        );
      }
      if (column.unique && !column.primaryKey) {
        statements.push(
          `CREATE UNIQUE INDEX ${this.escapeIdentifier(`uk_${tableName}_${column.name}`)} ON ${this.escapeIdentifier(tableName)} (${
            this.escapeIdentifier(column.name)
          });`,
        );
      }
    }

    // Generate CHECK constraints from property constraints
    statements.push(
      ...this.generateCheckConstraints(tableName, operation.properties),
    );

    // Generate triggers
    if (operation.triggers) {
      for (const trigger of operation.triggers) {
        statements.push(...this.generateCreateTrigger(tableName, trigger));
      }
    }

    // Generate rewrite rules (property-level triggers)
    for (const property of operation.properties) {
      if (property.rewrites) {
        for (const rewrite of property.rewrites) {
          statements.push(
            ...this.generateCreateRewrite(tableName, property.name, rewrite),
          );
        }
      }
    }

    // Generate source delete triggers
    for (const link of operation.links) {
      if (link.onSourceDelete === "DELETE TARGET") {
        statements.push(
          ...this.generateSourceDeleteTrigger(tableName, link),
        );
      }
    }

    return statements;
  }

  private generateDropType(operation: Types.DropTypeOperation): string[] {
    const tableName = typeNameToTableName(operation.typeName);
    return [
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)} CASCADE;`,
    ];
  }

  private generateAlterType(operation: Types.AlterTypeOperation): string[] {
    const statements: string[] = [];
    const tableName = typeNameToTableName(operation.typeName);

    for (const typeOp of operation.operations) {
      statements.push(...this.generateTypeOperationDDL(tableName, typeOp));
    }

    return statements;
  }

  private generateTypeOperationDDL(
    tableName: string,
    operation: Types.TypeOperation,
  ): string[] {
    switch (operation.kind) {
      case "AddProperty":
        return this.generateAddProperty(
          tableName,
          operation as Types.AddPropertyOperation,
        );
      case "DropProperty":
        return this.generateDropProperty(
          tableName,
          operation as Types.DropPropertyOperation,
        );
      case "AlterProperty":
        return this.generateAlterProperty(
          tableName,
          operation as Types.AlterPropertyOperation,
        );
      case "AddLink":
        return this.generateAddLink(
          tableName,
          operation as Types.AddLinkOperation,
        );
      case "DropLink":
        return this.generateDropLink(
          tableName,
          operation as Types.DropLinkOperation,
        );
      case "AlterLink":
        return this.generateAlterLink(
          tableName,
          operation as Types.AlterLinkOperation,
        );
      case "AddTrigger":
        return this.generateCreateTrigger(
          tableName,
          (operation as Types.AddTriggerOperation).trigger,
        );
      case "DropTrigger":
        return this.generateDropTrigger(
          tableName,
          (operation as Types.DropTriggerOperation).triggerName,
        );
      case "AddRewrite": {
        const addRewriteOp = operation as Types.AddRewriteOperation;
        return this.generateCreateRewrite(
          tableName,
          addRewriteOp.propertyName,
          addRewriteOp.rewrite,
        );
      }
      case "DropRewrite": {
        const dropRewriteOp = operation as Types.DropRewriteOperation;
        return this.generateDropRewrite(
          tableName,
          dropRewriteOp.propertyName,
          dropRewriteOp.events,
        );
      }
      default:
        throw new Error(`Unsupported type operation: ${operation.kind}`);
    }
  }

  private generateAddProperty(
    tableName: string,
    operation: Types.AddPropertyOperation,
  ): string[] {
    const property = operation.property;

    // Skip computed properties — they're virtual, no column needed
    if (property.computed) {
      return [
        `-- Computed property '${property.name}' is virtual, no column needed`,
      ];
    }

    const columnType = this.mapEdgeQLTypeToPostgreSQL(property.type);
    const nullable = property.required ? "NOT NULL" : "NULL";
    const defaultClause = property.default ? ` DEFAULT ${this.formatDefaultValue(property.default, property.type)}` : "";

    const statements = [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${
        this.escapeIdentifier(propNameToColumnName(property.name))
      } ${columnType} ${nullable}${defaultClause};`,
    ];

    // Generate CHECK constraints for the new property
    statements.push(
      ...this.generateCheckConstraints(tableName, [property]),
    );

    return statements;
  }

  private generateDropProperty(
    tableName: string,
    operation: Types.DropPropertyOperation,
  ): string[] {
    // P1-09: prefix destructive DROP COLUMN with a SQL comment so migration
    // history and logs flag the data-loss step. Production callers should
    // require explicit approval (see MigrationEngine.applyMigrations
    // `autoApprove: false` path).
    const colName = propNameToColumnName(operation.propertyName);
    return [
      `-- WARNING: DROP COLUMN is destructive — data in ${tableName}.${colName} will be lost on apply`,
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(colName)};`,
    ];
  }

  private generateAlterProperty(
    tableName: string,
    operation: Types.AlterPropertyOperation,
  ): string[] {
    const statements: string[] = [];
    const colName = propNameToColumnName(operation.propertyName);
    const columnName = this.escapeIdentifier(colName);
    const tableRef = this.escapeIdentifier(tableName);

    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${this.mapEdgeQLTypeToPostgreSQL(change.newValue)};`,
          );
          break;
        case "ChangeRequired":
          if (change.newValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`,
            );
          }
          break;
        case "ChangeDefault":
          if (change.newValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${this.formatDefaultValue(change.newValue, "unknown")};`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`,
            );
          }
          break;
        case "AddConstraint": {
          const checkExpr = this.constraintToCheckExpression(
            colName,
            change.newValue,
          );
          if (checkExpr) {
            const safeName = change.newValue.replace(/[^a-zA-Z0-9_]/g, "_");
            const constraintName = `chk_${tableName}_${operation.propertyName}_${safeName}`;
            statements.push(
              `ALTER TABLE ${tableRef} ADD CONSTRAINT ${this.escapeIdentifier(constraintName)} CHECK (${checkExpr});`,
            );
          }
          // Handle exclusive constraint as UNIQUE index
          if (change.newValue === "exclusive") {
            statements.push(
              `CREATE UNIQUE INDEX ${
                this.escapeIdentifier(
                  `idx_${tableName}_${operation.propertyName}_unique`,
                )
              } ON ${tableRef} (${columnName});`,
            );
          }
          break;
        }
        case "DropConstraint": {
          const safeName = change.oldValue.replace(/[^a-zA-Z0-9_]/g, "_");
          const constraintName = `chk_${tableName}_${operation.propertyName}_${safeName}`;
          statements.push(
            `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(constraintName)};`,
          );
          // Handle exclusive constraint UNIQUE index removal
          if (change.oldValue === "exclusive") {
            statements.push(
              `DROP INDEX IF EXISTS ${
                this.escapeIdentifier(
                  `idx_${tableName}_${operation.propertyName}_unique`,
                )
              };`,
            );
          }
          break;
        }
      }
    }

    return statements;
  }

  private generateAddLink(
    tableName: string,
    operation: Types.AddLinkOperation,
  ): string[] {
    const statements: string[] = [];
    const link = operation.link;

    if (link.multi) {
      // Multi-valued link - create junction table
      const junctionTableName = `${tableName}_${link.name}`;
      const targetTable = typeNameToTableName(link.target);

      // Skip if already created or reciprocal exists
      if (this.createdJunctionTables.has(junctionTableName)) {
        return statements;
      }
      if (tableName !== targetTable) {
        const reverseKey = `${targetTable}→${tableName}`;
        if (this.createdJunctionTables.has(reverseKey)) {
          return statements;
        }
      }
      this.createdJunctionTables.add(junctionTableName);
      this.createdJunctionTables.add(`${tableName}→${targetTable}`);

      const junctionColumns: Types.ColumnDefinition[] = [
        {
          name: "source_id",
          type: "UUID",
          nullable: false,
          primaryKey: false,
          unique: false,
          references: {
            table: tableName,
            column: "id",
            onDelete: "CASCADE",
          },
        },
        {
          name: "target_id",
          type: "UUID",
          nullable: false,
          primaryKey: false,
          unique: false,
          references: {
            table: targetTable,
            column: "id",
            onDelete: link.onTargetDelete || "CASCADE",
          },
        },
      ];

      statements.push(
        this.generateCreateTableFromColumns(junctionTableName, junctionColumns),
      );
      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(junctionTableName)} ADD CONSTRAINT ${
          this.escapeIdentifier(`uk_${junctionTableName}_source_target`)
        } UNIQUE (source_id, target_id);`,
      );
    } else {
      // Single-valued link - add foreign key column
      const columnName = `${link.name}_id`;
      const nullable = link.required ? "NOT NULL" : "NULL";
      const targetTable = typeNameToTableName(link.target);

      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(columnName)} UUID ${nullable};`,
      );
      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(`fk_${tableName}_${columnName}`)} FOREIGN KEY (${
          this.escapeIdentifier(columnName)
        }) REFERENCES ${this.escapeIdentifier(targetTable)} (id) ON DELETE ${link.onTargetDelete || "RESTRICT"};`,
      );
      statements.push(
        `CREATE INDEX ${this.escapeIdentifier(`idx_${tableName}_${columnName}`)} ON ${this.escapeIdentifier(tableName)} (${
          this.escapeIdentifier(columnName)
        });`,
      );
    }

    // Generate source delete trigger if needed
    if (link.onSourceDelete === "DELETE TARGET") {
      statements.push(
        ...this.generateSourceDeleteTrigger(tableName, link),
      );
    }

    return statements;
  }

  private generateDropLink(
    tableName: string,
    operation: Types.DropLinkOperation,
  ): string[] {
    const statements: string[] = [];
    const linkName = operation.linkName;

    // Drop junction table if it exists
    const junctionTableName = `${tableName}_${linkName}`;
    statements.push(
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(junctionTableName)} CASCADE;`,
    );

    // Drop foreign key column if it exists
    const columnName = `${linkName}_id`;
    statements.push(
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(columnName)};`,
    );

    return statements;
  }

  private generateAlterLink(
    tableName: string,
    operation: Types.AlterLinkOperation,
  ): string[] {
    const statements: string[] = [];

    for (const change of operation.changes) {
      if (change.kind === "ChangeOnSourceDelete") {
        // Drop existing source delete trigger if present
        if (
          change.oldValue === "DELETE TARGET"
        ) {
          statements.push(
            ...this.dropSourceDeleteTrigger(tableName, operation.linkName),
          );
        }
        // Create new source delete trigger if needed
        if (
          change.newValue === "DELETE TARGET"
        ) {
          // For alter operations the link target is not directly available,
          // so we generate a comment about manual target check
          statements.push(
            `-- Source delete trigger for link '${operation.linkName}' on table '${tableName}' requires target table name`,
            `-- Please verify the generated trigger targets the correct table`,
          );
        }
      } else {
        // Other link changes still need manual handling
        statements.push(
          `-- ALTER LINK ${operation.linkName}: ${change.kind} requires manual handling`,
        );
      }
    }

    if (statements.length === 0) {
      statements.push(
        `-- ALTER LINK ${operation.linkName}: No changes to apply`,
      );
    }

    return statements;
  }

  private generateCreateTable(operation: Types.CreateTableOperation): string[] {
    return [
      this.generateCreateTableFromColumns(
        operation.tableName,
        operation.columns,
      ),
    ];
  }

  private generateDropTable(operation: Types.DropTableOperation): string[] {
    return [
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(operation.tableName)} CASCADE;`,
    ];
  }

  private generateAlterTable(operation: Types.AlterTableOperation): string[] {
    const statements: string[] = [];

    for (const tableOp of operation.operations) {
      statements.push(
        ...this.generateTableOperationDDL(operation.tableName, tableOp),
      );
    }

    return statements;
  }

  private generateTableOperationDDL(
    tableName: string,
    operation: Types.TableOperation,
  ): string[] {
    switch (operation.kind) {
      case "AddColumn":
        return this.generateAddColumn(
          tableName,
          operation as Types.AddColumnOperation,
        );
      case "DropColumn":
        return this.generateDropColumn(
          tableName,
          operation as Types.DropColumnOperation,
        );
      case "AlterColumn":
        return this.generateAlterColumn(
          tableName,
          operation as Types.AlterColumnOperation,
        );
      default:
        throw new Error(`Unsupported table operation: ${operation.kind}`);
    }
  }

  private generateAddColumn(
    tableName: string,
    operation: Types.AddColumnOperation,
  ): string[] {
    const column = operation.column;
    const nullable = column.nullable ? "NULL" : "NOT NULL";
    const defaultClause = column.default ? ` DEFAULT ${column.default}` : "";

    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(column.name)} ${column.type} ${nullable}${defaultClause};`,
    ];
  }

  private generateDropColumn(
    tableName: string,
    operation: Types.DropColumnOperation,
  ): string[] {
    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.columnName)};`,
    ];
  }

  private generateAlterColumn(
    tableName: string,
    operation: Types.AlterColumnOperation,
  ): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.columnName);
    const tableRef = this.escapeIdentifier(tableName);

    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${change.newValue};`,
          );
          break;
        case "ChangeNullable":
          if (change.newValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`,
            );
          }
          break;
        case "ChangeDefault":
          if (change.newValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${change.newValue};`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`,
            );
          }
          break;
      }
    }

    return statements;
  }

  private generateCreateIndex(operation: Types.CreateIndexOperation): string[] {
    const index = operation.index;
    const unique = index.unique ? "UNIQUE " : "";
    const method = index.method ? ` USING ${index.method.toUpperCase()}` : "";
    const partial = index.partial ? ` WHERE ${index.partial}` : "";
    const columns = index.columns.map((col) => this.escapeIdentifier(col)).join(
      ", ",
    );

    return [
      `CREATE ${unique}INDEX ${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(index.table)}${method} (${columns})${partial};`,
    ];
  }

  private generateDropIndex(operation: Types.DropIndexOperation): string[] {
    return [
      `DROP INDEX IF EXISTS ${this.escapeIdentifier(operation.indexName)};`,
    ];
  }

  private generateCreateTableFromColumns(
    tableName: string,
    columns: Types.ColumnDefinition[],
    options: { inlineFKs?: boolean } = {},
  ): string {
    const inlineFKs = options.inlineFKs ?? true;
    const columnDefs = columns.map((col) => this.generateColumnDefinition(col));
    const constraints = inlineFKs
      ? columns
        .filter((col) => col.references)
        .map((col) => this.generateForeignKeyConstraint(tableName, col))
      : [];

    const allDefs = [...columnDefs, ...constraints];

    return `CREATE TABLE ${this.escapeIdentifier(tableName)} (\n  ${allDefs.join(",\n  ")}\n);`;
  }

  /**
   * Emit an `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` statement
   * for a column that has a `references` clause. Used when FKs are
   * deferred so cross-table references resolve regardless of CREATE
   * TABLE ordering within a migration.
   */
  private generateAddForeignKey(
    tableName: string,
    column: Types.ColumnDefinition,
  ): string {
    return `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD ${this.generateForeignKeyConstraint(tableName, column)};`;
  }

  private generateColumnDefinition(column: Types.ColumnDefinition): string {
    let def = `${this.escapeIdentifier(column.name)} ${column.type}`;

    if (column.primaryKey) {
      def += " PRIMARY KEY";
    }

    if (!column.nullable) {
      def += " NOT NULL";
    }

    if (column.unique && !column.primaryKey) {
      def += " UNIQUE";
    }

    if (column.default) {
      def += ` DEFAULT ${column.default}`;
    }

    return def;
  }

  private generateForeignKeyConstraint(
    tableName: string,
    column: Types.ColumnDefinition,
  ): string {
    if (!column.references) {
      throw new Error("Column does not have foreign key reference");
    }

    const constraintName = `fk_${tableName}_${column.name}`;
    const onDelete = column.references.onDelete ? ` ON DELETE ${column.references.onDelete}` : "";
    const onUpdate = column.references.onUpdate ? ` ON UPDATE ${column.references.onUpdate}` : "";

    return `CONSTRAINT ${this.escapeIdentifier(constraintName)} FOREIGN KEY (${this.escapeIdentifier(column.name)}) REFERENCES ${
      this.escapeIdentifier(column.references.table)
    } (${this.escapeIdentifier(column.references.column)})${onDelete}${onUpdate}`;
  }

  /**
   * Generate CHECK constraint statements from property constraint annotations.
   * Maps EdgeQL constraint names to SQL CHECK expressions.
   */
  private generateCheckConstraints(
    tableName: string,
    properties: Types.PropertyDefinition[],
  ): string[] {
    const statements: string[] = [];

    for (const property of properties) {
      const colName = propNameToColumnName(property.name);
      for (const constraint of property.constraints) {
        const checkExpr = this.constraintToCheckExpression(
          colName,
          constraint,
        );

        if (checkExpr) {
          const safeName = constraint.replace(/[^a-zA-Z0-9_]/g, "_");
          const constraintName = `chk_${tableName}_${colName}_${safeName}`;

          statements.push(
            `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(constraintName)} CHECK (${checkExpr});`,
          );
        }
      }
    }

    return statements;
  }

  /**
   * Convert an EdgeQL constraint string to a SQL CHECK expression.
   * Returns null for constraints that are not mapped to CHECK (e.g. exclusive).
   */
  private constraintToCheckExpression(
    columnName: string,
    constraint: string,
  ): string | null {
    const col = this.escapeIdentifier(columnName);

    // Parse constraint format: name(arg1,arg2) or just name
    const match = constraint.match(/^(\w+)(?:\((.+)\))?$/);

    if (!match) {
      return null;
    }

    const name = match[1];
    const arg = match[2]?.trim();

    switch (name) {
      case "max_len_value":
        if (arg) return `length(${col}) <= ${arg}`;
        break;
      case "min_len_value":
        if (arg) return `length(${col}) >= ${arg}`;
        break;
      case "max_value":
        if (arg) return `${col} <= ${arg}`;
        break;
      case "min_value":
        if (arg) return `${col} >= ${arg}`;
        break;
      case "regexp":
        if (arg) return `${col} ~ '${arg.replace(/'/g, "''")}'`;
        break;
      case "max_ex_value":
        if (arg) return `${col} < ${arg}`;
        break;
      case "min_ex_value":
        if (arg) return `${col} > ${arg}`;
        break;
      case "one_of":
        if (arg) {
          // Split comma-separated values and quote each one for SQL IN clause
          const values = arg.split(",").map((v: string) => {
            const trimmed = v.trim();
            // If already quoted (from differ serialization), use as-is
            if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
              return trimmed;
            }
            // Numeric values don't need quoting
            if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
            // String values need single-quote wrapping
            return `'${trimmed.replace(/'/g, "''")}'`;
          });
          return `${col} IN (${values.join(", ")})`;
        }
        break;
      case "expression":
        // expression on (...) constraints - handled via "expression_on" format from differ
        break;
      case "expression_on":
        if (arg) {
          // Replace __subject__ with the column name
          const expr = arg.replace(/__subject__/g, col);
          return expr;
        }
        break;
      // "exclusive" is handled as UNIQUE constraint, skip here
      case "exclusive":
        return null;
    }

    return null;
  }

  private mapEdgeQLTypeToPostgreSQL(edgeqlType: string): string {
    const typeMap: Record<string, string> = {
      "str": "TEXT",
      "int16": "SMALLINT",
      "int32": "INTEGER",
      "int64": "BIGINT",
      "float32": "REAL",
      "float64": "DOUBLE PRECISION",
      "decimal": "DECIMAL",
      "bool": "BOOLEAN",
      "uuid": "UUID",
      "datetime": "TIMESTAMP WITH TIME ZONE",
      "duration": "INTERVAL",
      "bytes": "BYTEA",
      "json": "JSONB",
      "cal::local_date": "DATE",
      "cal::local_time": "TIME WITHOUT TIME ZONE",
      "cal::local_datetime": "TIMESTAMP WITHOUT TIME ZONE",
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
      "array<cal::local_time>": "TIME WITHOUT TIME ZONE[]",
      "array<cal::local_datetime>": "TIMESTAMP WITHOUT TIME ZONE[]",
      // Range types
      "range<int32>": "INT4RANGE",
      "range<int64>": "INT8RANGE",
      "range<float64>": "NUMRANGE",
      "range<decimal>": "NUMRANGE",
      "range<datetime>": "TSTZRANGE",
      "range<cal::local_date>": "DATERANGE",
      "range<cal::local_datetime>": "TSRANGE",
      // Multirange types
      "multirange<int32>": "INT4MULTIRANGE",
      "multirange<int64>": "INT8MULTIRANGE",
      "multirange<float64>": "NUMMULTIRANGE",
      "multirange<decimal>": "NUMMULTIRANGE",
      "multirange<datetime>": "TSTZMULTIRANGE",
      "multirange<cal::local_date>": "DATEMULTIRANGE",
      "multirange<cal::local_datetime>": "TSMULTIRANGE",
    };

    if (typeMap[edgeqlType]) {
      return typeMap[edgeqlType];
    }

    // Tuple types map to JSONB (PostgreSQL has no native tuple type)
    if (edgeqlType.startsWith("tuple<")) {
      return "JSONB";
    }

    // User-declared enum scalar — resolve to the PG enum type emitted
    // by `generateCreateScalar`. (gh/geldata#8517) Falls through to
    // TEXT below when no scalar registry was supplied (back-compat).
    // The property's `type` string may be qualified (`module::Name`)
    // or bare (`Name`); strip the module prefix when constructing the
    // PG enum type name so we always get `disc_enum_<simplename>`.
    if (this.enumScalars.has(edgeqlType)) {
      const simpleName = edgeqlType.includes("::") ? edgeqlType.slice(edgeqlType.lastIndexOf("::") + 2) : edgeqlType;
      return this.escapeIdentifier(this.enumTypeName(simpleName));
    }

    return "TEXT";
  }

  private formatDefaultValue(value: any, _type: string): string {
    if (value === null || value === undefined) {
      return "NULL";
    }

    if (typeof value === "string") {
      if (value.startsWith("datetime_current()")) {
        return "NOW()";
      }
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "number") {
      // Always include decimal point for numeric defaults to preserve float semantics
      // e.g., 0.0 should render as "0.0" not "0" in SQL
      const str = String(value);
      if (
        Number.isFinite(value) && !str.includes(".") && !str.includes("e") &&
        !str.includes("E")
      ) {
        return str + ".0";
      }
      return str;
    }

    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }

    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private escapeIdentifier(identifier: string): string {
    // PostgreSQL reserved keywords — identifiers that cannot appear unquoted
    // in a column/table position. Derived from the "reserved (can't be
    // function or type)" column of Table C.1 in the Postgres 16 docs, plus
    // common footguns from SQL:2023.
    const reservedKeywords = RESERVED_PG_KEYWORDS;

    if (reservedKeywords.has(identifier.toLowerCase())) {
      return `"${identifier.replace(/"/g, '""')}"`;
    }

    // Check if identifier needs escaping due to special characters
    if (/^[a-z][a-z0-9_]*$/.test(identifier)) {
      return identifier;
    }

    return `"${identifier.replace(/"/g, '""')}"`;
  }

  // ========================================
  // Trigger DDL Generation Methods
  // ========================================

  private generateCreateTrigger(
    tableName: string,
    trigger: Types.TriggerDefinition,
  ): string[] {
    const fnName = `${tableName}__${trigger.name}_fn`;
    const triggerName = `${tableName}__${trigger.name}`;

    // Replace EdgeQL trigger variables with PostgreSQL equivalents
    const body = trigger.body
      .replace(/__new__/g, "NEW")
      .replace(/__old__/g, "OLD")
      .replace(/__action__/g, "TG_OP");

    const timing = trigger.timing.toUpperCase();
    const events = trigger.events.map((e) => e.toUpperCase()).join(" OR ");
    const scope = trigger.scope === "each" ? "ROW" : "STATEMENT";

    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN ${body}; RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} ${timing} ${events} ON ${this.escapeIdentifier(tableName)} FOR EACH ${scope} EXECUTE FUNCTION ${
        this.escapeIdentifier(fnName)
      }();`,
    ];
  }

  private generateDropTrigger(
    tableName: string,
    triggerName: string,
  ): string[] {
    const pgTriggerName = `${tableName}__${triggerName}`;
    const fnName = `${tableName}__${triggerName}_fn`;

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(pgTriggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`,
    ];
  }

  // ========================================
  // Source Delete Trigger DDL Generation
  // ========================================

  /**
   * Generate a BEFORE DELETE trigger on the source table that cascades
   * deletion to the target when `on source delete delete target` is set.
   */
  private generateSourceDeleteTrigger(
    tableName: string,
    link: Types.LinkDefinition,
  ): string[] {
    const targetTable = typeNameToTableName(link.target);
    const fnName = `disc_source_delete_${tableName}_${link.name}`;
    const triggerName = `trg_source_delete_${tableName}_${link.name}`;

    if (link.multi) {
      // Multi-valued link uses junction table
      const junctionTable = `${tableName}_${link.name}`;
      return [
        `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN DELETE FROM ${
          this.escapeIdentifier(targetTable)
        } WHERE id IN (SELECT target_id FROM ${this.escapeIdentifier(junctionTable)} WHERE source_id = OLD.id); RETURN OLD; END; $$ LANGUAGE plpgsql;`,
        `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} BEFORE DELETE ON ${this.escapeIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${
          this.escapeIdentifier(fnName)
        }();`,
      ];
    }

    // Single-valued link: delete from target where id matches
    const columnName = `${link.name}_id`;
    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN DELETE FROM ${
        this.escapeIdentifier(targetTable)
      } WHERE id = OLD.${this.escapeIdentifier(columnName)}; RETURN OLD; END; $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} BEFORE DELETE ON ${this.escapeIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${
        this.escapeIdentifier(fnName)
      }();`,
    ];
  }

  /**
   * Generate DROP statements for a source delete trigger and its function.
   */
  private dropSourceDeleteTrigger(
    tableName: string,
    linkName: string,
  ): string[] {
    const fnName = `disc_source_delete_${tableName}_${linkName}`;
    const triggerName = `trg_source_delete_${tableName}_${linkName}`;

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(triggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`,
    ];
  }

  // ========================================
  // Rewrite DDL Generation Methods
  // ========================================

  /**
   * Generate a PL/pgSQL trigger function and CREATE TRIGGER for a rewrite rule.
   * Rewrite rules automatically set a column value BEFORE INSERT/UPDATE.
   */
  private generateCreateRewrite(
    tableName: string,
    propertyName: string,
    rewrite: Types.RewriteDefinition,
  ): string[] {
    const colName = propNameToColumnName(propertyName);
    const fnName = `${tableName}__${colName}__rewrite_fn`;
    const triggerName = `${tableName}__${colName}__rewrite`;

    // Compile the rewrite body expression with variable substitutions
    const compiledExpr = this.compileRewriteExpression(rewrite.body);

    // Build event list from rewrite events
    const eventList = rewrite.events.map((e) => e.toUpperCase()).join(" OR ");

    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN NEW.${
        this.escapeIdentifier(colName)
      } := ${compiledExpr}; RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} BEFORE ${eventList} ON ${this.escapeIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${
        this.escapeIdentifier(fnName)
      }();`,
    ];
  }

  /**
   * Generate DROP statements for a rewrite rule's trigger and function.
   */
  private generateDropRewrite(
    tableName: string,
    propertyName: string,
    _events: ("insert" | "update")[],
  ): string[] {
    const colName = propNameToColumnName(propertyName);
    const triggerName = `${tableName}__${colName}__rewrite`;
    const fnName = `${tableName}__${colName}__rewrite_fn`;

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(triggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`,
    ];
  }

  /**
   * Compile a rewrite body expression by substituting EdgeQL builtins
   * with their PostgreSQL equivalents.
   */
  private compileRewriteExpression(body: string): string {
    return body
      .replace(/datetime_of_statement\(\)/g, "statement_timestamp()")
      .replace(/datetime_current\(\)/g, "now()")
      .replace(/datetime_of_transaction\(\)/g, "transaction_timestamp()")
      .replace(/__subject__/g, "NEW")
      .replace(/__old__/g, "OLD");
  }

  // ========================================
  // Rollback DDL Generation Methods
  // ========================================

  private generateRollbackCreateType(
    operation: Types.CreateTypeOperation,
  ): string[] {
    // To rollback CreateType, we drop the table
    const tableName = typeNameToTableName(operation.typeName);
    return [
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)} CASCADE;`,
    ];
  }

  private generateRollbackDropType(
    operation: Types.DropTypeOperation,
  ): string[] {
    // P1-10: DropType rollback is fundamentally impossible without the
    // pre-drop schema snapshot (which we don't persist). Emit a SQL-level
    // DO block so an accidental `disc migrate --rollback` fails loudly
    // instead of silently "succeeding" with comment-only DDL.
    const tableName = typeNameToTableName(operation.typeName);
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate table '${tableName}'`,
      `-- The original table structure was lost when it was dropped.`,
      `-- Please restore from backup or recreate the table manually.`,
      `DO $$ BEGIN
  RAISE EXCEPTION 'Cannot auto-rollback DropType for "${tableName}" — restore from backup or edit this migration to provide CREATE TABLE DDL.';
END $$;`,
    ];
  }

  private generateRollbackAlterType(
    operation: Types.AlterTypeOperation,
  ): string[] {
    const statements: string[] = [];
    const tableName = typeNameToTableName(operation.typeName);

    // Process type operations in reverse order
    for (const typeOp of operation.operations.reverse()) {
      statements.push(...this.generateRollbackTypeOperation(tableName, typeOp));
    }

    return statements;
  }

  private generateRollbackTypeOperation(
    tableName: string,
    operation: Types.TypeOperation,
  ): string[] {
    switch (operation.kind) {
      case "AddProperty":
        return this.generateRollbackAddProperty(
          tableName,
          operation as Types.AddPropertyOperation,
        );
      case "DropProperty":
        return this.generateRollbackDropProperty(
          tableName,
          operation as Types.DropPropertyOperation,
        );
      case "AlterProperty":
        return this.generateRollbackAlterProperty(
          tableName,
          operation as Types.AlterPropertyOperation,
        );
      case "AddLink":
        return this.generateRollbackAddLink(
          tableName,
          operation as Types.AddLinkOperation,
        );
      case "DropLink":
        return this.generateRollbackDropLink(
          tableName,
          operation as Types.DropLinkOperation,
        );
      case "AlterLink":
        return this.generateRollbackAlterLink(
          tableName,
          operation as Types.AlterLinkOperation,
        );
      case "AddTrigger":
        // Rollback AddTrigger = DropTrigger
        return this.generateDropTrigger(
          tableName,
          (operation as Types.AddTriggerOperation).trigger.name,
        );
      case "DropTrigger":
        // Can't restore trigger body from just the name
        return [
          `-- MANUAL ROLLBACK REQUIRED: Recreate trigger '${(operation as Types.DropTriggerOperation).triggerName}' on table '${tableName}'`,
          `-- The original trigger body was lost when it was dropped.`,
          `-- Please refer to backup or documentation for the original trigger definition.`,
        ];
      case "AddRewrite": {
        // Rollback AddRewrite = DropRewrite
        const addRewriteOp = operation as Types.AddRewriteOperation;
        return this.generateDropRewrite(
          tableName,
          addRewriteOp.propertyName,
          addRewriteOp.rewrite.events,
        );
      }
      case "DropRewrite": {
        // Can't restore rewrite body from just the property name and events
        const dropRewriteOp = operation as Types.DropRewriteOperation;
        return [
          `-- MANUAL ROLLBACK REQUIRED: Recreate rewrite rule for property '${dropRewriteOp.propertyName}' on table '${tableName}'`,
          `-- Events: ${dropRewriteOp.events.join(", ")}`,
          `-- The original rewrite body was lost when it was dropped.`,
          `-- Please refer to backup or documentation for the original rewrite definition.`,
        ];
      }
      default:
        throw new Error(
          `Unsupported rollback type operation: ${operation.kind}`,
        );
    }
  }

  private generateRollbackAddProperty(
    tableName: string,
    operation: Types.AddPropertyOperation,
  ): string[] {
    // Computed properties have no column — nothing to roll back
    if (operation.property.computed) {
      return [
        `-- Computed property '${operation.property.name}' was virtual, no column to drop`,
      ];
    }

    // To rollback AddProperty, we drop the column
    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.property.name)};`,
    ];
  }

  private generateRollbackDropProperty(
    tableName: string,
    operation: Types.DropPropertyOperation,
  ): string[] {
    // P1-10: DropProperty rollback can't restore data without a backup.
    // The RAISE EXCEPTION ensures a dry-run or automated rollback fails
    // loudly instead of silently no-op'ing.
    return [
      `-- MANUAL ROLLBACK REQUIRED: Add column '${operation.propertyName}' back to table '${tableName}'`,
      `-- ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(operation.propertyName)} <TYPE> <CONSTRAINTS>;`,
      `-- Please determine the correct type and constraints from backup or documentation.`,
      `DO $$ BEGIN
  RAISE EXCEPTION 'Cannot auto-rollback DropProperty "${tableName}.${operation.propertyName}" — original column definition and data not preserved.';
END $$;`,
    ];
  }

  private generateRollbackAlterProperty(
    tableName: string,
    operation: Types.AlterPropertyOperation,
  ): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.propertyName);
    const tableRef = this.escapeIdentifier(tableName);

    // Process changes in reverse order
    for (const change of operation.changes.reverse()) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${this.mapEdgeQLTypeToPostgreSQL(change.oldValue)};`,
          );
          break;
        case "ChangeRequired":
          if (change.oldValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`,
            );
          }
          break;
        case "ChangeDefault":
          if (change.oldValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${this.formatDefaultValue(change.oldValue, "unknown")};`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`,
            );
          }
          break;
        case "AddConstraint": {
          // Rollback: drop the constraint that was added
          const safeName = change.newValue.replace(/[^a-zA-Z0-9_]/g, "_");
          const constraintName = `chk_${tableName}_${operation.propertyName}_${safeName}`;
          statements.push(
            `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(constraintName)};`,
          );
          break;
        }
        case "DropConstraint": {
          // Rollback: re-add the constraint that was dropped
          const checkExpr = this.constraintToCheckExpression(
            operation.propertyName,
            change.oldValue,
          );
          if (checkExpr) {
            const safeName = change.oldValue.replace(/[^a-zA-Z0-9_]/g, "_");
            const constraintName = `chk_${tableName}_${operation.propertyName}_${safeName}`;
            statements.push(
              `ALTER TABLE ${tableRef} ADD CONSTRAINT ${this.escapeIdentifier(constraintName)} CHECK (${checkExpr});`,
            );
          }
          break;
        }
      }
    }

    return statements;
  }

  private generateRollbackAddLink(
    tableName: string,
    operation: Types.AddLinkOperation,
  ): string[] {
    const statements: string[] = [];
    const linkName = operation.link.name;

    // Drop junction table if it was a multi-link
    if (operation.link.multi) {
      const junctionTableName = `${tableName}_${linkName}`;
      statements.push(
        `DROP TABLE IF EXISTS ${this.escapeIdentifier(junctionTableName)} CASCADE;`,
      );
    } else {
      // Drop foreign key column if it was a single-link
      const columnName = `${linkName}_id`;
      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(columnName)};`,
      );
    }

    return statements;
  }

  private generateRollbackDropLink(
    tableName: string,
    operation: Types.DropLinkOperation,
  ): string[] {
    // To rollback DropLink, we would need to recreate the link
    // This requires the original link definition which we don't have
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate link '${operation.linkName}' on table '${tableName}'`,
      `-- This may involve creating a junction table or adding a foreign key column.`,
      `-- Please refer to backup or documentation for the original link structure.`,
    ];
  }

  private generateRollbackAlterLink(
    tableName: string,
    operation: Types.AlterLinkOperation,
  ): string[] {
    // Link alteration rollback is complex and requires the original link definition
    return [
      `-- MANUAL ROLLBACK REQUIRED: Revert changes to link '${operation.linkName}' on table '${tableName}'`,
      `-- Link alterations may involve changing junction tables or foreign key constraints.`,
      `-- Please refer to backup or documentation for the original link configuration.`,
    ];
  }

  private generateRollbackCreateTable(
    operation: Types.CreateTableOperation,
  ): string[] {
    return [
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(operation.tableName)} CASCADE;`,
    ];
  }

  private generateRollbackDropTable(
    operation: Types.DropTableOperation,
  ): string[] {
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate table '${operation.tableName}'`,
      `-- The original table structure was lost when it was dropped.`,
      `-- Please restore from backup or recreate the table manually.`,
    ];
  }

  private generateRollbackAlterTable(
    operation: Types.AlterTableOperation,
  ): string[] {
    const statements: string[] = [];

    // Process table operations in reverse order
    for (const tableOp of operation.operations.reverse()) {
      statements.push(
        ...this.generateRollbackTableOperation(operation.tableName, tableOp),
      );
    }

    return statements;
  }

  private generateRollbackTableOperation(
    tableName: string,
    operation: Types.TableOperation,
  ): string[] {
    switch (operation.kind) {
      case "AddColumn":
        return this.generateRollbackAddColumn(
          tableName,
          operation as Types.AddColumnOperation,
        );
      case "DropColumn":
        return this.generateRollbackDropColumn(
          tableName,
          operation as Types.DropColumnOperation,
        );
      case "AlterColumn":
        return this.generateRollbackAlterColumn(
          tableName,
          operation as Types.AlterColumnOperation,
        );
      default:
        throw new Error(
          `Unsupported rollback table operation: ${operation.kind}`,
        );
    }
  }

  private generateRollbackAddColumn(
    tableName: string,
    operation: Types.AddColumnOperation,
  ): string[] {
    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.column.name)};`,
    ];
  }

  private generateRollbackDropColumn(
    tableName: string,
    operation: Types.DropColumnOperation,
  ): string[] {
    return [
      `-- MANUAL ROLLBACK REQUIRED: Add column '${operation.columnName}' back to table '${tableName}'`,
      `-- ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(operation.columnName)} <TYPE> <CONSTRAINTS>;`,
      `-- Please determine the correct type and constraints from backup or documentation.`,
    ];
  }

  private generateRollbackAlterColumn(
    tableName: string,
    operation: Types.AlterColumnOperation,
  ): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.columnName);
    const tableRef = this.escapeIdentifier(tableName);

    // Process changes in reverse order
    for (const change of operation.changes.reverse()) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${change.oldValue};`,
          );
          break;
        case "ChangeNullable":
          if (change.oldValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`,
            );
          }
          break;
        case "ChangeDefault":
          if (change.oldValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${change.oldValue};`,
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`,
            );
          }
          break;
      }
    }

    return statements;
  }

  private generateRollbackCreateIndex(
    operation: Types.CreateIndexOperation,
  ): string[] {
    return [
      `DROP INDEX IF EXISTS ${this.escapeIdentifier(operation.index.name)};`,
    ];
  }

  private generateRollbackDropIndex(
    operation: Types.DropIndexOperation,
  ): string[] {
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate index '${operation.indexName}'`,
      `-- The original index definition was lost when it was dropped.`,
      `-- Please refer to backup or documentation for the original index structure.`,
    ];
  }
}
