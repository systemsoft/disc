/**
 * Migration system types and interfaces
 */

import { ConnectionPool } from "../lib/connection-pool.ts";

export interface Migration {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  appliedAt?: Date;
  schemaHash: string;
  operations: MigrationOperation[];
}

export interface MigrationOperation {
  kind: string;
}

// Schema operations
export interface CreateTypeOperation extends MigrationOperation {
  kind: "CreateType";
  typeName: string;
  properties: PropertyDefinition[];
  links: LinkDefinition[];
}

export interface DropTypeOperation extends MigrationOperation {
  kind: "DropType";
  typeName: string;
}

export interface AlterTypeOperation extends MigrationOperation {
  kind: "AlterType";
  typeName: string;
  operations: TypeOperation[];
}

export interface TypeOperation {
  kind: string;
}

export interface AddPropertyOperation extends TypeOperation {
  kind: "AddProperty";
  property: PropertyDefinition;
}

export interface DropPropertyOperation extends TypeOperation {
  kind: "DropProperty";
  propertyName: string;
}

export interface AlterPropertyOperation extends TypeOperation {
  kind: "AlterProperty";
  propertyName: string;
  changes: PropertyChange[];
}

export interface AddLinkOperation extends TypeOperation {
  kind: "AddLink";
  link: LinkDefinition;
}

export interface DropLinkOperation extends TypeOperation {
  kind: "DropLink";
  linkName: string;
}

export interface AlterLinkOperation extends TypeOperation {
  kind: "AlterLink";
  linkName: string;
  changes: LinkChange[];
}

// DDL operations
export interface CreateTableOperation extends MigrationOperation {
  kind: "CreateTable";
  tableName: string;
  columns: ColumnDefinition[];
  constraints: ConstraintDefinition[];
  indexes: IndexDefinition[];
}

export interface DropTableOperation extends MigrationOperation {
  kind: "DropTable";
  tableName: string;
}

export interface AlterTableOperation extends MigrationOperation {
  kind: "AlterTable";
  tableName: string;
  operations: TableOperation[];
}

export interface TableOperation {
  kind: string;
}

export interface AddColumnOperation extends TableOperation {
  kind: "AddColumn";
  column: ColumnDefinition;
}

export interface DropColumnOperation extends TableOperation {
  kind: "DropColumn";
  columnName: string;
}

export interface AlterColumnOperation extends TableOperation {
  kind: "AlterColumn";
  columnName: string;
  changes: ColumnChange[];
}

export interface AddConstraintOperation extends TableOperation {
  kind: "AddConstraint";
  constraint: ConstraintDefinition;
}

export interface DropConstraintOperation extends TableOperation {
  kind: "DropConstraint";
  constraintName: string;
}

export interface CreateIndexOperation extends MigrationOperation {
  kind: "CreateIndex";
  index: IndexDefinition;
}

export interface DropIndexOperation extends MigrationOperation {
  kind: "DropIndex";
  indexName: string;
}

// Schema definitions
export interface PropertyDefinition {
  name: string;
  type: string;
  required: boolean;
  multi: boolean;
  default?: any;
  constraints: string[];
  annotations: Record<string, any>;
}

export interface LinkDefinition {
  name: string;
  target: string;
  required: boolean;
  multi: boolean;
  cardinality?: string;
  onTargetDelete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
  annotations: Record<string, any>;
}

export interface PropertyChange {
  kind:
    | "ChangeType"
    | "ChangeRequired"
    | "ChangeMulti"
    | "ChangeDefault"
    | "AddConstraint"
    | "DropConstraint";
  oldValue?: any;
  newValue?: any;
}

export interface LinkChange {
  kind:
    | "ChangeTarget"
    | "ChangeRequired"
    | "ChangeMulti"
    | "ChangeCardinality"
    | "ChangeOnDelete";
  oldValue?: any;
  newValue?: any;
}

// DDL definitions
export interface ColumnDefinition {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey: boolean;
  unique: boolean;
  references?: {
    table: string;
    column: string;
    onDelete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
    onUpdate?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
  };
}

export interface ConstraintDefinition {
  name: string;
  type: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK";
  columns: string[];
  references?: {
    table: string;
    columns: string[];
    onDelete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
    onUpdate?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
  };
  condition?: string; // For CHECK constraints
}

export interface IndexDefinition {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  partial?: string; // WHERE clause for partial indexes
  method?: "btree" | "hash" | "gist" | "gin" | "brin";
}

export interface ColumnChange {
  kind:
    | "ChangeType"
    | "ChangeNullable"
    | "ChangeDefault"
    | "AddConstraint"
    | "DropConstraint";
  oldValue?: any;
  newValue?: any;
}

// Migration state
export interface MigrationState {
  appliedMigrations: string[];
  currentSchemaHash: string;
  lastMigrationId?: string;
  lastAppliedAt?: Date;
}

export interface MigrationPlan {
  migrations: Migration[];
  targetSchemaHash: string;
  operationsCount: number;
  estimatedDuration?: number;
}

export interface MigrationResult {
  success: boolean;
  migrationId: string;
  appliedAt: Date;
  durationMs: number;
  error?: string;
  rollbackSql?: string[];
}

// Migration configuration
export interface MigrationConfig {
  migrationsDir: string;
  schemaFile: string;
  databaseUrl: string;
  dryRun: boolean;
  autoApprove: boolean;
  backupBeforeMigration: boolean;
  rollbackOnError: boolean;
  connectionPool?: ConnectionPool;
}

export interface MigrationCheckpoint {
  id: string;
  name: string;
  createdAt: Date;
  schemaState: any;
  migrationState: MigrationState;
}

export interface MigrationHistoryEntry {
  id: string;
  name: string;
  description: string;
  schemaHash: string;
  appliedAt: Date;
  durationMs: number;
  createdAt: Date;
}

// Helper functions for creating operations
export function createTypeOperation(
  name: string,
  properties: PropertyDefinition[],
  links: LinkDefinition[],
): CreateTypeOperation {
  return {
    kind: "CreateType",
    typeName: name,
    properties,
    links,
  };
}

export function dropTypeOperation(name: string): DropTypeOperation {
  return {
    kind: "DropType",
    typeName: name,
  };
}

export function addPropertyOperation(
  property: PropertyDefinition,
): AddPropertyOperation {
  return {
    kind: "AddProperty",
    property,
  };
}

export function dropPropertyOperation(name: string): DropPropertyOperation {
  return {
    kind: "DropProperty",
    propertyName: name,
  };
}

export function createTableOperation(
  name: string,
  columns: ColumnDefinition[],
  constraints: ConstraintDefinition[] = [],
  indexes: IndexDefinition[] = [],
): CreateTableOperation {
  return {
    kind: "CreateTable",
    tableName: name,
    columns,
    constraints,
    indexes,
  };
}

export function dropTableOperation(name: string): DropTableOperation {
  return {
    kind: "DropTable",
    tableName: name,
  };
}

export function addColumnOperation(
  column: ColumnDefinition,
): AddColumnOperation {
  return {
    kind: "AddColumn",
    column,
  };
}

export function dropColumnOperation(name: string): DropColumnOperation {
  return {
    kind: "DropColumn",
    columnName: name,
  };
}
