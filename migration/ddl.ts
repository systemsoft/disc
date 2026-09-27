/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * DDL Generator - converts migration operations to SQL DDL statements
 */

import {
  enumTypeName,
  isReservedPgKeyword,
  linkColumnName,
  propNameToColumnName,
  typeNameToTableName
} from "../lib/identifiers.ts";
import * as Types from "./types.ts";

/** The empty-set value of a multi property's array column (its default). */
const EMPTY_ARRAY = "'{}'";

/**
 * Column types PostgreSQL casts between directly (numbers among numbers,
 * dates and timestamps among themselves). See `DDLGenerator.castExpression`.
 */
const CAST_FAMILIES = [
  new Set(["BIGINT", "DECIMAL", "DOUBLE PRECISION", "INTEGER", "NUMERIC", "REAL", "SMALLINT"]),
  new Set(["DATE", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITHOUT TIME ZONE", "TIMESTAMPTZ"])
];

/** Name of the unique index backing a property-level `constraint exclusive`. */
function exclusiveIndexName(tableName: string, columnName: string): string {
  return `uk_${tableName}_${columnName}`;
}

/** Name of the CHECK backing a property constraint such as `min_value(0)`. */
function checkConstraintName(tableName: string, columnName: string, constraint: string): string {
  return `chk_${tableName}_${columnName}_${constraint.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

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
  private enumScalars = new Map<string, string>();
  /**
   * The type each user-declared non-enum scalar extends, so column emission
   * resolves `Count` (`extending int64`) to BIGINT instead of the TEXT
   * fallback. Populated via {@link setScalarBaseTypes}.
   */
  private scalarBaseTypes = new Map<string, string>();

  /**
   * Tell the generator which scalar names are enum-typed so column
   * emission resolves them to their PG enum type. Pass the post-state
   * schema's scalars — the cascade-ordering pass guarantees scalar
   * `CREATE TYPE`s fire before any column referencing them. Callers
   * who don't know (or don't need to know) about enum scalars can skip
   * this; column emission falls back to TEXT. A Map (from
   * `SchemaDiffer.enumScalarNames`) also gives each name its PG type;
   * plain names get `disc_enum_<name>`.
   */
  setEnumScalars(names: Iterable<string> | Map<string, string>): void {
    this.enumScalars = names instanceof Map ?
      new Map(names) :
      new Map([...names].map(name => [name, this.scalarTypeName({ scalarName: name.slice(name.lastIndexOf(":") + 1) })]));
  }

  /*** Tell the generator the type each non-enum scalar extends (from `SchemaDiffer.scalarBaseTypes`). ***/
  setScalarBaseTypes(bases: Map<string, string>): void {
    this.scalarBaseTypes = new Map(bases);
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

    /*** Replay the forward pass's junction claims, in forward order, so the rollback drops
         exactly the junction tables the forward DDL created (see `junctionCreatedFor`). ***/
    this.createdJunctionTables.clear();

    for (const operation of operations) {
      if (operation.kind === "CreateType") {
        const tableName = typeNameToTableName((operation as Types.CreateTypeOperation).typeName);

        for (const link of (operation as Types.CreateTypeOperation).links) {
          if (link.multi)
            this.claimJunctionTable(tableName, link);
        }
      }

      if (operation.kind === "AlterType") {
        const tableName = typeNameToTableName((operation as Types.AlterTypeOperation).typeName);

        for (const typeOp of (operation as Types.AlterTypeOperation).operations) {
          if (typeOp.kind === "AddLink" && (typeOp as Types.AddLinkOperation).link.multi)
            this.claimJunctionTable(tableName, (typeOp as Types.AddLinkOperation).link);
        }
      }
    }

    // Process operations in reverse order for rollback
    for (const operation of [...operations].reverse()) {
      statements.push(...this.generateRollbackOperationDDL(operation));
    }

    return statements;
  }

  private generateRollbackOperationDDL(
    operation: Types.MigrationOperation
  ): string[] {
    switch (operation.kind) {
      case "CreateType":
        return this.generateRollbackCreateType(
          operation as Types.CreateTypeOperation
        );
      case "DropType":
        return this.generateRollbackDropType(
          operation as Types.DropTypeOperation
        );
      case "AlterType":
        return this.generateRollbackAlterType(
          operation as Types.AlterTypeOperation
        );
      case "CreateTable":
        return this.generateRollbackCreateTable(
          operation as Types.CreateTableOperation
        );
      case "DropTable":
        return this.generateRollbackDropTable(
          operation as Types.DropTableOperation
        );
      case "AlterTable":
        return this.generateRollbackAlterTable(
          operation as Types.AlterTableOperation
        );
      case "CreateIndex":
        return this.generateRollbackCreateIndex(
          operation as Types.CreateIndexOperation
        );
      case "DropIndex":
        return this.generateRollbackDropIndex(
          operation as Types.DropIndexOperation
        );
      case "CreateAlias":
        return [
          `-- Rollback: Alias "${(operation as Types.CreateAliasOperation).aliasName}" was compile-time only (no DDL to rollback)`
        ];
      case "DropAlias":
        return [
          `-- Rollback: Alias "${(operation as Types.DropAliasOperation).aliasName}" was compile-time only (no DDL to rollback)`
        ];
      case "CreateGlobal":
        return [
          `-- Rollback: Global "${(operation as Types.CreateGlobalOperation).module}::${
            (operation as Types.CreateGlobalOperation).name
          }" was compile-time only (no DDL to rollback)`
        ];
      case "DropGlobal":
        return [
          `-- Rollback: Global "${(operation as Types.DropGlobalOperation).module}::${
            (operation as Types.DropGlobalOperation).name
          }" was compile-time only (no DDL to rollback)`
        ];
      case "CreateScalar": {
        const op = operation as Types.CreateScalarOperation;
        if (op.baseType !== "enum") {
          return [
            `-- Rollback: scalar ${op.module}::${op.scalarName} was compile-time only`
          ];
        }
        const typeName = this.scalarTypeName(op);
        return [
          `DROP TYPE IF EXISTS ${this.escapeIdentifier(typeName)};`
        ];
      }
      case "DropScalar": {
        const op = operation as Types.DropScalarOperation;
        return [
          `-- MANUAL ROLLBACK REQUIRED: enum type ${op.module}::${op.scalarName} was dropped — original values lost`,
          `-- Restore from backup or recreate the CREATE TYPE statement manually.`
        ];
      }
      case "AddEnumValue": {
        const op = operation as Types.AddEnumValueOperation;
        return [
          `-- MANUAL ROLLBACK REQUIRED: PG has no DROP VALUE`,
          `-- Removing '${op.value}' from enum '${op.scalarName}' requires recreating the type.`,
          `-- See RecreateScalar for the cascade-aware path.`
        ];
      }
      case "RecreateScalar": {
        const op = operation as Types.RecreateScalarOperation;
        const typeName = this.scalarTypeName(op);
        const escaped = this.escapeIdentifier(typeName);
        const values = op
          .oldEnumValues
          .map(v => `'${v.replace(/'/g, "''")}'`)
          .join(", ");
        return [
          `-- Rollback: restore previous enum values for ${typeName}`,
          `DROP TYPE IF EXISTS ${escaped};`,
          `CREATE TYPE ${escaped} AS ENUM (${values});`
        ];
      }
      case "RenameScalar": {
        const op = operation as Types.RenameScalarOperation;
        return this.generateRenameScalar({ ...op, fromTypeName: op.toTypeName, toTypeName: op.fromTypeName });
      }
      case "ConvertTextColumn": {
        const op = operation as Types.ConvertTextColumnOperation;
        const column = this.escapeIdentifier(op.columnName);
        return [
          op.fromTextArray ?
            this.retypeColumn(op.tableName, op.columnName, "TEXT[]", `${column}::text[]`, op.multi === true, op.multi ? EMPTY_ARRAY : undefined) :
            `ALTER TABLE ${this.escapeIdentifier(op.tableName)} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text;`
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
          operation as Types.CreateTableOperation
        );
      case "DropTable":
        return this.generateDropTable(operation as Types.DropTableOperation);
      case "AlterTable":
        return this.generateAlterTable(operation as Types.AlterTableOperation);
      case "CreateIndex":
        return this.generateCreateIndex(
          operation as Types.CreateIndexOperation
        );
      case "DropIndex":
        return this.generateDropIndex(operation as Types.DropIndexOperation);
      case "CreateAlias":
        return [
          `-- Alias "${(operation as Types.CreateAliasOperation).aliasName}" is a compile-time expression alias (no DDL required)`
        ];
      case "DropAlias":
        return [
          `-- Alias "${(operation as Types.DropAliasOperation).aliasName}" removed (no DDL required, was compile-time only)`
        ];
      case "CreateGlobal": {
        const createGlobalOp = operation as Types.CreateGlobalOperation;
        return [
          `-- global ${createGlobalOp.module}::${createGlobalOp.name}: ${createGlobalOp.type} (compile-time only)`
        ];
      }
      case "DropGlobal": {
        const dropGlobalOp = operation as Types.DropGlobalOperation;
        return [
          `-- drop global ${dropGlobalOp.module}::${dropGlobalOp.name} (compile-time only)`
        ];
      }
      case "CreateScalar":
        return this.generateCreateScalar(
          operation as Types.CreateScalarOperation
        );
      case "DropScalar":
        return this.generateDropScalar(operation as Types.DropScalarOperation);
      case "AddEnumValue":
        return this.generateAddEnumValue(
          operation as Types.AddEnumValueOperation
        );
      case "RecreateScalar":
        return this.generateRecreateScalar(
          operation as Types.RecreateScalarOperation
        );
      case "RenameScalar":
        return this.generateRenameScalar(
          operation as Types.RenameScalarOperation
        );
      case "ConvertTextColumn":
        return this.generateConvertTextColumn(
          operation as Types.ConvertTextColumnOperation
        );
      default:
        throw new Error(`Unsupported operation: ${operation.kind}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Scalar / enum DDL (gh/geldata#8517, #2564)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * PG enum type name of a scalar operation. The differ records it
   * (`pgTypeName`, module-qualified when another enum shares the name);
   * operations recorded before that get `disc_enum_<name>`, the name
   * every enum had then. The `disc_enum_` prefix avoids colliding with
   * any user-supplied PG type the operator might add via raw SQL.
   */
  private scalarTypeName(operation: { pgTypeName?: string; scalarName: string; }): string {
    return operation.pgTypeName ?? enumTypeName("default", operation.scalarName, false);
  }

  /**
   * Convert a legacy TEXT column (see `ConvertTextColumnOperation`). It holds
   * what PostgreSQL's assignment cast to text wrote: the value's text form
   * (`12`, `{Low,"In Progress"}`), or — for an array type — a JSON array
   * (`["Low"]`) from a `<json>` value. Every stored value is checked first, so
   * one that doesn't convert fails the migration naming the column and the
   * value rather than being dropped; then JSON arrays are rewritten as array
   * literals, which the column type change casts. PostgreSQL can't cast a
   * text default to the new type, so a declared default is dropped for the
   * change and set again.
   *
   * A legacy `text[]` column (`fromTextArray`) holds each element's text
   * form: every stored element is checked against the element type, then the
   * array is cast, keeping a multi property's empty-set default.
   */
  private generateConvertTextColumn(
    operation: Types.ConvertTextColumnOperation
  ): string[] {
    const table = this.escapeIdentifier(operation.tableName);
    const column = this.escapeIdentifier(operation.columnName);
    const pgType = operation.pgType;
    const element = pgType.endsWith("[]") ?
      /^array<(.+)>$/.exec(operation.propertyType)?.[1] ?? operation.propertyType :
      undefined;
    const subject = `Cannot convert ${operation.tableName}.${operation.columnName}`;
    const declaredDefault = operation.default === undefined ?
      undefined :
      this.formatDefaultValue(operation.default, operation.propertyType);

    if (operation.fromTextArray) {
      return [
        this.valueCheck(
          "text",
          `SELECT DISTINCT disc_element FROM ${table}, unnest(${column}) AS disc_element WHERE disc_element IS NOT NULL`,
          `disc_value::${pgType.slice(0, -2)}`,
          `${subject} from text[] to ${operation.propertyType}: stored value % is not a valid ${element}`
        ),
        operation.multi ?
          this.retypeColumn(operation.tableName, operation.columnName, pgType, `${column}::${pgType}`, true, EMPTY_ARRAY) :
          this.retypeColumn(operation.tableName, operation.columnName, pgType, `${column}::${pgType}`, declaredDefault !== undefined, declaredDefault)
      ];
    }

    const jsonElements = (value: string): string =>
      `ARRAY(SELECT e.v FROM jsonb_array_elements_text(${value}::jsonb) WITH ORDINALITY AS e(v, ord) ORDER BY e.ord)`;
    const isJsonArray = (value: string): string => `${value} ~ '^\\s*\\['`;
    const check = element === undefined ?
      `disc_value::${pgType}` :
      `CASE WHEN ${isJsonArray("disc_value")} THEN ${jsonElements("disc_value")}::${pgType} ELSE disc_value::${pgType} END`;
    const expected = element === undefined ? `a valid ${operation.propertyType}` : `an array of ${element} values`;

    return [
      this.valueCheck(
        "text",
        `SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL`,
        check,
        `${subject} from text to ${operation.propertyType}: stored value % is not ${expected}`
      ),
      ...(element === undefined ? [] : [`UPDATE ${table} SET ${column} = ${jsonElements(column)}::text WHERE ${isJsonArray(column)};`]),
      this.retypeColumn(operation.tableName, operation.columnName, pgType, `${column}::${pgType}`, declaredDefault !== undefined, declaredDefault)
    ];
  }

  /**
   * A block that evaluates `convert` — an expression of `disc_value`, of
   * `valueType` — for every value `values` (a one-column query) returns,
   * failing on the first one that doesn't convert with `message`, whose `%`
   * is that value, quoted, followed by PostgreSQL's reason. It runs before a
   * column changes type, so a bad value is reported by column and value
   * rather than as a bare cast error, and nothing has changed yet.
   */
  private valueCheck(valueType: string, values: string, convert: string, message: string): string {
    return `DO $$
DECLARE
  disc_value ${valueType};
BEGIN
  FOR disc_value IN ${values} LOOP
    BEGIN
      PERFORM ${convert};
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '${message.replace(/'/g, "''")} (%)', quote_literal(disc_value), SQLERRM;
    END;
  END LOOP;
END $$;`;
  }

  /**
   * `ALTER COLUMN … TYPE … USING …`. PostgreSQL converts a column's default to
   * the new type with an assignment cast, which most conversions lack (text to
   * a number, `text[]` to an enum array), so when the column may have a
   * default (`dropDefault`) it is dropped for the change, and `setDefault`
   * (SQL), when given, is set after it.
   */
  private retypeColumn(
    tableName: string,
    columnName: string,
    pgType: string,
    using: string,
    dropDefault: boolean,
    setDefault?: string
  ): string {
    const table = this.escapeIdentifier(tableName);
    const column = this.escapeIdentifier(columnName);
    const alterType = `ALTER COLUMN ${column} TYPE ${pgType} USING ${using}`;

    if (!dropDefault && setDefault === undefined)
      return `ALTER TABLE ${table} ${alterType};`;

    return `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT, ${alterType}${
      setDefault === undefined ? "" : `, ALTER COLUMN ${column} SET DEFAULT ${setDefault}`
    };`;
  }

  /**
   * The expression converting `value` from column type `from` to column type
   * `to` (as `mapEdgeQLTypeToPostgreSQL` gives them), or `undefined` when
   * PostgreSQL has no conversion. Text converts to and from anything (printing
   * or parsing the value); an enum only to and from text, so enum ↔ anything
   * else goes through text; numbers cast among numbers and dates among dates.
   * Arrays convert when their elements do.
   */
  private castExpression(value: string, from: string, to: string): string | undefined {
    const fromArray = from.endsWith("[]");
    const toArray = to.endsWith("[]");

    if (fromArray !== toArray)
      return from === "TEXT" || to === "TEXT" ? `${value}::${to}` : undefined;

    const fromElement = fromArray ? from.slice(0, -2) : from;
    const toElement = toArray ? to.slice(0, -2) : to;

    if (
      fromElement === toElement || fromElement === "TEXT" || toElement === "TEXT" ||
      CAST_FAMILIES.some(family => family.has(fromElement) && family.has(toElement))
    ) {
      return `${value}::${to}`;
    }

    const enumTypes = new Set([...this.enumScalars.values()].map(name => this.escapeIdentifier(name)));

    if (enumTypes.has(fromElement) || enumTypes.has(toElement))
      return `${value}::text${toArray ? "[]" : ""}::${to}`;

    return undefined;
  }

  private generateRenameScalar(
    operation: Types.RenameScalarOperation
  ): string[] {
    return [
      `ALTER TYPE ${this.escapeIdentifier(operation.fromTypeName)} RENAME TO ${this.escapeIdentifier(operation.toTypeName)};`
    ];
  }

  private generateCreateScalar(
    operation: Types.CreateScalarOperation
  ): string[] {
    if (operation.baseType !== "enum") {
      // Non-enum scalars are compile-time only today (Disc maps them to
      // the underlying PG type at column emission). No DDL needed.
      return [
        `-- scalar ${operation.module}::${operation.scalarName} extends ${operation.baseType} (compile-time only)`
      ];
    }
    const typeName = this.scalarTypeName(operation);
    const values = (operation.enumValues ?? [])
      .map(v => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    return [
      `CREATE TYPE ${this.escapeIdentifier(typeName)} AS ENUM (${values});`
    ];
  }

  private generateDropScalar(
    operation: Types.DropScalarOperation
  ): string[] {
    const typeName = this.scalarTypeName(operation);
    return [
      `-- WARNING: DROP TYPE removes the enum and is destructive if any column still references it`,
      `DROP TYPE IF EXISTS ${this.escapeIdentifier(typeName)};`
    ];
  }

  private generateAddEnumValue(
    operation: Types.AddEnumValueOperation
  ): string[] {
    const typeName = this.scalarTypeName(operation);
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
      `ALTER TYPE ${this.escapeIdentifier(typeName)} ADD VALUE IF NOT EXISTS ${value}${placement};`
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
    operation: Types.RecreateScalarOperation
  ): string[] {
    const typeName = this.scalarTypeName(operation);
    const escaped = this.escapeIdentifier(typeName);
    const values = operation
      .enumValues
      .map(v => `'${v.replace(/'/g, "''")}'`)
      .join(", ");
    const reasonComment = operation.reason === "removed-values" ?
      "Removing enum values requires recreating the type (PG has no DROP VALUE)" :
      "Reordering enum values requires recreating the type (PG enum order is positional)";
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
      `CREATE TYPE ${escaped} AS ENUM (${values});`
    ];
  }

  private generateCreateType(operation: Types.CreateTypeOperation): string[] {
    const statements: string[] = [];
    const tableName = typeNameToTableName(operation.typeName);

    // Generate column definitions from properties
    const columns: Types.ColumnDefinition[] = [
      // Always add an ID column. Defaults to disc_uuidv7() (time-ordered,
      // RFC 9562 v7) — bootstrapped in lib/stdlib-sql.ts before any table is
      // created. Time-ordered keys keep primary-key index inserts sequential.
      {
        name: "id",
        type: "UUID",
        nullable: false,
        primaryKey: true,
        unique: false,
        default: "disc_uuidv7()"
      }
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
        default: `'${operation.typeName}'`
      });
    }

    // Add property columns (skip computed properties — they're virtual, evaluated at query time)
    for (const property of operation.properties) {
      if (property.computed) {
        continue;
      }

      // A multi property is an array column that is never NULL: an unset
      // property is the empty set `'{}'`, and `required multi` is a
      // non-empty CHECK (see generateCheckConstraints).
      columns.push({
        name: propNameToColumnName(property.name),
        type: this.propertyColumnType(property),
        nullable: !property.multi && !property.required,
        primaryKey: false,
        unique: property.constraints.includes("exclusive"),
        // `default !== undefined` rather than truthy — `default := 0`,
        // `default := false`, and `default := ""` are valid SDL defaults
        // that the truthy form would silently drop.
        default: property.multi ?
          EMPTY_ARRAY :
          property.default !== undefined ?
          this.formatDefaultValue(property.default, property.type) :
          undefined
      });
    }

    // Add foreign key columns for links
    for (const link of operation.links) {
      if (!link.multi) {
        // Single-valued link becomes a foreign key column. Snake_case so
        // Postgres' unquoted-identifier lowercasing round-trips through
        // EdgeQL→SQL compilation cleanly.
        columns.push({
          name: linkColumnName(link.name),
          type: "UUID",
          nullable: !link.required,
          primaryKey: false,
          unique: link.exclusive === true,
          references: {
            table: typeNameToTableName(link.target),
            column: "id",
            onDelete: this.targetOnDelete(link)
          }
        });
      }
    }

    // Generate CREATE TABLE statement WITHOUT inline FK constraints —
    // cross-table FKs are emitted later via `ALTER TABLE ADD CONSTRAINT`
    // so the migration can create types in any order without tripping
    // "relation does not exist" on a forward reference.
    //
    // Exclusive columns are written without an inline `UNIQUE`: their one
    // unique index is the `uk_<table>_<column>` created below, the same name
    // the add/drop-constraint paths use. An inline `UNIQUE` would add a second
    // `<table>_<column>_key` index that dropping the constraint never removes.
    statements.push(
      this.generateCreateTableFromColumns(
        tableName,
        columns.map(column => ({ ...column, unique: false })),
        { inlineFKs: false }
      )
    );

    // Defer single-link FKs to the second phase.
    for (const column of columns) {
      if (column.references) {
        this.deferredStatements.push(
          this.generateAddForeignKey(tableName, column)
        );
      }
    }

    // Generate junction tables for multi-valued links
    for (const link of operation.links) {
      if (link.multi) {
        const junctionTableName = this.claimJunctionTable(tableName, link);

        if (junctionTableName === null) {
          continue;
        }

        const targetTable = typeNameToTableName(link.target);
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
              onDelete: "CASCADE"
            }
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
              onDelete: this.targetOnDelete(link)
            }
          },
          ...this.linkPropertyColumns(link)
        ];

        // Defer junction-table creation: it references base tables on
        // both sides and may be emitted before either of them exists.
        // Inline FKs are fine here because by the time deferred runs,
        // every base CREATE TABLE has already been executed.
        this.deferredStatements.push(
          this.generateCreateTableFromColumns(
            junctionTableName,
            junctionColumns,
            { inlineFKs: true }
          )
        );

        // Add unique constraint to prevent duplicate links
        this.deferredStatements.push(
          `ALTER TABLE ${this.escapeIdentifier(junctionTableName)} ADD CONSTRAINT ${
            this.escapeIdentifier(`uk_${junctionTableName}_source_target`)
          } UNIQUE (source_id, target_id);`
        );

        if (link.exclusive) {
          this.deferredStatements.push(this.generateExclusiveLinkIndex(tableName, link));
        }

        // Link-property constraints are CHECKs on the junction's columns.
        this.deferredStatements.push(
          ...this.generateCheckConstraints(junctionTableName, link.properties ?? [])
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
          });`
        );
      }
      if (column.unique && !column.primaryKey) {
        statements.push(
          `CREATE UNIQUE INDEX ${this.escapeIdentifier(exclusiveIndexName(tableName, column.name))} ON ${this.escapeIdentifier(tableName)} (${
            this.escapeIdentifier(column.name)
          });`
        );
      }
    }

    // Generate CHECK constraints from property constraints
    statements.push(
      ...this.generateCheckConstraints(tableName, operation.properties)
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
            ...this.generateCreateRewrite(tableName, property.name, rewrite)
          );
        }
      }
    }

    // Generate source delete triggers
    for (const link of operation.links) {
      if (link.onSourceDelete === "DELETE TARGET") {
        statements.push(
          ...this.generateSourceDeleteTrigger(tableName, link)
        );
      }
    }

    return statements;
  }

  /**
   * The junction table the multi link `link` of `tableName` gets in this batch, recorded as
   * created — or null when the batch already created that table, or (for many-to-many between
   * DIFFERENT types) the reciprocal direction's: "group_users" already covers "user_groups".
   * The reciprocal check skips self-referencing multi links (User.friends and User.enemies).
   */
  private claimJunctionTable(tableName: string, link: Types.LinkDefinition): string | null {
    const junctionTableName = `${tableName}_${link.name}`;
    const targetTable = typeNameToTableName(link.target);

    if (this.createdJunctionTables.has(junctionTableName)) {
      return null;
    }

    if (tableName !== targetTable && this.createdJunctionTables.has(`${targetTable}→${tableName}`)) {
      return null;
    }

    this.createdJunctionTables.add(junctionTableName);
    this.createdJunctionTables.add(`${tableName}→${targetTable}`);
    return junctionTableName;
  }

  private generateDropType(operation: Types.DropTypeOperation): string[] {
    const tableName = typeNameToTableName(operation.typeName);
    const statements: string[] = [];

    /*** Drop junction tables for multi-valued links first. The CASCADE on the main table drops
         dependent FKs, but the junctions themselves are sibling tables — they’d survive an
         unqualified CASCADE and collide on a subsequent re-create. ***/
    if (operation.multiLinks) {
      for (const linkName of operation.multiLinks) {
        const junctionTableName = `${tableName}_${linkName}`;
        statements.push(`DROP TABLE IF EXISTS ${this.escapeIdentifier(junctionTableName)} CASCADE;`);
      }
    }

    statements.push(`DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)} CASCADE;`);
    return statements;
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
    operation: Types.TypeOperation
  ): string[] {
    switch (operation.kind) {
      case "AddProperty":
        return this.generateAddProperty(
          tableName,
          operation as Types.AddPropertyOperation
        );
      case "DropProperty":
        return this.generateDropProperty(
          tableName,
          operation as Types.DropPropertyOperation
        );
      case "AlterProperty":
        return this.generateAlterProperty(
          tableName,
          operation as Types.AlterPropertyOperation
        );
      case "AddLink":
        return this.generateAddLink(
          tableName,
          operation as Types.AddLinkOperation
        );
      case "DropLink":
        return this.generateDropLink(
          tableName,
          operation as Types.DropLinkOperation
        );
      case "AlterLink":
        return this.generateAlterLink(
          tableName,
          operation as Types.AlterLinkOperation
        );
      case "AddTrigger":
        return this.generateCreateTrigger(
          tableName,
          (operation as Types.AddTriggerOperation).trigger
        );
      case "DropTrigger":
        return this.generateDropTrigger(
          tableName,
          (operation as Types.DropTriggerOperation).triggerName
        );
      case "AddRewrite": {
        const addRewriteOp = operation as Types.AddRewriteOperation;
        return this.generateCreateRewrite(
          tableName,
          addRewriteOp.propertyName,
          addRewriteOp.rewrite
        );
      }
      case "DropRewrite": {
        const dropRewriteOp = operation as Types.DropRewriteOperation;
        return this.generateDropRewrite(
          tableName,
          dropRewriteOp.propertyName,
          dropRewriteOp.events
        );
      }
      default:
        throw new Error(`Unsupported type operation: ${operation.kind}`);
    }
  }

  private generateAddProperty(
    tableName: string,
    operation: Types.AddPropertyOperation
  ): string[] {
    const property = operation.property;

    // Skip computed properties — they're virtual, no column needed
    if (property.computed) {
      return [
        `-- Computed property '${property.name}' is virtual, no column needed`
      ];
    }

    const columnType = this.propertyColumnType(property);
    const nullable = property.required || property.multi ? "NOT NULL" : "NULL";
    const defaultClause = property.multi ?
      ` DEFAULT ${EMPTY_ARRAY}` :
      property.default !== undefined ?
      ` DEFAULT ${this.formatDefaultValue(property.default, property.type)}` :
      "";

    const columnName = propNameToColumnName(property.name);
    const statements = [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(columnName)} ${columnType} ${nullable}${defaultClause};`
    ];

    if (property.constraints.includes("exclusive")) {
      statements.push(
        `CREATE UNIQUE INDEX ${this.escapeIdentifier(exclusiveIndexName(tableName, columnName))} ON ${this.escapeIdentifier(tableName)} (${
          this.escapeIdentifier(columnName)
        });`
      );
    }

    // Generate CHECK constraints for the new property
    statements.push(
      ...this.generateCheckConstraints(tableName, [property])
    );

    return statements;
  }

  private generateDropProperty(
    tableName: string,
    operation: Types.DropPropertyOperation
  ): string[] {
    // P1-09: prefix destructive DROP COLUMN with a SQL comment so migration
    // history and logs flag the data-loss step. Production callers should
    // require explicit approval (see MigrationEngine.applyMigrations
    // `autoApprove: false` path).
    const colName = propNameToColumnName(operation.propertyName);
    return [
      `-- WARNING: DROP COLUMN is destructive — data in ${tableName}.${colName} will be lost on apply`,
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(colName)};`
    ];
  }

  private generateAlterProperty(
    tableName: string,
    operation: Types.AlterPropertyOperation
  ): string[] {
    if (operation.oldProperty?.multi && !operation.newProperty?.multi) {
      throw new Error(
        `Cannot migrate property '${operation.propertyName}' from multi → single: a set of values has no lossless single-value form. ` +
          "Add a new single property, copy the data over, then drop the multi one."
      );
    }
    if (operation.oldProperty && operation.newProperty?.multi) {
      return this.generateAlterMultiProperty(tableName, operation, operation.oldProperty, operation.newProperty);
    }

    const statements: string[] = [];
    const colName = propNameToColumnName(operation.propertyName);
    const columnName = this.escapeIdentifier(colName);
    const tableRef = this.escapeIdentifier(tableName);
    const defaults = this.propertyDefaults(operation);
    const retyped = operation.changes.some(change => change.kind === "ChangeType");

    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            ...this.generateRetypeProperty(tableName, operation.propertyName, change.oldValue, change.newValue, defaults.old, defaults.new)
          );
          break;
        case "ChangeRequired":
          if (change.newValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`
            );
          }
          break;
        case "ChangeDefault":
          // A type change sets the new default itself (see generateRetypeProperty).
          if (retyped) {
            break;
          }
          if (change.newValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${this.formatDefaultValue(change.newValue, "unknown")};`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`
            );
          }
          break;
        case "AddConstraint": {
          const checkExpr = this.constraintToCheckExpression(
            colName,
            change.newValue
          );
          if (checkExpr) {
            const constraintName = checkConstraintName(tableName, colName, change.newValue);
            statements.push(
              `ALTER TABLE ${tableRef} ADD CONSTRAINT ${this.escapeIdentifier(constraintName)} CHECK (${checkExpr});`
            );
          }
          // Handle exclusive constraint as UNIQUE index — same name CREATE TABLE uses
          if (change.newValue === "exclusive") {
            statements.push(
              `CREATE UNIQUE INDEX ${this.escapeIdentifier(exclusiveIndexName(tableName, colName))} ON ${tableRef} (${columnName});`
            );
          }
          break;
        }
        case "DropConstraint": {
          const constraintName = checkConstraintName(tableName, colName, change.oldValue);
          statements.push(
            `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(constraintName)};`
          );
          // Older versions named a CHECK added to an existing property after the
          // property rather than the column; drop that name too so they heal.
          const legacyName = checkConstraintName(tableName, operation.propertyName, change.oldValue);
          if (legacyName !== constraintName) {
            statements.push(
              `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(legacyName)};`
            );
          }
          // Handle exclusive constraint UNIQUE index removal. Besides the current
          // `uk_` index, drop what older versions created so those databases heal:
          // `idx_<t>_<c>_unique` from the add path and the `<t>_<c>_key`
          // constraint PG named for the inline `UNIQUE` CREATE TABLE used to emit.
          if (change.oldValue === "exclusive") {
            statements.push(
              `DROP INDEX IF EXISTS ${this.escapeIdentifier(exclusiveIndexName(tableName, colName))};`,
              `DROP INDEX IF EXISTS ${this.escapeIdentifier(`idx_${tableName}_${operation.propertyName}_unique`)};`,
              `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(`${tableName}_${colName}_key`)};`
            );
          }
          break;
        }
      }
    }

    return statements;
  }

  /**
   * AlterProperty for a property that is multi after the change. Its CHECKs
   * depend on the whole definition (element type, `required`, every
   * constraint), so any change touching them drops the old set and adds the
   * new one. single → multi converts the column in place: NULL becomes the
   * empty set and a value becomes a one-element set.
   */
  private generateAlterMultiProperty(
    tableName: string,
    operation: Types.AlterPropertyOperation,
    oldProperty: Types.PropertyDefinition,
    newProperty: Types.PropertyDefinition
  ): string[] {
    const checkKinds = new Set(["ChangeMulti", "ChangeType", "ChangeRequired", "AddConstraint", "DropConstraint"]);
    if (!operation.changes.some(change => checkKinds.has(change.kind))) {
      return [];
    }

    const colName = propNameToColumnName(operation.propertyName);
    const column = this.escapeIdentifier(colName);
    const tableRef = this.escapeIdentifier(tableName);
    const elementType = this.mapEdgeQLTypeToPostgreSQL(newProperty.type);
    const statements = this.dropCheckConstraints(tableName, oldProperty);

    if (!oldProperty.multi) {
      if (oldProperty.constraints.includes("exclusive")) {
        statements.push(`DROP INDEX IF EXISTS ${this.escapeIdentifier(exclusiveIndexName(tableName, colName))};`);
      }
      let element = column;
      if (oldProperty.type !== newProperty.type) {
        const conversion = this.propertyConversion(tableName, operation.propertyName, oldProperty.type, newProperty.type);
        element = conversion.using;
        statements.push(...conversion.check);
      }
      statements.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${column} DROP DEFAULT;`,
        `ALTER TABLE ${tableRef} ALTER COLUMN ${column} TYPE ${elementType}[] USING CASE WHEN ${column} IS NULL THEN ${EMPTY_ARRAY} ELSE ARRAY[${element}] END;`,
        `ALTER TABLE ${tableRef} ALTER COLUMN ${column} SET DEFAULT ${EMPTY_ARRAY};`,
        `ALTER TABLE ${tableRef} ALTER COLUMN ${column} SET NOT NULL;`
      );
    } else if (oldProperty.type !== newProperty.type) {
      const conversion = this.propertyConversion(tableName, operation.propertyName, oldProperty.type, newProperty.type, true);
      statements.push(
        ...conversion.check,
        this.retypeColumn(tableName, colName, `${elementType}[]`, conversion.using, true, EMPTY_ARRAY)
      );
    }

    statements.push(...this.generateCheckConstraints(tableName, [newProperty]));
    return statements;
  }

  /**
   * The default a property's column has before and after an AlterProperty:
   * from its ChangeDefault when it has one, else from the property
   * definitions the differ attaches on a type change (`undefined` when
   * neither says).
   */
  private propertyDefaults(operation: Types.AlterPropertyOperation): { new: unknown; old: unknown; } {
    const change = operation.changes.find(c => c.kind === "ChangeDefault");

    return change ?
      { new: change.newValue, old: change.oldValue } :
      { new: operation.newProperty?.default, old: operation.oldProperty?.default };
  }

  /**
   * How a property's stored values convert from EdgeQL type `from` to `to`:
   * the `USING` expression (see {@link castExpression}), and a check naming
   * the first stored value that doesn't convert — none when every value
   * converts (to `str`, or between types stored alike). With `multi`, the
   * column is an array of them. Throws when PostgreSQL has no conversion.
   */
  private propertyConversion(
    tableName: string,
    propertyName: string,
    from: string,
    to: string,
    multi = false
  ): { check: string[]; using: string; } {
    const suffix = multi ? "[]" : "";
    const fromType = `${this.mapEdgeQLTypeToPostgreSQL(from)}${suffix}`;
    const toType = `${this.mapEdgeQLTypeToPostgreSQL(to)}${suffix}`;
    const table = this.escapeIdentifier(tableName);
    const column = this.escapeIdentifier(propNameToColumnName(propertyName));
    const using = this.castExpression(column, fromType, toType);

    if (using === undefined) {
      throw new Error(
        `Cannot change the type of property '${propertyName}' on '${tableName}' from '${from}' to '${to}': ` +
          `PostgreSQL has no conversion from ${fromType} to ${toType}. ` +
          "Add a new property, copy the data over with an explicit conversion, then drop the old one."
      );
    }

    if (fromType === toType || toType === "TEXT" || toType === "TEXT[]")
      return { check: [], using };

    const element = /^array<(.+)>$/.exec(to)?.[1];
    const expected = multi ? `a set of ${to} values` : element ? `an array of ${element} values` : `a valid ${to}`;

    return {
      check: [
        this.valueCheck(
          `${table}.${column}%TYPE`,
          `SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL`,
          this.castExpression("disc_value", fromType, toType)!,
          `Cannot convert ${tableName}.${propNameToColumnName(propertyName)} from ${from} to ${to}: stored value % is not ${expected}`
        )
      ],
      using
    };
  }

  /**
   * Change a single property's column from EdgeQL type `from` to `to`,
   * converting its stored values (see {@link propertyConversion}). The
   * column's default is dropped for the change and `newDefault` set after
   * it, as a ChangeDefault alongside the type change would.
   */
  private generateRetypeProperty(
    tableName: string,
    propertyName: string,
    from: string,
    to: string,
    oldDefault: unknown,
    newDefault: unknown
  ): string[] {
    const conversion = this.propertyConversion(tableName, propertyName, from, to);

    return [
      ...conversion.check,
      this.retypeColumn(
        tableName,
        propNameToColumnName(propertyName),
        this.mapEdgeQLTypeToPostgreSQL(to),
        conversion.using,
        oldDefault !== undefined || newDefault !== undefined,
        newDefault === undefined ? undefined : this.formatDefaultValue(newDefault, to)
      )
    ];
  }

  /*** `DROP CONSTRAINT IF EXISTS` for every CHECK generateCheckConstraints would create for `property`. ***/
  private dropCheckConstraints(tableName: string, property: Types.PropertyDefinition): string[] {
    const tableRef = this.escapeIdentifier(tableName);
    return this.checkConstraintsOf(tableName, property).map(({ name }) => `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(name)};`);
  }

  private generateAddLink(
    tableName: string,
    operation: Types.AddLinkOperation
  ): string[] {
    const statements: string[] = [];
    const link = operation.link;

    if (link.multi) {
      // Multi-valued link - create junction table (skipped if already created or reciprocal exists)
      const junctionTableName = this.claimJunctionTable(tableName, link);
      const targetTable = typeNameToTableName(link.target);

      if (junctionTableName === null) {
        return statements;
      }

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
            onDelete: "CASCADE"
          }
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
            onDelete: this.targetOnDelete(link)
          }
        },
        ...this.linkPropertyColumns(link)
      ];

      statements.push(
        this.generateCreateTableFromColumns(junctionTableName, junctionColumns)
      );
      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(junctionTableName)} ADD CONSTRAINT ${
          this.escapeIdentifier(`uk_${junctionTableName}_source_target`)
        } UNIQUE (source_id, target_id);`
      );
      statements.push(
        ...this.generateCheckConstraints(junctionTableName, link.properties ?? [])
      );
    } else {
      // Single-valued link - add foreign key column
      const columnName = linkColumnName(link.name);
      const nullable = link.required ? "NOT NULL" : "NULL";
      const targetTable = typeNameToTableName(link.target);

      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(columnName)} UUID ${nullable};`
      );
      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(`fk_${tableName}_${columnName}`)} FOREIGN KEY (${
          this.escapeIdentifier(columnName)
        }) REFERENCES ${this.escapeIdentifier(targetTable)} (id) ON DELETE ${this.targetOnDelete(link)};`
      );
      statements.push(
        `CREATE INDEX ${this.escapeIdentifier(`idx_${tableName}_${columnName}`)} ON ${this.escapeIdentifier(tableName)} (${this.escapeIdentifier(columnName)});`
      );
    }

    if (link.exclusive) {
      statements.push(this.generateExclusiveLinkIndex(tableName, link));
    }

    // Generate source delete trigger if needed
    if (link.onSourceDelete === "DELETE TARGET") {
      statements.push(
        ...this.generateSourceDeleteTrigger(tableName, link)
      );
    }

    return statements;
  }

  private generateDropLink(
    tableName: string,
    operation: Types.DropLinkOperation
  ): string[] {
    const statements: string[] = [];
    const linkName = operation.linkName;

    // Drop junction table if it exists
    const junctionTableName = `${tableName}_${linkName}`;
    statements.push(
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(junctionTableName)} CASCADE;`
    );

    // Drop foreign key column if it exists
    const columnName = linkColumnName(linkName);
    statements.push(
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(columnName)};`
    );

    return statements;
  }

  private generateAlterLink(
    tableName: string,
    operation: Types.AlterLinkOperation
  ): string[] {
    // Link properties are columns of the junction table: add/drop/alter them
    // there exactly like a type's properties on its own table.
    const junctionTableName = `${tableName}_${operation.linkName}`;
    const statements: string[] = (operation.propertyOperations ?? []).flatMap(op => this.generateTypeOperationDDL(junctionTableName, op));
    const subject = `link '${operation.linkName}' on '${tableName}'`;

    // Changes with no DDL here throw rather than emit a comment: a comment
    // lets `migrate` record the new schema while the database keeps the old one.
    for (const change of operation.changes) {
      if (change.kind === "ChangeTarget") {
        throw new Error(
          `Cannot migrate ${subject}: changing its target from '${change.oldValue}' to '${change.newValue}' is not supported — ` +
            "existing rows reference the old target. Add a new link, copy the data over, then drop the old one."
        );
      }
      if (change.kind === "ChangeMulti" || change.kind === "ChangeCardinality") {
        const direction = change.newValue === true || change.newValue === "many" ? "single → multi" : "multi → single";
        throw new Error(
          `Cannot migrate ${subject} from ${direction}: the link moves between a foreign-key column and a junction table. ` +
            "Add a new link, copy the data over, then drop the old one."
        );
      }
    }

    // ChangeExtending needs no DDL: inheriting from an abstract link has no storage of its own.
    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeOnDelete":
          statements.push(this.generateReplaceTargetForeignKey(tableName, this.alteredLink(subject, operation)));
          break;
        case "ChangeOnSourceDelete":
          if (change.oldValue === "DELETE TARGET") {
            statements.push(...this.dropSourceDeleteTrigger(tableName, operation.linkName));
          }
          if (change.newValue === "DELETE TARGET") {
            statements.push(...this.generateSourceDeleteTrigger(tableName, this.alteredLink(subject, operation)));
          }
          break;
        case "ChangeRequired":
          // Like CREATE, only a single link's column carries `required`.
          if (!this.alteredLink(subject, operation).multi) {
            statements.push(
              `ALTER TABLE ${this.escapeIdentifier(tableName)} ALTER COLUMN ${this.escapeIdentifier(linkColumnName(operation.linkName))} ${
                change.newValue ? "SET" : "DROP"
              } NOT NULL;`
            );
          }
          break;
        case "ChangeExclusive": {
          const link = this.alteredLink(subject, operation);
          statements.push(
            change.newValue ?
              this.generateExclusiveLinkIndex(tableName, link) :
              `DROP INDEX IF EXISTS ${this.escapeIdentifier(this.exclusiveLinkIndexName(tableName, link))};`
          );
          break;
        }
      }
    }

    if (statements.length === 0) {
      statements.push(
        `-- ALTER LINK ${operation.linkName}: No changes to apply`
      );
    }

    return statements;
  }

  /*** Table and column a link-level `constraint exclusive` makes unique: a single link's `<link>_id`, a multi link's junction `target_id`. ***/
  private exclusiveLinkColumn(tableName: string, link: Types.LinkDefinition): { column: string; table: string; } {
    return link.multi ?
      { column: "target_id", table: `${tableName}_${link.name}` } :
      { column: linkColumnName(link.name), table: tableName };
  }

  /*** Same `uk_<table>_<column>` name a property-level exclusive and a type-level `constraint exclusive on (.link)` use. ***/
  private exclusiveLinkIndexName(tableName: string, link: Types.LinkDefinition): string {
    const { column, table } = this.exclusiveLinkColumn(tableName, link);
    return exclusiveIndexName(table, column);
  }

  private generateExclusiveLinkIndex(tableName: string, link: Types.LinkDefinition): string {
    const { column, table } = this.exclusiveLinkColumn(tableName, link);
    return `CREATE UNIQUE INDEX ${this.escapeIdentifier(exclusiveIndexName(table, column))} ON ${this.escapeIdentifier(table)} (${
      this.escapeIdentifier(column)
    });`;
  }

  /*** The link definition the differ attaches to an AlterLink; the DDL for most link changes needs its target and cardinality. ***/
  private alteredLink(subject: string, operation: Types.AlterLinkOperation): Types.LinkDefinition {
    if (!operation.link) {
      throw new Error(`Cannot migrate ${subject}: the AlterLink operation carries no link definition`);
    }
    return operation.link;
  }

  /**
   * ON DELETE action of the FK from a link to its target. A single link's
   * `<link>_id` column defaults to RESTRICT. A multi link's junction row is the
   * link itself, so it defaults to CASCADE (on create and alter alike), and
   * `allow` / `set empty` cascade too: `target_id` is NOT NULL, so SET NULL
   * could only fail.
   */
  private targetOnDelete(link: Types.LinkDefinition): NonNullable<Types.LinkDefinition["onTargetDelete"]> {
    if (!link.multi) {
      return link.onTargetDelete || "RESTRICT";
    }
    return link.onTargetDelete === "RESTRICT" ? "RESTRICT" : "CASCADE";
  }

  /**
   * Drop and re-add a link's target FK so it carries the link's current ON
   * DELETE action. Same constraint and name CREATE emits: `fk_<table>_<link>_id`
   * on a single link, `fk_<table>_<link>_target_id` on a multi link's junction.
   */
  private generateReplaceTargetForeignKey(tableName: string, link: Types.LinkDefinition): string {
    const table = link.multi ? `${tableName}_${link.name}` : tableName;
    const column: Types.ColumnDefinition = {
      name: link.multi ? "target_id" : linkColumnName(link.name),
      nullable: !link.multi && !link.required,
      primaryKey: false,
      references: {
        column: "id",
        onDelete: this.targetOnDelete(link),
        table: typeNameToTableName(link.target)
      },
      type: "UUID",
      unique: false
    };

    return `ALTER TABLE ${this.escapeIdentifier(table)} DROP CONSTRAINT ${this.escapeIdentifier(this.foreignKeyName(table, column.name))}, ADD ${
      this.generateForeignKeyConstraint(table, column)
    };`;
  }

  private generateCreateTable(operation: Types.CreateTableOperation): string[] {
    return [
      this.generateCreateTableFromColumns(
        operation.tableName,
        operation.columns
      )
    ];
  }

  private generateDropTable(operation: Types.DropTableOperation): string[] {
    return [
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(operation.tableName)} CASCADE;`
    ];
  }

  private generateAlterTable(operation: Types.AlterTableOperation): string[] {
    const statements: string[] = [];

    for (const tableOp of operation.operations) {
      statements.push(
        ...this.generateTableOperationDDL(operation.tableName, tableOp)
      );
    }

    return statements;
  }

  private generateTableOperationDDL(
    tableName: string,
    operation: Types.TableOperation
  ): string[] {
    switch (operation.kind) {
      case "AddColumn":
        return this.generateAddColumn(
          tableName,
          operation as Types.AddColumnOperation
        );
      case "DropColumn":
        return this.generateDropColumn(
          tableName,
          operation as Types.DropColumnOperation
        );
      case "AlterColumn":
        return this.generateAlterColumn(
          tableName,
          operation as Types.AlterColumnOperation
        );
      default:
        throw new Error(`Unsupported table operation: ${operation.kind}`);
    }
  }

  private generateAddColumn(
    tableName: string,
    operation: Types.AddColumnOperation
  ): string[] {
    const column = operation.column;
    const nullable = column.nullable ? "NULL" : "NOT NULL";
    const defaultClause = column.default ? ` DEFAULT ${column.default}` : "";

    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(column.name)} ${column.type} ${nullable}${defaultClause};`
    ];
  }

  private generateDropColumn(
    tableName: string,
    operation: Types.DropColumnOperation
  ): string[] {
    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.columnName)};`
    ];
  }

  private generateAlterColumn(
    tableName: string,
    operation: Types.AlterColumnOperation
  ): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.columnName);
    const tableRef = this.escapeIdentifier(tableName);

    for (const change of operation.changes) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${change.newValue};`
          );
          break;
        case "ChangeNullable":
          if (change.newValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`
            );
          }
          break;
        case "ChangeDefault":
          if (change.newValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${change.newValue};`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`
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
    const ifNotExists = operation.ifNotExists ? "IF NOT EXISTS " : "";
    const method = index.method ? ` USING ${index.method.toUpperCase()}` : "";
    const partial = index.partial ? ` WHERE ${index.partial}` : "";
    const columns = index.columns.map(col => this.escapeIdentifier(col)).join(
      ", "
    );

    return [
      `CREATE ${unique}INDEX ${ifNotExists}${this.escapeIdentifier(index.name)} ON ${this.escapeIdentifier(index.table)}${method} (${columns})${partial};`
    ];
  }

  private generateDropIndex(operation: Types.DropIndexOperation): string[] {
    return [
      `DROP INDEX IF EXISTS ${this.escapeIdentifier(operation.indexName)};`
    ];
  }

  private generateCreateTableFromColumns(
    tableName: string,
    columns: Types.ColumnDefinition[],
    options: { inlineFKs?: boolean; } = {}
  ): string {
    const inlineFKs = options.inlineFKs ?? true;
    const columnDefs = columns.map(col => this.generateColumnDefinition(col));
    const constraints = inlineFKs ?
      columns
        .filter(col => col.references)
        .map(col => this.generateForeignKeyConstraint(tableName, col)) :
      [];

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
    column: Types.ColumnDefinition
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

  private foreignKeyName(tableName: string, columnName: string): string {
    return `fk_${tableName}_${columnName}`;
  }

  private generateForeignKeyConstraint(
    tableName: string,
    column: Types.ColumnDefinition
  ): string {
    if (!column.references) {
      throw new Error("Column does not have foreign key reference");
    }

    const constraintName = this.foreignKeyName(tableName, column.name);
    const onDelete = column.references.onDelete ?
      ` ON DELETE ${column.references.onDelete}` :
      "";
    const onUpdate = column.references.onUpdate ?
      ` ON UPDATE ${column.references.onUpdate}` :
      "";

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
    properties: Types.PropertyDefinition[]
  ): string[] {
    return properties.flatMap(property =>
      this.checkConstraintsOf(tableName, property).map(({ name, expression }) =>
        `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(name)} CHECK (${expression});`
      )
    );
  }

  /**
   * The CHECK constraints of one property, by name. A multi property's
   * constraints hold for every element, and `required multi` adds a
   * non-empty check (the column itself is always NOT NULL).
   */
  private checkConstraintsOf(
    tableName: string,
    property: Types.PropertyDefinition
  ): { name: string; expression: string; }[] {
    if (property.computed) {
      return [];
    }
    const colName = propNameToColumnName(property.name);
    const elementType = property.multi ? this.mapEdgeQLTypeToPostgreSQL(property.type) : undefined;
    const checks: { name: string; expression: string; }[] = [];

    for (const constraint of property.constraints) {
      const expression = elementType ?
        this.multiConstraintToCheckExpression(colName, constraint, elementType) :
        this.constraintToCheckExpression(colName, constraint);
      if (expression) {
        checks.push({ name: checkConstraintName(tableName, colName, constraint), expression });
      }
    }

    if (property.multi && property.required) {
      checks.push({
        name: `chk_${tableName}_${colName}_required`,
        expression: `cardinality(${this.escapeIdentifier(colName)}) > 0`
      });
    }

    return checks;
  }

  /**
   * A constraint on a multi property, applied to every element of its array
   * column. CHECK can't hold a subquery, so bounds compare against `ALL(col)`,
   * `one_of` is containment in the allowed array, and the string tests call
   * the IMMUTABLE `disc_array_*` helpers from lib/stdlib-sql.ts. An empty
   * array passes every check. `exclusive` and `expression on` are rejected on
   * multi properties by the schema validator, so they map to nothing here.
   */
  private multiConstraintToCheckExpression(
    columnName: string,
    constraint: string,
    elementType: string
  ): string | null {
    const col = this.escapeIdentifier(columnName);
    const match = constraint.match(/^(\w+)(?:\((.+)\))?$/);
    const arg = match?.[2]?.trim();
    if (!match || !arg) {
      return null;
    }

    switch (match[1]) {
      case "one_of":
        return `${col} <@ ARRAY[${this.oneOfValues(arg).join(", ")}]::${elementType}[]`;
      case "min_value":
        return `${arg} <= ALL(${col})`;
      case "max_value":
        return `${arg} >= ALL(${col})`;
      case "min_ex_value":
        return `${arg} < ALL(${col})`;
      case "max_ex_value":
        return `${arg} > ALL(${col})`;
      case "max_len_value":
        return `disc_array_max_len(${col}) <= ${arg}`;
      case "min_len_value":
        return `disc_array_min_len(${col}) >= ${arg}`;
      case "regexp":
        return `disc_array_all_match(${col}, '${arg.replace(/'/g, "''")}')`;
    }

    return null;
  }

  /*** The SQL literals of a serialized `one_of(a,b,…)` argument list. ***/
  private oneOfValues(arg: string): string[] {
    return arg.split(",").map((v: string) => {
      const trimmed = v.trim();
      // If already quoted (from differ serialization), use as-is
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed;
      }
      // Numeric values don't need quoting
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
      }
      // String values need single-quote wrapping
      return `'${trimmed.replace(/'/g, "''")}'`;
    });
  }

  /**
   * Convert an EdgeQL constraint string to a SQL CHECK expression.
   * Returns null for constraints that are not mapped to CHECK (e.g. exclusive).
   */
  private constraintToCheckExpression(
    columnName: string,
    constraint: string
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
        if (arg) {
          return `length(${col}) <= ${arg}`;
        }
        break;
      case "min_len_value":
        if (arg) {
          return `length(${col}) >= ${arg}`;
        }
        break;
      case "max_value":
        if (arg) {
          return `${col} <= ${arg}`;
        }
        break;
      case "min_value":
        if (arg) {
          return `${col} >= ${arg}`;
        }
        break;
      case "regexp":
        if (arg) {
          return `${col} ~ '${arg.replace(/'/g, "''")}'`;
        }
        break;
      case "max_ex_value":
        if (arg) {
          return `${col} < ${arg}`;
        }
        break;
      case "min_ex_value":
        if (arg) {
          return `${col} > ${arg}`;
        }
        break;
      case "one_of":
        if (arg) {
          return `${col} IN (${this.oneOfValues(arg).join(", ")})`;
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

  /*** The column type of a stored property: a multi property is an array of its element type. ***/
  /**
   * The junction-table columns of a multi link's link properties, typed like
   * the columns of ordinary properties (`required` → NOT NULL, `default`).
   */
  private linkPropertyColumns(link: Types.LinkDefinition): Types.ColumnDefinition[] {
    return (link.properties ?? []).map(property => ({
      name: propNameToColumnName(property.name),
      type: this.propertyColumnType(property),
      nullable: !property.required,
      primaryKey: false,
      unique: false,
      default: property.default !== undefined ? this.formatDefaultValue(property.default, property.type) : undefined
    }));
  }

  /*** The column type of a stored property as the DDL emits it (public for the TEXT-column backfill). ***/
  propertyColumnType(property: Types.PropertyDefinition): string {
    const pgType = this.mapEdgeQLTypeToPostgreSQL(property.type);
    return property.multi ? `${pgType}[]` : pgType;
  }

  private mapEdgeQLTypeToPostgreSQL(edgeqlType: string): string {
    const typeMap: Record<string, string> = {
      str: "TEXT",
      int16: "SMALLINT",
      int32: "INTEGER",
      int64: "BIGINT",
      float32: "REAL",
      float64: "DOUBLE PRECISION",
      decimal: "DECIMAL",
      bigint: "NUMERIC",
      bool: "BOOLEAN",
      uuid: "UUID",
      datetime: "TIMESTAMP WITH TIME ZONE",
      duration: "INTERVAL",
      bytes: "BYTEA",
      json: "JSONB",
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
      "array<duration>": "INTERVAL[]",
      "array<json>": "JSONB[]",
      "array<bytes>": "BYTEA[]",
      "array<bigint>": "NUMERIC[]",
      "array<decimal>": "NUMERIC[]",
      "array<cal::local_date>": "DATE[]",
      "array<cal::local_time>": "TIME WITHOUT TIME ZONE[]",
      "array<cal::local_datetime>": "TIMESTAMP WITHOUT TIME ZONE[]",
      "array<cal::relative_duration>": "INTERVAL[]",
      "array<cal::date_duration>": "INTERVAL[]",
      // Range types
      "range<int32>": "INT4RANGE",
      "range<int64>": "INT8RANGE",
      "range<float32>": "NUMRANGE",
      "range<float64>": "NUMRANGE",
      "range<decimal>": "NUMRANGE",
      "range<datetime>": "TSTZRANGE",
      "range<cal::local_date>": "DATERANGE",
      "range<cal::local_datetime>": "TSRANGE",
      // Multirange types
      "multirange<int32>": "INT4MULTIRANGE",
      "multirange<int64>": "INT8MULTIRANGE",
      "multirange<float32>": "NUMMULTIRANGE",
      "multirange<float64>": "NUMMULTIRANGE",
      "multirange<decimal>": "NUMMULTIRANGE",
      "multirange<datetime>": "TSTZMULTIRANGE",
      "multirange<cal::local_date>": "DATEMULTIRANGE",
      "multirange<cal::local_datetime>": "TSMULTIRANGE"
    };

    if (typeMap[edgeqlType]) {
      return typeMap[edgeqlType];
    }

    // `array<range<int32>>` is an array of the range type (likewise multiranges).
    const rangeArrayType = typeMap[/^array<((?:multi)?range<.+>)>$/.exec(edgeqlType)?.[1] ?? ""];
    if (rangeArrayType) {
      return `${rangeArrayType}[]`;
    }

    // Tuple types map to JSONB (PostgreSQL has no native tuple type).
    // Arrays of tuples (`array<tuple<...>>`) likewise map to JSONB rather
    // than a Postgres array, since their element type has no native column type.
    if (edgeqlType.startsWith("tuple<") || edgeqlType.startsWith("array<tuple<")) {
      return "JSONB";
    }

    // User-declared enum scalar — resolve to the PG enum type emitted
    // by `generateCreateScalar`. (gh/geldata#8517) Falls through to
    // TEXT below when no scalar registry was supplied (back-compat).
    // The property's `type` string may be qualified (`module::Name`)
    // or bare (`Name`); the registry maps both to the enum's PG type.
    const enumType = this.enumScalars.get(edgeqlType);
    if (enumType) {
      return this.escapeIdentifier(enumType);
    }

    // `array<Enum>` is an array of the enum type, like a multi enum property.
    const enumArrayType = this.enumScalars.get(/^array<(.+)>$/.exec(edgeqlType)?.[1] ?? "");
    if (enumArrayType) {
      return `${this.escapeIdentifier(enumArrayType)}[]`;
    }

    // A user scalar extending another type (`scalar type Count extending
    // int64`) is stored as that type; `array<Count>` as an array of it.
    const baseType = this.scalarBaseTypes.get(edgeqlType);
    if (baseType) {
      return this.mapEdgeQLTypeToPostgreSQL(baseType);
    }

    const arrayBaseType = this.scalarBaseTypes.get(/^array<(.+)>$/.exec(edgeqlType)?.[1] ?? "");
    if (arrayBaseType) {
      return this.mapEdgeQLTypeToPostgreSQL(`array<${arrayBaseType}>`);
    }

    return "TEXT";
  }

  private formatDefaultValue(value: any, type: string): string {
    if (value === null || value === undefined) {
      return "NULL";
    }

    if (typeof value === "string") {
      // EdgeQL function-call defaults arrive here as serialized strings
      // (e.g. "datetime_of_transaction()"). Detect the function-call shape
      // and emit raw SQL with the EdgeQL→SQL builtin mapping. Without this
      // they'd be quoted as text and PG would reject them at apply time
      // ("invalid input syntax for type timestamp with time zone").
      if (/^[A-Za-z_][A-Za-z0-9_:]*\s*\(.*\)\s*$/.test(value)) {
        return this.compileExpressionString(value);
      }

      // Enum defaults arrive as serialized PathExpressions. The runtime
      // Schema serializer uses `path.join("")` to collapse the parser's
      // interleaved dots, but the differ uses `path.join(".")` which can
      // produce shapes like `MerchantStatus.PENDING`. Pull the trailing
      // identifier and emit a literal value the enum column will accept.
      if (
        this.enumScalars.has(type) ||
        this.enumScalars.has(type.replace(/^default::/, ""))
      ) {
        const tail = value.split(".").pop() ?? value;
        return `'${tail.replace(/'/g, "''")}'`;
      }

      // Numeric-typed columns whose default arrives as a stringified
      // number (e.g. `default := 1` for an int64 col) — keep the integer
      // shape rather than quoting it as text.
      if (this.isNumericPgType(type) && /^-?\d+(\.\d+)?$/.test(value)) {
        return value;
      }

      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "number") {
      const str = String(value);
      // Integer columns get an integer literal; float columns keep the
      // decimal point so PG infers the right numeric type.
      if (this.isIntegerPgType(type)) {
        return str.includes(".") ? String(Math.trunc(value)) : str;
      }
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

  /**
   * Compile a serialized EdgeQL expression (function calls, builtins) into
   * raw SQL by substituting EdgeQL function names with their Postgres
   * equivalents. Mirrors `compileRewriteExpression()` but for default-value
   * context, where there's no `__subject__` / `__old__` substitution.
   */
  private compileExpressionString(expr: string): string {
    return expr
      .replace(/datetime_of_statement\(\)/g, "statement_timestamp()")
      .replace(/datetime_current\(\)/g, "now()")
      .replace(/datetime_of_transaction\(\)/g, "transaction_timestamp()");
  }

  private isIntegerPgType(type: string): boolean {
    const t = type.toLowerCase();
    return t === "int16" || t === "int32" || t === "int64" ||
      t === "smallint" || t === "integer" || t === "bigint";
  }

  private isNumericPgType(type: string): boolean {
    if (this.isIntegerPgType(type)) {
      return true;
    }
    const t = type.toLowerCase();
    return t === "float32" || t === "float64" || t === "decimal" ||
      t === "real" || t === "double precision" || t === "numeric";
  }

  private escapeIdentifier(identifier: string): string {
    if (isReservedPgKeyword(identifier)) {
      return `"${identifier.replace(/"/g, "\"\"")}"`;
    }

    // Check if identifier needs escaping due to special characters
    if (/^[a-z][a-z0-9_]*$/.test(identifier)) {
      return identifier;
    }

    return `"${identifier.replace(/"/g, "\"\"")}"`;
  }

  // ========================================
  // Trigger DDL Generation Methods
  // ========================================

  private generateCreateTrigger(
    tableName: string,
    trigger: Types.TriggerDefinition
  ): string[] {
    const fnName = `${tableName}__${trigger.name}_fn`;
    const triggerName = `${tableName}__${trigger.name}`;

    // Replace EdgeQL trigger variables with PostgreSQL equivalents
    const body = trigger
      .body
      .replace(/__new__/g, "NEW")
      .replace(/__old__/g, "OLD")
      .replace(/__action__/g, "TG_OP");

    const timing = trigger.timing.toUpperCase();
    const events = trigger.events.map(e => e.toUpperCase()).join(" OR ");
    const scope = trigger.scope === "each" ? "ROW" : "STATEMENT";

    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN ${body}; RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} ${timing} ${events} ON ${this.escapeIdentifier(tableName)} FOR EACH ${scope} EXECUTE FUNCTION ${
        this.escapeIdentifier(fnName)
      }();`
    ];
  }

  private generateDropTrigger(
    tableName: string,
    triggerName: string
  ): string[] {
    const pgTriggerName = `${tableName}__${triggerName}`;
    const fnName = `${tableName}__${triggerName}_fn`;

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(pgTriggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`
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
    link: Types.LinkDefinition
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
        }();`
      ];
    }

    // Single-valued link: delete from target where id matches
    const columnName = linkColumnName(link.name);
    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN DELETE FROM ${
        this.escapeIdentifier(targetTable)
      } WHERE id = OLD.${this.escapeIdentifier(columnName)}; RETURN OLD; END; $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} BEFORE DELETE ON ${this.escapeIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${
        this.escapeIdentifier(fnName)
      }();`
    ];
  }

  /**
   * Generate DROP statements for a source delete trigger and its function.
   */
  private dropSourceDeleteTrigger(
    tableName: string,
    linkName: string
  ): string[] {
    const fnName = `disc_source_delete_${tableName}_${linkName}`;
    const triggerName = `trg_source_delete_${tableName}_${linkName}`;

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(triggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`
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
    rewrite: Types.RewriteDefinition
  ): string[] {
    const colName = propNameToColumnName(propertyName);
    const fnName = `${tableName}__${colName}__rewrite_fn`;
    const triggerName = `${tableName}__${colName}__rewrite`;

    // Compile the rewrite body expression with variable substitutions
    const compiledExpr = this.compileRewriteExpression(rewrite.body);

    // Build event list from rewrite events
    const eventList = rewrite.events.map(e => e.toUpperCase()).join(" OR ");

    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(fnName)}() RETURNS TRIGGER AS $$ BEGIN NEW.${
        this.escapeIdentifier(colName)
      } := ${compiledExpr}; RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(triggerName)} BEFORE ${eventList} ON ${this.escapeIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${
        this.escapeIdentifier(fnName)
      }();`
    ];
  }

  /**
   * Generate DROP statements for a rewrite rule's trigger and function.
   */
  private generateDropRewrite(
    tableName: string,
    propertyName: string,
    _events: ("insert" | "update")[]
  ): string[] {
    const colName = propNameToColumnName(propertyName);
    const triggerName = `${tableName}__${colName}__rewrite`;
    const fnName = `${tableName}__${colName}__rewrite_fn`;

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(triggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`
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
    operation: Types.CreateTypeOperation
  ): string[] {
    // To rollback CreateType, we drop everything its forward DDL created
    const tableName = typeNameToTableName(operation.typeName);
    const statements: string[] = [];

    /*** Dropping the table drops its triggers but not their functions. ***/
    for (const trigger of operation.triggers ?? []) {
      statements.push(...this.generateDropTrigger(tableName, trigger.name));
    }

    for (const property of operation.properties) {
      for (const rewrite of property.rewrites ?? []) {
        statements.push(...this.generateDropRewrite(tableName, property.name, rewrite.events));
      }
    }

    for (const link of operation.links) {
      if (link.onSourceDelete === "DELETE TARGET") {
        statements.push(...this.dropSourceDeleteTrigger(tableName, link.name));
      }
    }

    /*** Junctions are sibling tables: the table's CASCADE only drops their foreign keys. ***/
    for (const link of operation.links) {
      if (link.multi && this.junctionCreatedFor(tableName, link)) {
        statements.push(`DROP TABLE IF EXISTS ${this.escapeIdentifier(`${tableName}_${link.name}`)} CASCADE;`);
      }
    }

    statements.push(`DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)} CASCADE;`);
    return statements;
  }

  /**
   * Whether the forward DDL of the batch being rolled back created the junction table of the
   * multi link `link` of `tableName` — false when a reciprocal link's junction stood in for it
   * (see `claimJunctionTable`, replayed by `generateRollbackDDL`).
   */
  private junctionCreatedFor(tableName: string, link: Types.LinkDefinition): boolean {
    return this.createdJunctionTables.has(`${tableName}_${link.name}`);
  }

  private generateRollbackDropType(
    operation: Types.DropTypeOperation
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
END $$;`
    ];
  }

  private generateRollbackAlterType(
    operation: Types.AlterTypeOperation
  ): string[] {
    const statements: string[] = [];
    const tableName = typeNameToTableName(operation.typeName);

    // Process type operations in reverse order
    for (const typeOp of [...operation.operations].reverse()) {
      statements.push(...this.generateRollbackTypeOperation(tableName, typeOp));
    }

    return statements;
  }

  private generateRollbackTypeOperation(
    tableName: string,
    operation: Types.TypeOperation
  ): string[] {
    switch (operation.kind) {
      case "AddProperty":
        return this.generateRollbackAddProperty(
          tableName,
          operation as Types.AddPropertyOperation
        );
      case "DropProperty":
        return this.generateRollbackDropProperty(
          tableName,
          operation as Types.DropPropertyOperation
        );
      case "AlterProperty":
        return this.generateRollbackAlterProperty(
          tableName,
          operation as Types.AlterPropertyOperation
        );
      case "AddLink":
        return this.generateRollbackAddLink(
          tableName,
          operation as Types.AddLinkOperation
        );
      case "DropLink":
        return this.generateRollbackDropLink(
          tableName,
          operation as Types.DropLinkOperation
        );
      case "AlterLink":
        return this.generateRollbackAlterLink(
          tableName,
          operation as Types.AlterLinkOperation
        );
      case "AddTrigger":
        // Rollback AddTrigger = DropTrigger
        return this.generateDropTrigger(
          tableName,
          (operation as Types.AddTriggerOperation).trigger.name
        );
      case "DropTrigger":
        // Can't restore trigger body from just the name
        return [
          `-- MANUAL ROLLBACK REQUIRED: Recreate trigger '${(operation as Types.DropTriggerOperation).triggerName}' on table '${tableName}'`,
          `-- The original trigger body was lost when it was dropped.`,
          `-- Please refer to backup or documentation for the original trigger definition.`
        ];
      case "AddRewrite": {
        // Rollback AddRewrite = DropRewrite
        const addRewriteOp = operation as Types.AddRewriteOperation;
        return this.generateDropRewrite(
          tableName,
          addRewriteOp.propertyName,
          addRewriteOp.rewrite.events
        );
      }
      case "DropRewrite": {
        // Can't restore rewrite body from just the property name and events
        const dropRewriteOp = operation as Types.DropRewriteOperation;
        return [
          `-- MANUAL ROLLBACK REQUIRED: Recreate rewrite rule for property '${dropRewriteOp.propertyName}' on table '${tableName}'`,
          `-- Events: ${dropRewriteOp.events.join(", ")}`,
          `-- The original rewrite body was lost when it was dropped.`,
          `-- Please refer to backup or documentation for the original rewrite definition.`
        ];
      }
      default:
        throw new Error(
          `Unsupported rollback type operation: ${operation.kind}`
        );
    }
  }

  private generateRollbackAddProperty(
    tableName: string,
    operation: Types.AddPropertyOperation
  ): string[] {
    // Computed properties have no column — nothing to roll back
    if (operation.property.computed) {
      return [
        `-- Computed property '${operation.property.name}' was virtual, no column to drop`
      ];
    }

    // To rollback AddProperty, we drop the column
    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(propNameToColumnName(operation.property.name))};`
    ];
  }

  private generateRollbackDropProperty(
    tableName: string,
    operation: Types.DropPropertyOperation
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
END $$;`
    ];
  }

  private generateRollbackAlterProperty(
    tableName: string,
    operation: Types.AlterPropertyOperation
  ): string[] {
    // A multi property change can't be undone column-by-column (multi → single
    // loses values), so, as for DropProperty, fail loudly instead.
    if (operation.oldProperty?.multi || operation.newProperty?.multi) {
      return [
        `-- MANUAL ROLLBACK REQUIRED: multi property '${tableName}.${operation.propertyName}' was altered`,
        `DO $$ BEGIN
  RAISE EXCEPTION 'Cannot auto-rollback AlterProperty on multi property "${tableName}.${operation.propertyName}".';
END $$;`
      ];
    }

    const statements: string[] = [];
    const colName = propNameToColumnName(operation.propertyName);
    const columnName = this.escapeIdentifier(colName);
    const tableRef = this.escapeIdentifier(tableName);
    const defaults = this.propertyDefaults(operation);
    const retyped = operation.changes.some(change => change.kind === "ChangeType");

    // Process changes in reverse order
    for (const change of [...operation.changes].reverse()) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            ...this.generateRetypeProperty(tableName, operation.propertyName, change.newValue, change.oldValue, defaults.new, defaults.old)
          );
          break;
        case "ChangeRequired":
          if (change.oldValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`
            );
          }
          break;
        case "ChangeDefault":
          // The type change back sets the old default itself (see generateRetypeProperty).
          if (retyped) {
            break;
          }
          if (change.oldValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${this.formatDefaultValue(change.oldValue, "unknown")};`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`
            );
          }
          break;
        case "AddConstraint": {
          // Rollback: drop the constraint that was added
          const constraintName = checkConstraintName(tableName, colName, change.newValue);
          statements.push(
            `ALTER TABLE ${tableRef} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(constraintName)};`
          );
          break;
        }
        case "DropConstraint": {
          // Rollback: re-add the constraint that was dropped
          const checkExpr = this.constraintToCheckExpression(
            colName,
            change.oldValue
          );
          if (checkExpr) {
            const constraintName = checkConstraintName(tableName, colName, change.oldValue);
            statements.push(
              `ALTER TABLE ${tableRef} ADD CONSTRAINT ${this.escapeIdentifier(constraintName)} CHECK (${checkExpr});`
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
    operation: Types.AddLinkOperation
  ): string[] {
    const link = operation.link;
    const linkName = link.name;

    /*** The source table survives the rollback, so its delete-target trigger must go explicitly. ***/
    const statements: string[] = link.onSourceDelete === "DELETE TARGET" ?
      this.dropSourceDeleteTrigger(tableName, linkName) :
      [];

    // Drop junction table if it was a multi-link that created one
    if (link.multi) {
      if (this.junctionCreatedFor(tableName, link)) {
        const junctionTableName = `${tableName}_${linkName}`;
        statements.push(
          `DROP TABLE IF EXISTS ${this.escapeIdentifier(junctionTableName)} CASCADE;`
        );
      }
    } else {
      // Drop foreign key column if it was a single-link
      const columnName = linkColumnName(linkName);
      statements.push(
        `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(columnName)};`
      );
    }

    return statements;
  }

  private generateRollbackDropLink(
    tableName: string,
    operation: Types.DropLinkOperation
  ): string[] {
    // To rollback DropLink, we would need to recreate the link
    // This requires the original link definition which we don't have
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate link '${operation.linkName}' on table '${tableName}'`,
      `-- This may involve creating a junction table or adding a foreign key column.`,
      `-- Please refer to backup or documentation for the original link structure.`
    ];
  }

  private generateRollbackAlterLink(
    tableName: string,
    operation: Types.AlterLinkOperation
  ): string[] {
    // Link alteration rollback is complex and requires the original link definition
    return [
      `-- MANUAL ROLLBACK REQUIRED: Revert changes to link '${operation.linkName}' on table '${tableName}'`,
      `-- Link alterations may involve changing junction tables or foreign key constraints.`,
      `-- Please refer to backup or documentation for the original link configuration.`
    ];
  }

  private generateRollbackCreateTable(
    operation: Types.CreateTableOperation
  ): string[] {
    return [
      `DROP TABLE IF EXISTS ${this.escapeIdentifier(operation.tableName)} CASCADE;`
    ];
  }

  private generateRollbackDropTable(
    operation: Types.DropTableOperation
  ): string[] {
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate table '${operation.tableName}'`,
      `-- The original table structure was lost when it was dropped.`,
      `-- Please restore from backup or recreate the table manually.`
    ];
  }

  private generateRollbackAlterTable(
    operation: Types.AlterTableOperation
  ): string[] {
    const statements: string[] = [];

    // Process table operations in reverse order
    for (const tableOp of [...operation.operations].reverse()) {
      statements.push(
        ...this.generateRollbackTableOperation(operation.tableName, tableOp)
      );
    }

    return statements;
  }

  private generateRollbackTableOperation(
    tableName: string,
    operation: Types.TableOperation
  ): string[] {
    switch (operation.kind) {
      case "AddColumn":
        return this.generateRollbackAddColumn(
          tableName,
          operation as Types.AddColumnOperation
        );
      case "DropColumn":
        return this.generateRollbackDropColumn(
          tableName,
          operation as Types.DropColumnOperation
        );
      case "AlterColumn":
        return this.generateRollbackAlterColumn(
          tableName,
          operation as Types.AlterColumnOperation
        );
      default:
        throw new Error(
          `Unsupported rollback table operation: ${operation.kind}`
        );
    }
  }

  private generateRollbackAddColumn(
    tableName: string,
    operation: Types.AddColumnOperation
  ): string[] {
    return [
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(operation.column.name)};`
    ];
  }

  private generateRollbackDropColumn(
    tableName: string,
    operation: Types.DropColumnOperation
  ): string[] {
    return [
      `-- MANUAL ROLLBACK REQUIRED: Add column '${operation.columnName}' back to table '${tableName}'`,
      `-- ALTER TABLE ${this.escapeIdentifier(tableName)} ADD COLUMN ${this.escapeIdentifier(operation.columnName)} <TYPE> <CONSTRAINTS>;`,
      `-- Please determine the correct type and constraints from backup or documentation.`
    ];
  }

  private generateRollbackAlterColumn(
    tableName: string,
    operation: Types.AlterColumnOperation
  ): string[] {
    const statements: string[] = [];
    const columnName = this.escapeIdentifier(operation.columnName);
    const tableRef = this.escapeIdentifier(tableName);

    // Process changes in reverse order
    for (const change of [...operation.changes].reverse()) {
      switch (change.kind) {
        case "ChangeType":
          statements.push(
            `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} TYPE ${change.oldValue};`
          );
          break;
        case "ChangeNullable":
          if (change.oldValue) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP NOT NULL;`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET NOT NULL;`
            );
          }
          break;
        case "ChangeDefault":
          if (change.oldValue !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${change.oldValue};`
            );
          } else {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} DROP DEFAULT;`
            );
          }
          break;
      }
    }

    return statements;
  }

  private generateRollbackCreateIndex(
    operation: Types.CreateIndexOperation
  ): string[] {
    return [
      `DROP INDEX IF EXISTS ${this.escapeIdentifier(operation.index.name)};`
    ];
  }

  private generateRollbackDropIndex(
    operation: Types.DropIndexOperation
  ): string[] {
    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate index '${operation.indexName}'`,
      `-- The original index definition was lost when it was dropped.`,
      `-- Please refer to backup or documentation for the original index structure.`
    ];
  }
}
