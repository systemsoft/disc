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
  sequenceName,
  typeNameToTableName
} from "../lib/identifiers.ts";
import { sqlStringLiteral } from "../lib/sql-escape.ts";
import * as Types from "./types.ts";

/** The empty-set value of a multi property's array column (its default). */
const EMPTY_ARRAY = "'{}'";

/**
 * The trigger function keeping a concrete type's rows copied in the tables of
 * its abstract ancestors, named by the trigger's arguments (see
 * `MirrorAbstractTypeOperation`). A copy is the row read as the abstract
 * table's record, so it needs no column list of its own: an update rewrites
 * every column the abstract table has, read from pg_attribute.
 */
const ABSTRACT_MIRROR_FUNCTION = `CREATE OR REPLACE FUNCTION disc_abstract_mirror() RETURNS trigger AS $$
  DECLARE
    target text;
    target_columns text;
  BEGIN
    FOREACH target IN ARRAY TG_ARGV LOOP
      IF TG_OP = 'INSERT' THEN
        EXECUTE format('INSERT INTO %I SELECT (jsonb_populate_record(NULL::%I, $1)).*', target, target) USING to_jsonb(NEW);
      ELSIF TG_OP = 'UPDATE' THEN
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO target_columns
        FROM pg_attribute
        WHERE attrelid = format('%I', target)::regclass AND attnum > 0 AND NOT attisdropped;
        EXECUTE format('UPDATE %I SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::%I, $1)) WHERE id = $2', target, target_columns, target_columns, target)
          USING to_jsonb(NEW), OLD.id;
      ELSE
        EXECUTE format('DELETE FROM %I WHERE id = $1', target) USING OLD.id;
      END IF;
    END LOOP;
    RETURN NULL;
  END;
$$ LANGUAGE plpgsql;`;

/**
 * How a link to an abstract type defers its FK (see
 * `LinkDefinition.targetAbstract`). Only the check that the target exists
 * waits for the commit: PostgreSQL never defers a RESTRICT, CASCADE or SET
 * NULL action, so deleting a target behaves the same as without it. A
 * `deferred restrict` link's NO ACTION FK is deferred the same way, and NO
 * ACTION is checked at commit too.
 */
const DEFERRED = " DEFERRABLE INITIALLY DEFERRED";

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

/*** Name of the CHECK keeping NaN and ±Infinity (and a bigint's fractional part) out of a decimal or bigint column. ***/
function finiteCheckName(tableName: string, columnName: string): string {
  return `chk_${tableName}_${columnName}_finite`;
}

/*** What a decimal (or bigint) value is not: PostgreSQL's numeric has them, Gel's types don't. ***/
const NON_FINITE_NUMERIC = "('NaN', 'Infinity', '-Infinity')";

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
   * The PostgreSQL sequence of each sequence scalar (`scalar type TicketNo
   * extending sequence`), so a property of one defaults to its next value.
   * Populated via {@link setSequenceScalars}.
   */
  private sequenceScalars = new Map<string, string>();
  /**
   * During `generateRollbackDDL`: the operations migrating the schema after the
   * migration back to the schema before it, where the rollback finds the
   * definitions of what the migration dropped. Empty when the caller has none.
   */
  private reverseOperations: Types.MigrationOperation[] = [];
  /**
   * During `generateRollbackDDL`: each dropped object its restore statements
   * recreate (see `restoreOperations`), by `dropKey`, with the operation of
   * `reverseOperations` recreating it.
   */
  private restoredDrops = new Map<string, Types.MigrationOperation | Types.TypeOperation>();

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

  /*** Tell the generator the sequence of each sequence scalar (from `SchemaDiffer.sequenceScalarNames`). ***/
  setSequenceScalars(sequences: Map<string, string>): void {
    this.sequenceScalars = new Map(sequences);
  }

  generateDDL(operations: Types.MigrationOperation[]): string[] {
    this.createdJunctionTables.clear();
    this.deferredStatements = [];
    const statements: string[] = [];
    const addedChecks: string[] = [];

    for (const operation of operations) {
      (operation.kind === "AddCheck" ? addedChecks : statements).push(...this.generateOperationDDL(operation));
    }

    // Two-phase emission: all base CREATE TABLEs first, then deferred
    // FK constraints + junction tables. By the time deferred runs, all
    // base tables in the batch exist, so cross-references resolve.
    // Constraint CHECKs last: a link property's is on a junction table.
    statements.push(...this.deferredStatements, ...addedChecks);

    return statements;
  }

  /**
   * Generate rollback DDL statements for the given operations
   * These are the operations that would undo the forward migration
   *
   * `reverse` migrates the schema after the operations back to the schema
   * before them (`SchemaDiffer.diff(after, before)`). What the operations drop
   * — types, properties, links, link properties, indexes, triggers, rewrites,
   * enums, sequences — is recreated from its definition there by the forward
   * CREATE path (see `restoreOperations`), with a `-- RESTORED EMPTY:` comment
   * for each table, column or link whose data doesn't come back. Without
   * `reverse`, each of those drops is a `-- MANUAL ROLLBACK REQUIRED` step.
   */
  generateRollbackDDL(operations: Types.MigrationOperation[], reverse: Types.MigrationOperation[] = []): string[] {
    /*** Enums and sequences come back first: undoing a change can convert a column back to one.
         Everything else comes back last, once what replaced it (an index of the same name, a
         trigger of the same name) is gone. Generated first: `generateDDL` resets the junction
         claims the undo steps replay below. A rollback with nothing to recreate doesn't call it. ***/
    this.reverseOperations = reverse;
    const restore = this.restoreOperations(operations);
    const restoreScalars = restore.scalars.length > 0 ? this.generateDDL(restore.scalars) : [];
    const restoreObjects = restore.objects.length > 0 ? this.generateDDL(restore.objects) : [];
    const statements: string[] = [...restoreScalars];

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

    // Process operations in reverse order for rollback. A dropped CHECK comes
    // back last: the column or table it reads may be one restored above.
    const restoredChecks: string[] = [];

    for (const operation of [...operations].reverse()) {
      (operation.kind === "DropCheck" ? restoredChecks : statements).push(...this.generateRollbackOperationDDL(operation));
    }

    return [...statements, ...restoreObjects, ...restoredChecks];
  }

  /**
   * The operations of `reverseOperations` that recreate what `operations`
   * drop, in their order there (enums, then types with their indexes, then
   * the members and indexes of surviving types), split into the enums and
   * sequences (`scalars`) and the rest (`objects`). Each dropped type comes
   * back with its indexes. Records what they recreate in `restoredDrops`; a
   * drop they don't recreate stays a manual step.
   */
  private restoreOperations(operations: Types.MigrationOperation[]): { objects: Types.MigrationOperation[]; scalars: Types.MigrationOperation[]; } {
    const dropped = new Set<string>();

    for (const operation of operations) {
      if (operation.kind === "DropType")
        dropped.add(this.dropKey(operation));

      if (operation.kind === "DropIndex")
        dropped.add(this.dropKey(operation));

      if (operation.kind === "DropScalar")
        dropped.add(this.dropKey(operation));

      if (operation.kind === "AlterType") {
        const tableName = typeNameToTableName((operation as Types.AlterTypeOperation).typeName);

        for (const typeOp of (operation as Types.AlterTypeOperation).operations) {
          if (typeOp.kind.startsWith("Drop"))
            dropped.add(this.dropKey(typeOp, tableName));
        }
      }
    }

    const objects: Types.MigrationOperation[] = [];
    const scalars: Types.MigrationOperation[] = [];
    this.restoredDrops = new Map();

    const restores = (key: string, operation: Types.MigrationOperation | Types.TypeOperation): boolean => {
      if (!dropped.has(key))
        return false;

      this.restoredDrops.set(key, operation);
      return true;
    };

    for (const operation of this.reverseOperations) {
      switch (operation.kind) {
        case "CreateScalar":
          if (restores(this.dropKey(operation), operation))
            scalars.push(operation);
          break;
        case "CreateType":
          if (restores(this.dropKey(operation), operation))
            objects.push(operation);
          break;
        case "CreateIndex": {
          const index = (operation as Types.CreateIndexOperation).index;

          if (restores(this.dropKey(operation), operation) || dropped.has(`type:${index.table}`))
            objects.push(operation);
          break;
        }
        case "AddCheck":
          // A dropped CHECK comes back from its DropCheck; one of a dropped type, with the type.
          if (dropped.has(`type:${(operation as Types.AddCheckOperation).check.ownerTable}`))
            objects.push(operation);
          break;
        case "AlterType": {
          const alter = operation as Types.AlterTypeOperation;
          const tableName = typeNameToTableName(alter.typeName);
          const members = alter.operations.filter(typeOp => typeOp.kind.startsWith("Add") && restores(this.dropKey(typeOp, tableName), typeOp));

          if (members.length > 0)
            objects.push({ ...alter, operations: members } as Types.AlterTypeOperation);
          break;
        }
      }
    }

    return { objects, scalars };
  }

  /**
   * What an operation drops or creates, so a drop and the operation of
   * `reverseOperations` recreating it share a key: `type:<table>`,
   * `index:<name>`, `scalar:<module>::<name>`, and for the members of the
   * type whose table is `tableName`, `property:`/`link:`/`trigger:<table>.<name>`
   * and `rewrite:<table>.<property>:<events>`. Empty for anything else.
   */
  private dropKey(operation: Types.MigrationOperation | Types.TypeOperation, tableName = ""): string {
    const events = (list: string[]): string => [...list].sort().join(",");

    switch (operation.kind) {
      case "CreateType":
      case "DropType":
        return `type:${typeNameToTableName((operation as Types.CreateTypeOperation | Types.DropTypeOperation).typeName)}`;
      case "CreateIndex":
        return `index:${(operation as Types.CreateIndexOperation).index.name}`;
      case "DropIndex":
        return `index:${(operation as Types.DropIndexOperation).indexName}`;
      case "CreateScalar":
      case "DropScalar": {
        const scalar = operation as Types.CreateScalarOperation | Types.DropScalarOperation;
        return `scalar:${scalar.module}::${scalar.scalarName}`;
      }
      case "AddProperty":
        return `property:${tableName}.${(operation as Types.AddPropertyOperation).property.name}`;
      case "DropProperty":
        return `property:${tableName}.${(operation as Types.DropPropertyOperation).propertyName}`;
      case "AddLink":
        return `link:${tableName}.${(operation as Types.AddLinkOperation).link.name}`;
      case "DropLink":
        return `link:${tableName}.${(operation as Types.DropLinkOperation).linkName}`;
      case "AddTrigger":
        return `trigger:${tableName}.${(operation as Types.AddTriggerOperation).trigger.name}`;
      case "DropTrigger":
        return `trigger:${tableName}.${(operation as Types.DropTriggerOperation).triggerName}`;
      case "AddRewrite": {
        const rewrite = operation as Types.AddRewriteOperation;
        return `rewrite:${tableName}.${rewrite.propertyName}:${events(rewrite.rewrite.events)}`;
      }
      case "DropRewrite": {
        const rewrite = operation as Types.DropRewriteOperation;
        return `rewrite:${tableName}.${rewrite.propertyName}:${events(rewrite.events)}`;
      }
      default:
        return "";
    }
  }

  /*** The comment naming a table, column or link a rollback recreates without its data (logged by `MigrationEngine.executeRollback`). ***/
  private restoredEmpty(what: string): string {
    return `-- RESTORED EMPTY: ${what}`;
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
        if (op.baseType === "sequence") {
          return [`DROP SEQUENCE IF EXISTS ${this.escapeIdentifier(sequenceName(op.module, op.scalarName))};`];
        }
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
        if (this.restoredDrops.has(this.dropKey(op))) {
          return op.baseType === "sequence" ?
            [this.restoredEmpty(`sequence of ${op.module}::${op.scalarName} is recreated and restarts at 1`)] :
            [`-- Rollback: scalar ${op.module}::${op.scalarName} is recreated from the schema before the migration`];
        }
        if (op.baseType === "sequence") {
          return [
            `-- Rollback: sequence of ${op.module}::${op.scalarName} recreated; its counter restarts at 1`,
            `CREATE SEQUENCE IF NOT EXISTS ${this.escapeIdentifier(sequenceName(op.module, op.scalarName))};`
          ];
        }
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
      case "ConvertColumnType": {
        // Back to the type the column had; its finite CHECK, if it had one, is not restored.
        const op = operation as Types.ConvertColumnTypeOperation;
        const column = this.escapeIdentifier(op.columnName);
        return [
          this.retypeColumn(
            op.tableName,
            op.columnName,
            op.fromPgType,
            this.castExpression(column, op.pgType, op.fromPgType) ?? `${column}::text${op.fromPgType.endsWith("[]") ? "[]" : ""}::${op.fromPgType}`,
            true,
            op.multi ? EMPTY_ARRAY : undefined
          )
        ];
      }
      case "AddFiniteCheck": {
        const op = operation as Types.AddFiniteCheckOperation;
        return [
          `ALTER TABLE ${this.escapeIdentifier(op.tableName)} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(finiteCheckName(op.tableName, op.columnName))};`
        ];
      }
      case "MirrorAbstractType": {
        // The trigger goes; the next migration's backfill puts back what the schema needs.
        const op = operation as Types.MirrorAbstractTypeOperation;
        return [`DROP TRIGGER IF EXISTS "disc_abstract_mirror" ON ${this.escapeIdentifier(op.tableName)};`];
      }
      case "AddCheck":
        return [this.dropCheck((operation as Types.AddCheckOperation).check)];
      case "DropCheck":
        return [this.addCheck((operation as Types.DropCheckOperation).check)];
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
      case "ConvertColumnType":
        return this.generateConvertColumnType(
          operation as Types.ConvertColumnTypeOperation
        );
      case "MirrorAbstractType":
        return this.generateMirrorAbstractType(
          operation as Types.MirrorAbstractTypeOperation
        );
      case "AddFiniteCheck": {
        const op = operation as Types.AddFiniteCheckOperation;
        return this.addFiniteCheck(op.tableName, op.columnName, op.propertyType, op.multi === true);
      }
      case "AddCheck":
        return [this.addCheck((operation as Types.AddCheckOperation).check)];
      case "DropCheck":
        return [this.dropCheck((operation as Types.DropCheckOperation).check)];
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
   * Copy a concrete type's rows to its abstract ancestors' tables (see
   * `MirrorAbstractTypeOperation`): the trigger that keeps the copies, then
   * the copies of the rows the table already holds. A copy is the row read
   * as the abstract table's record — the columns the subtype inherited.
   * With no abstract tables, the trigger is dropped.
   */
  private generateMirrorAbstractType(operation: Types.MirrorAbstractTypeOperation): string[] {
    const table = this.escapeIdentifier(operation.tableName);
    if (operation.abstractTables.length === 0) {
      return [`DROP TRIGGER IF EXISTS "disc_abstract_mirror" ON ${table};`];
    }

    const args = operation.abstractTables.map(abstractTable => `'${abstractTable.replace(/'/g, "''")}'`).join(", ");
    return [
      ABSTRACT_MIRROR_FUNCTION,
      `CREATE OR REPLACE TRIGGER "disc_abstract_mirror" AFTER INSERT OR UPDATE OR DELETE ON ${table} ` +
      `FOR EACH ROW EXECUTE FUNCTION disc_abstract_mirror(${args});`,
      ...operation.abstractTables.map(abstractTable => {
        const target = this.escapeIdentifier(abstractTable);
        return `INSERT INTO ${target} SELECT (jsonb_populate_record(NULL::${target}, to_jsonb(disc_row))).* FROM ${table} AS disc_row ON CONFLICT (id) DO NOTHING;`;
      })
    ];
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
   * Convert a column created with another type than its property's (see
   * `ConvertColumnTypeOperation`) as a property type change converts one
   * (see {@link propertyConversion}): every stored value is checked first, so
   * one that doesn't convert fails the migration naming the column and the
   * value — as does one that would round to an integer type — rather than
   * being changed; then the column changes type. An enum the schema may no
   * longer declare converts through its text form. The finite CHECK of the
   * old type goes (`reconcileFiniteChecks` adds the new type's), and the
   * column's default is set again: the empty set of a multi property, else
   * its declared default, else its sequence's next value.
   */
  private generateConvertColumnType(
    operation: Types.ConvertColumnTypeOperation
  ): string[] {
    const table = this.escapeIdentifier(operation.tableName);
    const column = this.escapeIdentifier(operation.columnName);
    const array = operation.fromPgType.endsWith("[]") ? "[]" : "";
    const fromEnum = operation.fromPgType.startsWith("disc_enum_");
    const sourceType = fromEnum ? `TEXT${array}` : operation.fromPgType;
    const source = (value: string): string => fromEnum ? `${value}::text${array}` : value;
    const using = this.castExpression(source(column), sourceType, operation.pgType);
    const from = operation.fromPgType.toLowerCase();

    if (using === undefined) {
      throw new Error(
        `Cannot convert ${operation.tableName}.${operation.columnName} from ${from} to ${operation.propertyType}: ` +
          `PostgreSQL has no conversion from ${operation.fromPgType} to ${operation.pgType}.`
      );
    }

    // numeric → bigint rounds; a value it would change doesn't convert, so its text form is cast to fail naming it.
    const element = (type: string): string => type.replace(/\[\]$/, "");
    const rounds = ["BIGINT", "INTEGER", "SMALLINT"].includes(element(operation.pgType)) &&
      ["DOUBLE PRECISION", "NUMERIC", "REAL"].includes(element(sourceType));
    const convert = this.castExpression(source("disc_value"), sourceType, operation.pgType)!;
    const check = rounds ?
      `CASE WHEN ${convert}::${operation.fromPgType} = disc_value THEN NULL ELSE disc_value::text::${operation.pgType} END` :
      convert;
    const expected = operation.multi ? `a set of ${operation.propertyType} values` : `a valid ${operation.propertyType}`;
    const columnDefault = this.propertyColumnDefault({
      annotations: {},
      constraints: [],
      ...(operation.default !== undefined ? { default: operation.default } : {}),
      multi: operation.multi === true,
      name: operation.columnName,
      required: false,
      type: operation.propertyType
    });

    return [
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(finiteCheckName(operation.tableName, operation.columnName))};`,
      this.valueCheck(
        `${table}.${column}%TYPE`,
        `SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL`,
        check,
        `Cannot convert ${operation.tableName}.${operation.columnName} from ${from} to ${operation.propertyType}: stored value % is not ${expected}`
      ),
      this.retypeColumn(operation.tableName, operation.columnName, operation.pgType, using, true, columnDefault)
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
    // A sequence scalar's counter: every property of the scalar draws from it.
    if (operation.baseType === "sequence") {
      return [`CREATE SEQUENCE ${this.escapeIdentifier(sequenceName(operation.module, operation.scalarName))};`];
    }
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
    if (operation.baseType === "sequence") {
      return [`DROP SEQUENCE IF EXISTS ${this.escapeIdentifier(sequenceName(operation.module, operation.scalarName))};`];
    }
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
        default: this.propertyColumnDefault(property)
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
            deferred: this.targetDeferred(link),
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
              deferred: this.targetDeferred(link),
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

        // A multi link's delete-target trigger is on its junction.
        if (Types.deletesTargets(link.onSourceDelete)) {
          this.deferredStatements.push(...this.generateSourceDeleteTrigger(tableName, link));
        }
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

    // Generate source delete triggers (a multi link's comes with its junction, above)
    for (const link of operation.links) {
      if (!link.multi && Types.deletesTargets(link.onSourceDelete)) {
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
    const columnDefault = this.propertyColumnDefault(property);
    const defaultClause = columnDefault === undefined ? "" : ` DEFAULT ${columnDefault}`;

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

    for (const rewrite of property.rewrites ?? []) {
      statements.push(...this.generateCreateRewrite(tableName, property.name, rewrite));
    }

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
          if (defaults.new !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${defaults.new};`
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

    // Converted values may break the finite CHECK the new type adds; say which.
    if (oldProperty.type !== newProperty.type) {
      statements.push(...this.finiteValidation(tableName, colName, newProperty.type, true));
    }
    statements.push(...this.generateCheckConstraints(tableName, [newProperty]));
    return statements;
  }

  /**
   * The SQL of the default a property's column has before and after an
   * AlterProperty (`undefined` for none): from its ChangeDefault when it has
   * one, else from the property definitions the differ attaches on a type
   * change. An expression's is the SQL the differ compiled into those
   * definitions; a literal is formatted as `type` (`unknown` when the
   * operation doesn't say).
   */
  private propertyDefaults(operation: Types.AlterPropertyOperation, type = "unknown"): { new: string | undefined; old: string | undefined; } {
    const change = operation.changes.find(c => c.kind === "ChangeDefault");
    const values = change ?
      { new: change.newValue, old: change.oldValue } :
      { new: operation.newProperty?.default, old: operation.oldProperty?.default };
    const sql = (value: unknown, property: Types.PropertyDefinition | undefined): string | undefined =>
      value === undefined ? undefined : property?.defaultSql ?? this.formatDefaultValue(value, property?.type ?? type);

    return { new: sql(values.new, operation.newProperty), old: sql(values.old, operation.oldProperty) };
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
   * column's default is dropped for the change and `newDefault` (SQL, see
   * `propertyDefaults`) set after it, as a ChangeDefault alongside the type
   * change would.
   */
  private generateRetypeProperty(
    tableName: string,
    propertyName: string,
    from: string,
    to: string,
    oldDefault: string | undefined,
    newDefault: string | undefined
  ): string[] {
    const conversion = this.propertyConversion(tableName, propertyName, from, to);
    const columnName = propNameToColumnName(propertyName);
    const oldCheck = this.finiteCheck(tableName, columnName, from, false);

    return [
      ...(oldCheck ? [`ALTER TABLE ${this.escapeIdentifier(tableName)} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(oldCheck.name)};`] : []),
      ...conversion.check,
      this.retypeColumn(
        tableName,
        columnName,
        this.mapEdgeQLTypeToPostgreSQL(to),
        conversion.using,
        oldDefault !== undefined || newDefault !== undefined,
        newDefault
      ),
      ...this.addFiniteCheck(tableName, columnName, to, false)
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
            deferred: this.targetDeferred(link),
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
        }) REFERENCES ${this.escapeIdentifier(targetTable)} (id) ON DELETE ${this.targetOnDelete(link)}${this.targetDeferred(link) ? DEFERRED : ""};`
      );
      statements.push(
        `CREATE INDEX ${this.escapeIdentifier(`idx_${tableName}_${columnName}`)} ON ${this.escapeIdentifier(tableName)} (${this.escapeIdentifier(columnName)});`
      );
    }

    if (link.exclusive) {
      statements.push(this.generateExclusiveLinkIndex(tableName, link));
    }

    // Generate source delete trigger if needed
    if (Types.deletesTargets(link.onSourceDelete)) {
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

    // An `on source delete delete target` trigger's function reads the link's
    // column; left behind, every later delete on the table would fail. CASCADE
    // drops the trigger wherever it sits (source table or junction).
    statements.push(
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(`disc_source_delete_${tableName}_${linkName}`)}() CASCADE;`
    );

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
          if (Types.deletesTargets(change.oldValue)) {
            statements.push(...this.dropSourceDeleteTrigger(tableName, this.alteredLink(subject, operation)));
          }
          if (Types.deletesTargets(change.newValue)) {
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
   * The FK from a link to its target as CREATE and ALTER LINK emit it: the
   * table holding it, its constraint name, its ON DELETE action and whether
   * it is deferred (see `targetDeferred`). The
   * delete-rule repair (`reconcileLinkDeleteRules`) compares the database's
   * foreign keys against it.
   */
  targetForeignKey(tableName: string, link: Types.LinkDefinition): { constraint: string; deferred: boolean; onDelete: string; table: string; } {
    const table = link.multi ? `${tableName}_${link.name}` : tableName;

    return {
      constraint: this.foreignKeyName(table, link.multi ? "target_id" : linkColumnName(link.name)),
      deferred: this.targetDeferred(link),
      onDelete: this.targetOnDelete(link),
      table
    };
  }

  /**
   * ON DELETE action of the FK from a link to its target. A single link's
   * `<link>_id` column defaults to RESTRICT. A multi link's junction row is the
   * link itself, so it defaults to CASCADE (on create and alter alike), and
   * `allow` / `set empty` cascade too: `target_id` is NOT NULL, so SET NULL
   * could only fail. `deferred restrict` is NO ACTION: unlike RESTRICT,
   * PostgreSQL checks it at commit once the FK is deferred (`targetDeferred`).
   */
  private targetOnDelete(link: Types.LinkDefinition): NonNullable<NonNullable<Types.ColumnDefinition["references"]>["onDelete"]> {
    if (link.onTargetDelete === "DEFERRED RESTRICT") {
      return "NO ACTION";
    }
    if (!link.multi) {
      return link.onTargetDelete || "RESTRICT";
    }
    return link.onTargetDelete === "RESTRICT" ? "RESTRICT" : "CASCADE";
  }

  /*** Whether a link's target FK is `DEFERRABLE INITIALLY DEFERRED`: its target is abstract (`LinkDefinition.targetAbstract`) or it is `deferred restrict`. ***/
  private targetDeferred(link: Types.LinkDefinition): boolean {
    return link.targetAbstract === true || link.onTargetDelete === "DEFERRED RESTRICT";
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
        deferred: this.targetDeferred(link),
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
    const columns = index
      .columns
      .map((col, i) => {
        const expression = index.expressions?.[i];
        return expression ? `(${expression})` : this.escapeIdentifier(col);
      })
      .join(", ");

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
    } (${this.escapeIdentifier(column.references.column)})${onDelete}${onUpdate}${column.references.deferred ? DEFERRED : ""}`;
  }

  /**
   * The CHECK of a constraint (see `Types.CheckDefinition`). Its boolean goes
   * through `disc_check_constraint` (lib/stdlib-sql.ts), which lets TRUE and
   * NULL (an empty value) through and raises Gel's ConstraintViolationError —
   * the check's message and detail, SQLSTATE 23514 with the constraint and
   * table named — on FALSE, whether an insert or update writes the row or
   * the migration adding the check finds one. The CHECK it `replaces`, if
   * any, is dropped in the same statement.
   */
  private addCheck(check: Types.CheckDefinition): string {
    const violation = [check.message, check.detail, check.name, check.table].map(sqlStringLiteral).join(", ");
    const replaced = check.replaces === undefined ? "" : `DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(check.replaces)}, `;
    return `ALTER TABLE ${this.escapeIdentifier(check.table)} ${replaced}ADD CONSTRAINT ${
      this.escapeIdentifier(check.name)
    } CHECK (disc_check_constraint(${check.expression}, ${violation}));`;
  }

  /*** `IF EXISTS` twice: a junction table's CHECK is dropped before its link, which may go with it. ***/
  private dropCheck(check: Types.CheckDefinition): string {
    return `ALTER TABLE IF EXISTS ${this.escapeIdentifier(check.table)} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(check.name)};`;
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

    const finite = this.finiteCheck(tableName, colName, property.type, property.multi);
    if (finite) {
      checks.push(finite);
    }

    return checks;
  }

  /**
   * The CHECK of a `decimal` or `bigint` column (`type` may be a scalar
   * extending one, or an array of either; `multi` stores an array): no NaN
   * or ±Infinity, which PostgreSQL's numeric holds and Gel's types don't, and
   * for a bigint no fractional part — Gel's `bigint_t` domain is
   * `scale(VALUE) = 0 AND VALUE != 'NaN'`. An array's elements are checked:
   * `&&` finds a non-finite one (numeric compares NaN equal to itself), and
   * the IMMUTABLE `disc_array_integral` (lib/stdlib-sql.ts) a fractional one,
   * since a CHECK can't hold a subquery. Undefined for other types.
   */
  finiteCheck(tableName: string, columnName: string, type: string, multi: boolean): { expression: string; name: string; } | undefined {
    const kind = this.finiteNumericKind(type);
    if (kind === undefined) {
      return undefined;
    }

    const column = this.escapeIdentifier(columnName);
    const expression = multi || type.startsWith("array<") ?
      `NOT (${column} && '{NaN,Infinity,-Infinity}'::numeric[])${kind === "bigint" ? ` AND disc_array_integral(${column})` : ""}` :
      this.finitePredicate(column, kind);
    return { expression, name: finiteCheckName(tableName, columnName) };
  }

  /*** `bigint` or `decimal` when `type` (or its array element) is one, or a scalar extending one. ***/
  private finiteNumericKind(type: string): "bigint" | "decimal" | undefined {
    let name = /^array<(.+)>$/.exec(type)?.[1] ?? type;
    const seen = new Set<string>();
    while (this.scalarBaseTypes.has(name) && !seen.has(name)) {
      seen.add(name);
      name = this.scalarBaseTypes.get(name)!;
    }
    return name === "bigint" || name === "decimal" ? name : undefined;
  }

  /*** SQL that is true when the `kind` value `value` is finite (and, for a bigint, integral). ***/
  private finitePredicate(value: string, kind: "bigint" | "decimal"): string {
    const finite = `${value} NOT IN ${NON_FINITE_NUMERIC}`;
    return kind === "bigint" ? `scale(${value}) = 0 AND ${finite}` : finite;
  }

  /*** Add the finite CHECK (see {@link finiteCheck}) to an existing column, validated first (see {@link finiteValidation}). ***/
  private addFiniteCheck(tableName: string, columnName: string, type: string, multi: boolean): string[] {
    const check = this.finiteCheck(tableName, columnName, type, multi);
    return check === undefined ? [] : [
      ...this.finiteValidation(tableName, columnName, type, multi),
      `ALTER TABLE ${this.escapeIdentifier(tableName)} ADD CONSTRAINT ${this.escapeIdentifier(check.name)} CHECK (${check.expression});`
    ];
  }

  /**
   * Before the finite CHECK (see {@link finiteCheck}) is added to a column
   * holding values: a block failing, naming the column and the first stored
   * value (or array element) the check would reject — so nothing changes,
   * and the message says what to fix rather than PostgreSQL's bare "violated
   * by some row". Nothing when the column's type has no such check.
   */
  private finiteValidation(tableName: string, columnName: string, type: string, multi: boolean): string[] {
    const kind = this.finiteNumericKind(type);
    if (kind === undefined) {
      return [];
    }

    const table = this.escapeIdentifier(tableName);
    const column = this.escapeIdentifier(columnName);
    const firstBad = multi || type.startsWith("array<") ?
      `SELECT e.v::text INTO disc_value FROM ${table}, unnest(${column}) AS e(v) WHERE NOT (${this.finitePredicate("e.v", kind)}) LIMIT 1;` :
      `SELECT ${column}::text INTO disc_value FROM ${table} WHERE NOT (${this.finitePredicate(column, kind)}) LIMIT 1;`;
    const message = `Cannot add ${finiteCheckName(tableName, columnName)} to ${tableName}.${columnName}: stored value % is not a valid ${kind} ` +
      `(Gel's ${kind} has no NaN or ±Infinity${kind === "bigint" ? " and no fractional part" : ""}). ` +
      "Fix or delete the rows holding it, then migrate again.";

    return [
      `DO $$
DECLARE
  disc_value text;
BEGIN
  ${firstBad}
  IF FOUND THEN
    RAISE EXCEPTION '${message.replace(/'/g, "''")}', quote_literal(disc_value);
  END IF;
END $$;`
    ];
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
      // `expression on (…)` compiles through the EdgeQL compiler into an
      // AddCheck operation (see `SchemaDiffer.declaredChecks`), never here.
      case "expression":
      case "expression_on":
        return null;
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
      default: property.default !== undefined ? property.defaultSql ?? this.formatDefaultValue(property.default, property.type) : undefined
    }));
  }

  /**
   * The DEFAULT of a stored property's column: the empty array for a multi
   * property, else its declared default, else — for a property of a sequence
   * scalar — the next value of the scalar's sequence. `default !== undefined`
   * rather than truthy: `default := 0`, `default := false` and `default := ""`
   * are valid SDL defaults that the truthy form would silently drop.
   */
  private propertyColumnDefault(property: Types.PropertyDefinition): string | undefined {
    if (property.multi)
      return EMPTY_ARRAY;

    if (property.default !== undefined)
      return property.defaultSql ?? this.formatDefaultValue(property.default, property.type);

    const sequence = this.sequenceScalars.get(property.type);
    return sequence === undefined ? undefined : `nextval('${sequence}')`;
  }

  /*** Whether `type` (or its array element) names a user scalar, whose column type depends on the module it resolves in. ***/
  namesUserScalar(type: string): boolean {
    const name = /^array<(.+)>$/.exec(type)?.[1] ?? type;
    return this.enumScalars.has(name) || this.scalarBaseTypes.has(name);
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
      sequence: "BIGINT",
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
      "array<sequence>": "BIGINT[]",
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
   * Generate the AFTER DELETE trigger that deletes a link's targets when
   * `on source delete delete target` (or `delete target if orphan`) is set.
   * It fires once the link to the target is gone, so the target's FK
   * (RESTRICT by default) can't block it.
   */
  private generateSourceDeleteTrigger(
    tableName: string,
    link: Types.LinkDefinition
  ): string[] {
    const fnName = this.escapeIdentifier(`disc_source_delete_${tableName}_${link.name}`);
    const trigger = this.sourceDeleteTrigger(tableName, link);

    return [
      `CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$ ${trigger.body} $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(trigger.name)} ${trigger.timing} DELETE ON ${
        this.escapeIdentifier(trigger.table)
      } FOR EACH ROW EXECUTE FUNCTION ${fnName}();`
    ];
  }

  /**
   * The trigger behind a link's `on source delete delete target`: its name,
   * the table it's on (the source table, or a multi link's junction), its
   * timing and its function's body. The delete-rule repair
   * (`reconcileLinkDeleteRules`) compares the database's triggers against it.
   *
   * A single link's trigger is on the source table and deletes
   * `OLD.<link>_id`. A multi link's is on its junction: the source's row
   * deletion cascades to the junction rows, and each one whose source no
   * longer exists deletes its target (unlinking a target, or deleting it,
   * leaves the source in place).
   *
   * `if orphan` (Gel) keeps a target another object still links to through
   * the same link: another source row pointing at it, or another junction
   * row. Links by other names don't count. When several sources of a target
   * go in one statement, the target goes with the last of them. A link
   * declared on a parent type is the same link on every concrete type
   * holding it (`link.orphanTables`), so the check reads all their link
   * columns, or junctions.
   */
  sourceDeleteTrigger(tableName: string, link: Types.LinkDefinition): { body: string; name: string; table: string; timing: "AFTER"; } {
    const table = link.multi ? `${tableName}_${link.name}` : tableName;
    const targetTable = this.escapeIdentifier(typeNameToTableName(link.target));
    const ifOrphan = link.onSourceDelete === "DELETE TARGET IF ORPHAN";
    const holders = link.orphanTables ?? [tableName];
    let action: string;

    if (link.multi) {
      const orphan = ifOrphan ?
        holders.map(holder => ` AND NOT EXISTS (SELECT 1 FROM ${this.escapeIdentifier(`${holder}_${link.name}`)} WHERE target_id = OLD.target_id)`).join("") :
        "";
      action = `IF NOT EXISTS (SELECT 1 FROM ${
        this.escapeIdentifier(tableName)
      } WHERE id = OLD.source_id)${orphan} THEN DELETE FROM ${targetTable} WHERE id = OLD.target_id; END IF;`;
    } else {
      const column = this.escapeIdentifier(linkColumnName(link.name));
      const deleteTarget = `DELETE FROM ${targetTable} WHERE id = OLD.${column};`;
      const orphan = holders
        .map(holder => `NOT EXISTS (SELECT 1 FROM ${this.escapeIdentifier(holder)} WHERE ${column} = OLD.${column})`)
        .join(" AND ");
      action = ifOrphan ? `IF ${orphan} THEN ${deleteTarget} END IF;` : deleteTarget;
    }

    return {
      body: `BEGIN ${action} RETURN NULL; END;`,
      name: `trg_source_delete_${tableName}_${link.name}`,
      table,
      timing: "AFTER"
    };
  }

  /**
   * Generate DROP statements for a source delete trigger and its function. A
   * multi link's trigger is dropped from the source table too, where Disc
   * created it before it moved to the junction.
   */
  private dropSourceDeleteTrigger(
    tableName: string,
    link: Types.LinkDefinition
  ): string[] {
    const fnName = `disc_source_delete_${tableName}_${link.name}`;
    const trigger = this.sourceDeleteTrigger(tableName, link);
    const tables = link.multi ? [trigger.table, tableName] : [tableName];

    return [
      ...tables.map(table => `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(trigger.name)} ON ${this.escapeIdentifier(table)};`),
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(fnName)}();`
    ];
  }

  // ========================================
  // Rewrite DDL Generation Methods
  // ========================================

  /**
   * A rewrite rule's trigger, as the DDL creates it: a BEFORE `events` trigger
   * named `<table>__<column>__rewrite` (`…__update_rewrite` for an update-only
   * rule, which can sit beside an insert rule of the same property) running
   * `<name>_fn`, whose source (`pg_proc.prosrc`, trimmed) is `body`. The
   * rewrite repair (`reconcileRewrites`) compares the database's triggers
   * against it.
   */
  rewriteTrigger(
    tableName: string,
    propertyName: string,
    rewrite: Types.RewriteDefinition
  ): { body: string; events: ("insert" | "update")[]; function: string; name: string; } {
    const colName = propNameToColumnName(propertyName);
    const name = this.rewriteTriggerName(tableName, propertyName, rewrite.events);

    return {
      body: `BEGIN NEW.${this.escapeIdentifier(colName)} := ${this.compileRewriteExpression(rewrite.body)}; RETURN NEW; END;`,
      events: [...rewrite.events].sort(),
      function: `${name}_fn`,
      name
    };
  }

  private rewriteTriggerName(tableName: string, propertyName: string, events: ("insert" | "update")[]): string {
    const updateOnly = events.length > 0 && events.every(event => event === "update");
    return `${tableName}__${propNameToColumnName(propertyName)}__${updateOnly ? "update_" : ""}rewrite`;
  }

  /**
   * Generate a PL/pgSQL trigger function and CREATE TRIGGER for a rewrite rule.
   * Rewrite rules automatically set a column value BEFORE INSERT/UPDATE.
   */
  private generateCreateRewrite(
    tableName: string,
    propertyName: string,
    rewrite: Types.RewriteDefinition
  ): string[] {
    const trigger = this.rewriteTrigger(tableName, propertyName, rewrite);

    // Build event list from rewrite events
    const eventList = rewrite.events.map(e => e.toUpperCase()).join(" OR ");

    return [
      `CREATE OR REPLACE FUNCTION ${this.escapeIdentifier(trigger.function)}() RETURNS TRIGGER AS $$ ${trigger.body} $$ LANGUAGE plpgsql;`,
      `CREATE TRIGGER ${this.escapeIdentifier(trigger.name)} BEFORE ${eventList} ON ${this.escapeIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${
        this.escapeIdentifier(trigger.function)
      }();`
    ];
  }

  /**
   * Generate DROP statements for a rewrite rule's trigger and function.
   */
  private generateDropRewrite(
    tableName: string,
    propertyName: string,
    events: ("insert" | "update")[]
  ): string[] {
    const triggerName = this.rewriteTriggerName(tableName, propertyName, events);

    return [
      `DROP TRIGGER IF EXISTS ${this.escapeIdentifier(triggerName)} ON ${this.escapeIdentifier(tableName)};`,
      `DROP FUNCTION IF EXISTS ${this.escapeIdentifier(`${triggerName}_fn`)}();`
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
      if (Types.deletesTargets(link.onSourceDelete)) {
        statements.push(...this.dropSourceDeleteTrigger(tableName, link));
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
    const tableName = typeNameToTableName(operation.typeName);

    /*** Recreated with its junctions by the restore statements (see `restoreOperations`). ***/
    if (this.restoredDrops.has(this.dropKey(operation))) {
      return [
        this.restoredEmpty(`table '${tableName}' is recreated without the rows the migration deleted`),
        ...(operation.multiLinks ?? []).map(link => this.restoredEmpty(`link '${tableName}.${link}' is recreated without the links the migration deleted`))
      ];
    }

    // P1-10: without the schema before the migration there is no definition
    // to recreate the table from. Emit a SQL-level DO block so an accidental
    // `disc migrate --rollback` fails loudly instead of silently "succeeding"
    // with comment-only DDL.
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
        if (this.restoredDrops.has(this.dropKey(operation, tableName))) {
          return [
            `-- Rollback: trigger '${
              (operation as Types.DropTriggerOperation).triggerName
            }' on table '${tableName}' is recreated from the schema before the migration`
          ];
        }
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
        const dropRewriteOp = operation as Types.DropRewriteOperation;
        /*** A dropped property's rewrites come back with it. ***/
        const propertyRestored = this.restoredDrops.has(`property:${tableName}.${dropRewriteOp.propertyName}`);
        if (propertyRestored || this.restoredDrops.has(this.dropKey(operation, tableName))) {
          return [
            `-- Rollback: rewrite rule for property '${dropRewriteOp.propertyName}' on table '${tableName}' is recreated from the schema before the migration`
          ];
        }
        // Can't restore rewrite body from just the property name and events
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

    // To rollback AddProperty, we drop the column, and its rewrites: they don't depend on it
    return [
      ...(operation.property.rewrites ?? []).flatMap(rewrite => this.generateDropRewrite(tableName, operation.property.name, rewrite.events)),
      `ALTER TABLE ${this.escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${this.escapeIdentifier(propNameToColumnName(operation.property.name))};`
    ];
  }

  private generateRollbackDropProperty(
    tableName: string,
    operation: Types.DropPropertyOperation
  ): string[] {
    const column = `'${tableName}.${propNameToColumnName(operation.propertyName)}'`;
    const restored = this.restoredDrops.get(this.dropKey(operation, tableName)) as Types.AddPropertyOperation | undefined;

    /*** A type's property is recreated by the restore statements (see `restoreOperations`). ***/
    if (restored) {
      return restored.property.computed ?
        [`-- Rollback: computed property '${operation.propertyName}' comes back with the schema; it has no column`] :
        [this.restoredEmpty(`column ${column} is recreated without the values the migration deleted`)];
    }

    /*** A link property is a column of the junction, which the rollback doesn't touch otherwise: re-add it here. ***/
    const linkProperty = this.reverseLinkProperty(tableName, operation.propertyName);

    if (linkProperty) {
      return [
        this.restoredEmpty(`link property column ${column} is recreated without the values the migration deleted`),
        ...this.generateAddProperty(tableName, linkProperty)
      ];
    }

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
    // A change between two multi properties is undone by the change back. A
    // single → multi one would have to go multi → single, which loses values
    // (the forward path refuses it), so, as for DropProperty, fail loudly instead.
    if (operation.oldProperty?.multi && operation.newProperty?.multi) {
      return this.generateAlterProperty(tableName, this.reversedAlterProperty(operation));
    }
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
          if (defaults.old !== undefined) {
            statements.push(
              `ALTER TABLE ${tableRef} ALTER COLUMN ${columnName} SET DEFAULT ${defaults.old};`
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
          if (change.newValue === "exclusive") {
            statements.push(`DROP INDEX IF EXISTS ${this.escapeIdentifier(exclusiveIndexName(tableName, colName))};`);
          }
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
          // Same unique index the forward AddConstraint creates
          if (change.oldValue === "exclusive") {
            statements.push(
              `CREATE UNIQUE INDEX ${this.escapeIdentifier(exclusiveIndexName(tableName, colName))} ON ${tableRef} (${columnName});`
            );
          }
          break;
        }
      }
    }

    return statements;
  }

  /*** The AlterProperty undoing `operation`: each change back, in reverse order, from the property after it to the one before. ***/
  private reversedAlterProperty(operation: Types.AlterPropertyOperation): Types.AlterPropertyOperation {
    const reversedKind: Partial<Record<Types.PropertyChange["kind"], Types.PropertyChange["kind"]>> = {
      AddAnnotation: "DropAnnotation",
      AddConstraint: "DropConstraint",
      DropAnnotation: "AddAnnotation",
      DropConstraint: "AddConstraint"
    };

    return {
      ...operation,
      changes: [...operation.changes].reverse().map(change => ({
        ...change,
        kind: reversedKind[change.kind] ?? change.kind,
        newValue: change.oldValue,
        oldValue: change.newValue
      })),
      newProperty: operation.oldProperty,
      oldProperty: operation.newProperty
    };
  }

  /**
   * The AddProperty of `reverseOperations` re-adding the link property
   * `propertyName` to the junction `junctionTable` (`<table>_<link>`), if any.
   */
  private reverseLinkProperty(junctionTable: string, propertyName: string): Types.AddPropertyOperation | undefined {
    for (const operation of this.reverseOperations) {
      if (operation.kind !== "AlterType")
        continue;

      const alter = operation as Types.AlterTypeOperation;

      for (const typeOp of alter.operations) {
        if (typeOp.kind !== "AlterLink" || `${typeNameToTableName(alter.typeName)}_${(typeOp as Types.AlterLinkOperation).linkName}` !== junctionTable)
          continue;

        const added = ((typeOp as Types.AlterLinkOperation).propertyOperations ?? []).find(propertyOp =>
          propertyOp.kind === "AddProperty" && (propertyOp as Types.AddPropertyOperation).property.name === propertyName
        );

        if (added)
          return added as Types.AddPropertyOperation;
      }
    }

    return undefined;
  }

  private generateRollbackAddLink(
    tableName: string,
    operation: Types.AddLinkOperation
  ): string[] {
    const link = operation.link;
    const linkName = link.name;

    /*** The source table survives the rollback, so its delete-target trigger must go explicitly. ***/
    const statements: string[] = Types.deletesTargets(link.onSourceDelete) ?
      this.dropSourceDeleteTrigger(tableName, link) :
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
    /*** Recreated, with its FK or junction, by the restore statements (see `restoreOperations`). ***/
    if (this.restoredDrops.has(this.dropKey(operation, tableName)))
      return [this.restoredEmpty(`link '${tableName}.${operation.linkName}' is recreated without the links the migration deleted`)];

    // Without the schema before the migration there is no link definition to recreate
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
    /*** Only the delete rules changed (a user's edit, or the delete-rule repair `migrate` adds):
         the rollback's own repair (`reconcileLinkDeleteRules`, which `MigrationEngine` runs against
         the rolled-back-to snapshot) puts back the FK action and trigger that snapshot declares. ***/
    const deleteRulesOnly = !operation.propertyOperations?.length &&
      operation.changes.every(change => change.kind === "ChangeOnDelete" || change.kind === "ChangeOnSourceDelete");

    if (deleteRulesOnly)
      return [`-- ALTER LINK ${operation.linkName} on ${tableName}: delete rules are restored by the repair after the rollback`];

    /*** The forward path refuses these (see `generateAlterLink`), so no applied migration holds one. ***/
    const unsupported = operation.changes.some(change => ["ChangeCardinality", "ChangeMulti", "ChangeTarget"].includes(change.kind));

    if (operation.link && !unsupported) {
      const link = operation.link;
      const junctionTable = `${tableName}_${operation.linkName}`;
      const statements = [...(operation.propertyOperations ?? [])].reverse().flatMap(op => this.generateRollbackTypeOperation(junctionTable, op));

      // Delete rules as above; ChangeExtending needs no DDL.
      for (const change of [...operation.changes].reverse()) {
        if (change.kind === "ChangeRequired" && !link.multi) {
          statements.push(
            `ALTER TABLE ${this.escapeIdentifier(tableName)} ALTER COLUMN ${this.escapeIdentifier(linkColumnName(operation.linkName))} ${
              change.oldValue ? "SET" : "DROP"
            } NOT NULL;`
          );
        }

        if (change.kind === "ChangeExclusive") {
          statements.push(
            change.oldValue ?
              this.generateExclusiveLinkIndex(tableName, link) :
              `DROP INDEX IF EXISTS ${this.escapeIdentifier(this.exclusiveLinkIndexName(tableName, link))};`
          );
        }
      }

      return statements.length > 0 ? statements : [`-- ALTER LINK ${operation.linkName} on ${tableName}: nothing to roll back`];
    }

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
    /*** Recreated under its name by the restore statements (see `restoreOperations`). ***/
    if (this.restoredDrops.has(this.dropKey(operation)))
      return [`-- Rollback: index '${operation.indexName}' is recreated from the schema before the migration`];

    return [
      `-- MANUAL ROLLBACK REQUIRED: Recreate index '${operation.indexName}'`,
      `-- The original index definition was lost when it was dropped.`,
      `-- Please refer to backup or documentation for the original index structure.`
    ];
  }
}
