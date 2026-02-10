/**
 * Migration system types and interfaces
 */

export interface Migration {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  applied_at?: Date;
  schema_hash: string;
  operations: MigrationOperation[];
}

export interface MigrationOperation {
  kind: string;
}

// Schema operations
export interface CreateTypeOperation extends MigrationOperation {
  kind: "CreateType";
  type_name: string;
  properties: PropertyDefinition[];
  links: LinkDefinition[];
}

export interface DropTypeOperation extends MigrationOperation {
  kind: "DropType";
  type_name: string;
}

export interface AlterTypeOperation extends MigrationOperation {
  kind: "AlterType";
  type_name: string;
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
  property_name: string;
}

export interface AlterPropertyOperation extends TypeOperation {
  kind: "AlterProperty";
  property_name: string;
  changes: PropertyChange[];
}

export interface AddLinkOperation extends TypeOperation {
  kind: "AddLink";
  link: LinkDefinition;
}

export interface DropLinkOperation extends TypeOperation {
  kind: "DropLink";
  link_name: string;
}

export interface AlterLinkOperation extends TypeOperation {
  kind: "AlterLink";
  link_name: string;
  changes: LinkChange[];
}

// DDL operations
export interface CreateTableOperation extends MigrationOperation {
  kind: "CreateTable";
  table_name: string;
  columns: ColumnDefinition[];
  constraints: ConstraintDefinition[];
  indexes: IndexDefinition[];
}

export interface DropTableOperation extends MigrationOperation {
  kind: "DropTable";
  table_name: string;
}

export interface AlterTableOperation extends MigrationOperation {
  kind: "AlterTable";
  table_name: string;
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
  column_name: string;
}

export interface AlterColumnOperation extends TableOperation {
  kind: "AlterColumn";
  column_name: string;
  changes: ColumnChange[];
}

export interface AddConstraintOperation extends TableOperation {
  kind: "AddConstraint";
  constraint: ConstraintDefinition;
}

export interface DropConstraintOperation extends TableOperation {
  kind: "DropConstraint";
  constraint_name: string;
}

export interface CreateIndexOperation extends MigrationOperation {
  kind: "CreateIndex";
  index: IndexDefinition;
}

export interface DropIndexOperation extends MigrationOperation {
  kind: "DropIndex";
  index_name: string;
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
  on_target_delete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
  annotations: Record<string, any>;
}

export interface PropertyChange {
  kind: "ChangeType" | "ChangeRequired" | "ChangeMulti" | "ChangeDefault" | "AddConstraint" | "DropConstraint";
  old_value?: any;
  new_value?: any;
}

export interface LinkChange {
  kind: "ChangeTarget" | "ChangeRequired" | "ChangeMulti" | "ChangeCardinality" | "ChangeOnDelete";
  old_value?: any;
  new_value?: any;
}

// DDL definitions
export interface ColumnDefinition {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primary_key: boolean;
  unique: boolean;
  references?: {
    table: string;
    column: string;
    on_delete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
    on_update?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
  };
}

export interface ConstraintDefinition {
  name: string;
  type: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK";
  columns: string[];
  references?: {
    table: string;
    columns: string[];
    on_delete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
    on_update?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
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
  kind: "ChangeType" | "ChangeNullable" | "ChangeDefault" | "AddConstraint" | "DropConstraint";
  old_value?: any;
  new_value?: any;
}

// Migration state
export interface MigrationState {
  applied_migrations: string[];
  current_schema_hash: string;
  last_migration_id?: string;
  last_applied_at?: Date;
}

export interface MigrationPlan {
  migrations: Migration[];
  target_schema_hash: string;
  operations_count: number;
  estimated_duration?: number;
}

export interface MigrationResult {
  success: boolean;
  migration_id: string;
  applied_at: Date;
  duration_ms: number;
  error?: string;
  rollback_sql?: string[];
}

// Migration configuration
export interface MigrationConfig {
  migrations_dir: string;
  schema_file: string;
  database_url: string;
  dry_run: boolean;
  auto_approve: boolean;
  backup_before_migration: boolean;
  rollback_on_error: boolean;
}

// Helper functions for creating operations
export function createTypeOperation(name: string, properties: PropertyDefinition[], links: LinkDefinition[]): CreateTypeOperation {
  return {
    kind: "CreateType",
    type_name: name,
    properties,
    links,
  };
}

export function dropTypeOperation(name: string): DropTypeOperation {
  return {
    kind: "DropType",
    type_name: name,
  };
}

export function addPropertyOperation(property: PropertyDefinition): AddPropertyOperation {
  return {
    kind: "AddProperty",
    property,
  };
}

export function dropPropertyOperation(name: string): DropPropertyOperation {
  return {
    kind: "DropProperty",
    property_name: name,
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
    table_name: name,
    columns,
    constraints,
    indexes,
  };
}

export function dropTableOperation(name: string): DropTableOperation {
  return {
    kind: "DropTable",
    table_name: name,
  };
}

export function addColumnOperation(column: ColumnDefinition): AddColumnOperation {
  return {
    kind: "AddColumn",
    column,
  };
}

export function dropColumnOperation(name: string): DropColumnOperation {
  return {
    kind: "DropColumn",
    column_name: name,
  };
}