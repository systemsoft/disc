# Migration

Schema migration system for Disc. Parses SDL schemas, diffs them against the current state, generates DDL statements, executes them against PostgreSQL, and tracks applied migrations in a `disc_migrations` table.

## Import

```typescript
import { SchemaDiffer } from "disc/migration/differ.ts";
import { MigrationEngine } from "disc/migration/engine.ts";
import { SchemaManager } from "disc/migration/schema-manager.ts";
import { MigrationTracker } from "disc/migration/tracker.ts";
import type {
  AlterTypeOperation,
  CreateTypeOperation,
  DropTypeOperation,
  LinkDefinition,
  Migration,
  MigrationCheckpoint,
  MigrationConfig,
  MigrationHistoryEntry,
  MigrationOperation,
  MigrationPlan,
  MigrationResult,
  MigrationState,
  PropertyDefinition
} from "disc/migration/types.ts";
```

## SchemaManager

The primary entry point. Bridges SDL parsing, the query compiler schema, and migration planning/execution.

```typescript
import { ConnectionPool } from "disc/lib/connection-pool.ts";
import { SchemaManager } from "disc/migration/schema-manager.ts";

const pool = new ConnectionPool({ connectionString: "postgresql://..." });
await pool.initialize();

const manager = new SchemaManager({
  pool,
  dryRun: false,
  onSchemaChange: schema => {
    // Notify the server to update its compiler schema
    server.updateSchema(schema);
  }
});

await manager.initialize();
```

### Parse SDL

Parse SDL source into an intermediate `Module[]` representation:

```typescript
const result = manager.parseSDL(`
  module default {
    type User {
      required email: str {
        constraint exclusive;
      };
      required name: str;
    };
  };
`);

if (result.ok) {
  const modules = result.value;
}
```

### Convert Modules to Schema

Convert `Module[]` into a `Schema` for the query compiler. This is a pure function with no side effects:

```typescript
const schema = manager.modulesToSchema(modules);
// schema.types: Map<string, TypeDef>
// schema.functions: Map<string, FunctionDef>
```

The conversion handles:

- PascalCase type names to snake_case table names
- EdgeQL types to SQL column types (e.g., `str` to `text`, `datetime` to `timestamptz`)
- Property constraints extraction
- Link definitions with backlink resolution for multi-links
- Access policy adaptation from SDL AST nodes
- Enum scalar types

### Apply Schema (Plan + Execute)

Parse SDL, diff against current state, generate DDL, and execute:

```typescript
const result = await manager.applySchema(sdlSource);
if (result.ok) {
  for (const migrationResult of result.value) {
    console.log(
      `Applied: ${migrationResult.migrationId} in ${migrationResult.durationMs}ms`
    );
  }
}
```

In `dryRun` mode, the schema is updated internally but no DDL is executed against the database.

### Plan Only (No Execution)

Generate a migration plan without executing it. Used by `disc migrate --create`:

```typescript
const planResult = manager.planSchema(sdlSource);
if (planResult.ok) {
  const plan = planResult.value;
  console.log(
    `${plan.operationsCount} operations, estimated ${plan.estimatedDuration}ms`
  );
}
```

### Generate DDL

Extract DDL statements from a migration plan:

```typescript
const ddlResult = manager.generateDDL(plan);
if (ddlResult.ok) {
  for (const stmt of ddlResult.value) {
    console.log(stmt);
  }
}
```

### Validate Migration

Check a migration plan for safety issues (breaking changes, data loss risks):

```typescript
const validResult = manager.validateMigration(plan);
if (!validResult.ok) {
  console.error("Validation failed:", validResult.error.message);
}
```

### Access Current State

```typescript
manager.getSchema(); // Schema | null
manager.getModules(); // Module[] | null
```

## MigrationEngine

Orchestrates schema diffing, DDL generation, and migration execution.

```typescript
const engine = new MigrationEngine({
  migrationsDir: "./migrations",
  schemaFile: "./schema.disc",
  databaseUrl: "postgresql://...",
  dryRun: false,
  autoApprove: true,
  backupBeforeMigration: false,
  rollbackOnError: true,
  connectionPool: pool // optional, preferred over databaseUrl
});

await engine.initialize();
```

### Planning

```typescript
const planResult = engine.planMigration(oldModules, newModules);
if (planResult.ok) {
  const plan = planResult.value;
  // plan.migrations: Migration[]
  // plan.targetSchemaHash: string
  // plan.operationsCount: number
  // plan.estimatedDuration: number
}
```

When `oldModules` is `null`, an initial migration is generated that creates all types from scratch.

### Execution

```typescript
// Basic execution
const result = await engine.executeMigration(plan);

// With automatic rollback on error
const result = await engine.executeMigrationWithRollback(plan);
```

Execution runs DDL statements inside a database transaction (via connection pool or direct `DatabaseConnection`). Each applied migration is recorded via `MigrationTracker`.

### Rollback

```typescript
// Generate rollback SQL for a migration
const rollbackResult = engine.generateRollbackSQL(migration);

// Rollback a specific migration
engine.rollbackMigration(migrationId);

// Rollback to a specific migration (undo all after it)
await engine.rollbackToMigration(targetMigrationId);

// Validate rollback safety
engine.validateRollbackSafety(plan);
```

### Checkpoints

```typescript
// Create a checkpoint before a risky migration
const checkpoint = engine.createMigrationCheckpoint("pre-refactor");

// Restore from checkpoint
engine.restoreFromCheckpoint(checkpoint.value.id);
```

### Data Migration Hints

```typescript
const hints = engine.generateDataMigrationHints(plan);
// ["Data migration hint: New required property User.role has no default value", ...]
```

## SchemaDiffer

Compares two `Module[]` representations and produces `MigrationOperation[]`.

```typescript
const differ = new SchemaDiffer();
const operations = differ.diff(oldModules, newModules);
```

### Change Detection

The differ detects:

| Change                       | Operation Type                   |
| ---------------------------- | -------------------------------- |
| New type added               | `CreateType`                     |
| Type removed                 | `DropType`                       |
| Type modified                | `AlterType`                      |
| Property added               | `AddProperty`                    |
| Property removed             | `DropProperty`                   |
| Property type changed        | `AlterProperty` (ChangeType)     |
| Property required changed    | `AlterProperty` (ChangeRequired) |
| Property cardinality changed | `AlterProperty` (ChangeMulti)    |
| Property default changed     | `AlterProperty` (ChangeDefault)  |
| Link added                   | `AddLink`                        |
| Link removed                 | `DropLink`                       |
| Link target changed          | `AlterLink` (ChangeTarget)       |
| Link cardinality changed     | `AlterLink` (ChangeMulti)        |
| Link on-delete changed       | `AlterLink` (ChangeOnDelete)     |

Inheritance is resolved: properties and links from parent types (via `extending`) are included in `CreateType` operations for concrete types.

## DDL Generation

The `DDLGenerator` (in `ddl.ts`) converts `MigrationOperation[]` to SQL DDL strings:

- `CreateType` produces `CREATE TABLE` with columns, primary key, foreign keys, constraints, and indexes.
- `DropType` produces `DROP TABLE IF EXISTS`.
- `AlterType` produces `ALTER TABLE` with `ADD COLUMN`, `DROP COLUMN`, `ALTER COLUMN`, etc.
- Rollback DDL is generated in reverse order.

## MigrationTracker

Persists migration history and checkpoints to a PostgreSQL database using the `disc_migrations` and `disc_migration_checkpoints` tables.

```typescript
const tracker = new MigrationTracker(pool);
await tracker.initialize(); // creates tables if needed

// Record a migration
await tracker.recordMigration(migration, result);

// Query history
const applied = await tracker.getAppliedMigrations(); // string[]
const history = await tracker.getMigrationHistory(); // MigrationHistoryEntry[]
const state = await tracker.getMigrationState(); // MigrationState

// Check specific migration
const isApplied = await tracker.isMigrationApplied("m20240115T103000_abc123");

// Rollback support
await tracker.removeMigration(migrationId);
const rollbackSQL = await tracker.getRollbackSQL(migrationId);

// Checkpoints
await tracker.saveCheckpoint(checkpoint);
const cp = await tracker.loadCheckpoint(checkpointId);
const all = await tracker.listCheckpoints();

// Integrity verification
await tracker.verifyMigrationIntegrity();

await tracker.close();
```

### disc_migrations Table Schema

| Column         | Type                   | Description                |
| -------------- | ---------------------- | -------------------------- |
| `id`           | `TEXT PRIMARY KEY`     | Migration ID               |
| `name`         | `TEXT NOT NULL`        | Generated migration name   |
| `description`  | `TEXT`                 | Human-readable description |
| `schema_hash`  | `TEXT NOT NULL`        | Hash of target schema      |
| `applied_at`   | `TIMESTAMPTZ NOT NULL` | When migration was applied |
| `duration_ms`  | `INTEGER NOT NULL`     | Execution time in ms       |
| `rollback_sql` | `TEXT[]`               | Rollback DDL statements    |
| `checksum`     | `TEXT NOT NULL`        | Migration content checksum |
| `created_at`   | `TIMESTAMPTZ NOT NULL` | When migration was created |

## CLI Integration

```bash
disc migrate             # Generate and apply migrations
disc migrate --create    # Generate migration plan without applying
disc migrate --dry-run   # Show what would be executed
```

The CLI reads `.disc` schema files, calls `SchemaManager.applySchema()` or `SchemaManager.planSchema()`, and reports results. The `--dry-run` flag sets `dryRun: true` in the migration config, which logs DDL statements without executing them.

## Migration ID Format

Migration IDs follow the pattern `m<timestamp>_<random>`:

```
m20240115T103000_abc123
```

The timestamp is derived from `new Date().toISOString()` with separators stripped. The random suffix is a 6-character base-36 string.
