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
  dataMigrationFile?: string;
}

export interface MigrationOperation {
  kind: string;
  /**
   * Optional safety classification (gh/geldata#1840). Set by
   * `MigrationEngine.classifyUnsafeOperations` when scanning a plan;
   * left undefined for ops the gate hasn't inspected yet.
   *
   *  - `"safe"`        — additive, reversible, no data loss.
   *  - `"unsafe"`      — drops/destroys data; requires `--unsafe` to apply.
   *  - `"ambiguous"`   — could be interpreted multiple ways
   *                      (rename-vs-drop-add, type narrowing without an
   *                      explicit cast, link-cardinality changes that may
   *                      lose data); the operator must disambiguate.
   *
   * Disc's classifier is non-interactive — it *labels* ops rather than
   * prompting (Gel's CLI has interactive prompts; we surface a structured
   * classification so non-CLI callers can render their own UX).
   */
  classification?: "safe" | "unsafe" | "ambiguous";
}

// Schema operations
export interface CreateTypeOperation extends MigrationOperation {
  kind: "CreateType";
  typeName: string;
  properties: PropertyDefinition[];
  links: LinkDefinition[];
  /** Whether this is an abstract type */
  abstract?: boolean;
  /** Names of parent types (supports multiple inheritance) */
  parentTypes?: string[];
  /** Names of direct child types */
  subtypes?: string[];
  /** Trigger definitions for this type */
  triggers?: TriggerDefinition[];
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

export interface TriggerDefinition {
  name: string;
  timing: "before" | "after";
  events: ("insert" | "update" | "delete")[];
  scope: "each" | "all";
  body: string; // Serialized EdgeQL expression
}

export interface AddTriggerOperation extends TypeOperation {
  kind: "AddTrigger";
  trigger: TriggerDefinition;
}

export interface DropTriggerOperation extends TypeOperation {
  kind: "DropTrigger";
  triggerName: string;
}

export interface RewriteDefinition {
  events: ("insert" | "update")[];
  body: string;
}

export interface AddRewriteOperation extends TypeOperation {
  kind: "AddRewrite";
  propertyName: string;
  rewrite: RewriteDefinition;
}

export interface DropRewriteOperation extends TypeOperation {
  kind: "DropRewrite";
  propertyName: string;
  events: ("insert" | "update")[];
}

// Alias operations
export interface CreateAliasOperation extends MigrationOperation {
  kind: "CreateAlias";
  aliasName: string;
  expression: string;
}

export interface DropAliasOperation extends MigrationOperation {
  kind: "DropAlias";
  aliasName: string;
}

// Scalar / enum operations (gh/geldata#8517, #2564)
//
// Disc's differ extracts scalar declarations alongside object types, so a
// schema author who adds, removes, or reorders enum values gets a real
// migration plan instead of an empty diff. PostgreSQL's enum semantics
// constrain what we can emit:
//
//  - **Add value**: `ALTER TYPE ... ADD VALUE` is fast and non-destructive.
//    PG ≥12 supports it inside a transaction (#8517 cited PG 11 limitations
//    but Disc bundles PG16+, so this is fine).
//  - **Drop / reorder values**: PG has no native `DROP VALUE` or reorder.
//    These require type recreation with column-level CASCADE which is
//    structurally destructive, so Disc emits a `RecreateScalar` op flagged
//    as unsafe — the unsafe-gate refuses it without `--unsafe`.
export interface CreateScalarOperation extends MigrationOperation {
  kind: "CreateScalar";
  scalarName: string;
  module: string;
  /**
   * The base of the scalar (e.g. "enum", "str", "int64"). When `kind` is
   * `"enum"`, `enumValues` is non-empty.
   */
  baseType: string;
  enumValues?: string[];
}

export interface DropScalarOperation extends MigrationOperation {
  kind: "DropScalar";
  scalarName: string;
  module: string;
}

/**
 * `ALTER TYPE ... ADD VALUE`. PG enum order is positional, so a value is
 * inserted at the end unless `before` or `after` is given.
 */
export interface AddEnumValueOperation extends MigrationOperation {
  kind: "AddEnumValue";
  scalarName: string;
  module: string;
  value: string;
  before?: string;
  after?: string;
}

/**
 * Recreate-with-cascade for value removal or reordering. PG's lack of
 * `DROP VALUE` forces this two-phase approach: drop dependent columns,
 * recreate the type, re-add the columns. Because data in dropped columns
 * is lost, the differ marks this op unsafe (gh/geldata#2564).
 */
export interface RecreateScalarOperation extends MigrationOperation {
  kind: "RecreateScalar";
  scalarName: string;
  module: string;
  /** New, post-change enum value list (used to rebuild the type). */
  enumValues: string[];
  /** Old enum values, preserved for rollback / reasoning. */
  oldEnumValues: string[];
  /** Reason for recreate ("removed-values" | "reordered-values"). */
  reason: "removed-values" | "reordered-values";
}

// Global operations
export interface CreateGlobalOperation extends MigrationOperation {
  kind: "CreateGlobal";
  name: string;
  module: string;
  type: string;
  pgType: string;
  required: boolean;
  multi: boolean;
  default?: string;
  readonly: boolean;
}

export interface DropGlobalOperation extends MigrationOperation {
  kind: "DropGlobal";
  name: string;
  module: string;
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
  computed?: string; // Expression string for computed properties (virtual, evaluated at query time)
  constraints: string[];
  annotations: Record<string, any>;
  rewrites?: RewriteDefinition[];
}

export interface LinkDefinition {
  name: string;
  target: string;
  required: boolean;
  multi: boolean;
  cardinality?: string;
  extending?: string[];
  onTargetDelete?: "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
  onSourceDelete?: "ALLOW" | "DELETE TARGET";
  annotations: Record<string, any>;
}

export interface PropertyChange {
  kind:
    | "ChangeType"
    | "ChangeRequired"
    | "ChangeMulti"
    | "ChangeDefault"
    | "ChangeComputed"
    | "AddConstraint"
    | "DropConstraint"
    | "AddAnnotation"
    | "DropAnnotation"
    | "ChangeAnnotation";
  /** Annotation name (only set for AddAnnotation/DropAnnotation/ChangeAnnotation) */
  annotationName?: string;
  oldValue?: any;
  newValue?: any;
}

export interface LinkChange {
  kind:
    | "ChangeTarget"
    | "ChangeRequired"
    | "ChangeMulti"
    | "ChangeCardinality"
    | "ChangeExtending"
    | "ChangeOnDelete"
    | "ChangeOnSourceDelete";
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

/**
 * Per-step progress events emitted during migration execution.
 * Subscribe via `MigrationConfig.onProgress`. (gh/geldata#7490)
 *
 * Event ordering: `plan-started` → for each migration:
 *   `migration-started` → `ddl-executing` (if non-empty DDL) →
 *   `data-migration-running` (if a matching data migration exists) →
 *   `migration-completed` (or `migration-failed`)
 * → `plan-completed` (or `plan-failed`).
 */
export type MigrationProgressEvent =
  | { kind: "plan-started"; totalMigrations: number; totalOperations: number; }
  | { kind: "migration-started"; migrationId: string; name: string; index: number; total: number; }
  | { kind: "ddl-executing"; migrationId: string; statementCount: number; }
  | { kind: "data-migration-running"; migrationId: string; }
  | { kind: "migration-completed"; migrationId: string; durationMs: number; }
  | { kind: "migration-failed"; migrationId: string; error: string; durationMs: number; rollbackAttempted: boolean; }
  | { kind: "plan-completed"; migrationCount: number; durationMs: number; }
  | { kind: "plan-failed"; error: string; durationMs: number; };

export type MigrationProgressListener = (event: MigrationProgressEvent) => void;

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
  /**
   * Optional progress callback. Errors thrown by the listener are
   * caught and logged at warn level — listener bugs must never break
   * a migration. (gh/geldata#7490)
   */
  onProgress?: MigrationProgressListener;
  /**
   * Per-statement lock timeout in milliseconds (gh/geldata#6304).
   * Disc sets `lock_timeout` at the start of each migration transaction
   * so DDL statements that contend with a long-running query fail fast
   * instead of blocking the migration indefinitely. Defaults to
   * `60000` (one minute) when undefined; pass `0` to disable.
   */
  lockTimeoutMs?: number;
  /**
   * Whether to acquire a session-scoped PostgreSQL advisory lock at the
   * start of `applyMigrations` to serialize concurrent migrators
   * (gh/geldata#6304). Without this, two `disc migrate` invocations on
   * the same database can both reach `executeStatements` and step on
   * each other. Defaults to `true`.
   */
  useAdvisoryLock?: boolean;
}

/**
 * Disc's PostgreSQL advisory-lock key for migrations. A 64-bit constant
 * derived from `disc_migrations` so it's stable across processes and
 * unlikely to collide with application-side advisory locks.
 *
 * Computed at module load time via FNV-1a so the constant lives next to
 * the migration types and any operator who needs to drop the lock by
 * hand can find it via `pg_locks WHERE objid = …`.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = (() => {
  // FNV-1a 64-bit (BigInt) of "disc_migrations".
  const data = new TextEncoder().encode("disc_migrations");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (const byte of data) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * prime) & mask;
  }
  // Postgres `pg_advisory_lock(bigint)` uses a signed 64-bit integer,
  // so map the unsigned hash into the signed range.
  if (hash >= 1n << 63n) hash -= 1n << 64n;
  return hash;
})();

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
  dataMigration: boolean;
  /**
   * Monotonic application order. Set at insert time as
   * `MAX(applied_order) + 1` inside a single transaction so concurrent
   * applies can't share a number. Useful for branching workflows where
   * `applied_at` timestamps don't reflect logical order (e.g. a
   * migration squashed on one branch then re-applied on another).
   * (gh/geldata#8773)
   */
  appliedOrder: number;
}

// Helper functions for creating operations
export function createTypeOperation(
  name: string,
  properties: PropertyDefinition[],
  links: LinkDefinition[],
  options?: {
    abstract?: boolean;
    parentTypes?: string[];
    subtypes?: string[];
  },
): CreateTypeOperation {
  return {
    kind: "CreateType",
    typeName: name,
    properties,
    links,
    ...options,
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

export function addTriggerOperation(
  _typeName: string,
  trigger: TriggerDefinition,
): AddTriggerOperation {
  return {
    kind: "AddTrigger",
    trigger,
  };
}

export function dropTriggerOperation(
  _typeName: string,
  triggerName: string,
): DropTriggerOperation {
  return {
    kind: "DropTrigger",
    triggerName,
  };
}

export function createAddRewriteOperation(
  _typeName: string,
  propertyName: string,
  rewrite: RewriteDefinition,
): AddRewriteOperation {
  return {
    kind: "AddRewrite",
    propertyName,
    rewrite,
  };
}

export function createDropRewriteOperation(
  _typeName: string,
  propertyName: string,
  events: ("insert" | "update")[],
): DropRewriteOperation {
  return {
    kind: "DropRewrite",
    propertyName,
    events,
  };
}

export function createGlobalOperation(
  name: string,
  module: string,
  type: string,
  pgType: string,
  options?: {
    required?: boolean;
    multi?: boolean;
    default?: string;
    readonly?: boolean;
  },
): CreateGlobalOperation {
  return {
    kind: "CreateGlobal",
    name,
    module,
    type,
    pgType,
    required: options?.required ?? false,
    multi: options?.multi ?? false,
    default: options?.default,
    readonly: options?.readonly ?? false,
  };
}

export function dropGlobalOperation(
  name: string,
  module: string,
): DropGlobalOperation {
  return {
    kind: "DropGlobal",
    name,
    module,
  };
}

export function createAliasOperation(
  aliasName: string,
  expression: string,
): CreateAliasOperation {
  return {
    kind: "CreateAlias",
    aliasName,
    expression,
  };
}

export function dropAliasOperation(
  aliasName: string,
): DropAliasOperation {
  return {
    kind: "DropAlias",
    aliasName,
  };
}
