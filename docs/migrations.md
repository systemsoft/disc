# Migrations

Disc uses a declarative, schema-first migration system. You write your schema in SDL (`.disc`, `.gel`, or `.esdl` files), and Disc automatically generates the DDL statements needed to bring your PostgreSQL database in sync. Every migration is tracked in a `disc_migrations` table, and rollback SQL is stored alongside each migration for safe reversal.

Related documentation: [Schema](schema.md) | [CLI](cli.md) | [Bundled PostgreSQL](bundled-postgres.md)

## How Migrations Work

The migration pipeline has four stages:

```
SDL Source  -->  Parse  -->  Diff  -->  DDL  -->  Execute
(.disc)        (AST)     (Operations)  (SQL)   (PostgreSQL)
```

1. **Parse** -- The SDL parser reads your schema files and produces an AST (`Module[]`).
2. **Diff** -- The `SchemaDiffer` compares the new AST against the previously applied schema and produces a list of `MigrationOperation` objects describing what changed.
3. **Generate DDL** -- The `DDLGenerator` converts each operation into PostgreSQL DDL statements (`CREATE TABLE`, `ALTER TABLE`, etc.).
4. **Execute** -- The `MigrationEngine` runs the DDL inside a PostgreSQL transaction. If any statement fails, the entire migration is rolled back. On success, the migration is recorded in the `disc_migrations` table with its rollback SQL.

Each migration gets an auto-generated ID following the format `m<timestamp>_<random>`, for example `m20240115T103000_abc123`. The timestamp comes from `new Date().toISOString()` with separators stripped, and the random suffix is a 6-character base-36 string.

## Basic Workflow

The typical development cycle is:

1. Edit your `.disc` schema file.
2. Run `disc migrate` to generate and apply the migration.
3. Review the output to confirm what was created, altered, or dropped.
4. Commit both the schema file and the migration history to version control.

### Example

Start with a schema file at `dbschema/default.disc`:

```
module default {
  type User {
    required email: str {
      constraint exclusive;
    };
    required name: str;
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
  };
};
```

Run the migration:

```bash
disc migrate
```

Output:

```
Planning migration...
  Create type User
    - email: str (required, exclusive)
    - name: str (required)
    - created_at: datetime (default: datetime_current(), readonly)

Generating DDL:
  CREATE TABLE "user" (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX uk_user_email ON "user" (email);

Migration m20240115T103000_abc123 applied in 142ms
```

Now add a `Post` type and a link from `User`:

```
module default {
  type User {
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    required email: str {
      constraint exclusive;
    };
    required name: str;
    multi posts: Post;
  };

  type Post {
    required author: User;
    required body: str;
    created_at: datetime {
      default := datetime_current();
    };
    required title: str;
  };
};
```

Run `disc migrate` again. Disc detects the diff and generates the DDL for the new `Post` table, the `author` foreign key, and the `user_posts` junction table.

## Creating Migrations

### Generate and Apply

```bash
disc migrate
```

Parses the schema, diffs against the current state, generates DDL, and executes it. This is the default behavior.

### Generate Without Applying

```bash
disc migrate --create
```

Generates the migration plan and shows the DDL that would be executed, but does not apply it to the database. Use this to review changes before committing.

### Preview (Dry Run)

```bash
disc migrate --dry-run
```

Runs the full pipeline including execution logging, but no DDL is actually sent to PostgreSQL. The schema state is updated internally so you can see what the next migration would look like, but the database is untouched.

### Auto-Approve

```bash
disc migrate --auto-approve
```

Skips the confirmation prompt and applies the migration immediately. Useful in CI/CD pipelines.

## Migration Status

Check the state of your migrations:

```bash
disc migrate --status
```

Output:

```
Migration Status
  Applied: 3
  Latest:  m20240601T120000_xyz789 (add_posts)
  Schema:  hash_abc123
```

This queries the `disc_migrations` table and shows:

- **Applied** -- Total number of migrations that have been applied.
- **Latest** -- The ID and name of the most recently applied migration.
- **Schema** -- The schema hash of the current state.

## Rollback

Disc stores rollback SQL for each migration at apply time. You can use this to undo migrations.

### Rollback the Last Migration

```bash
disc migrate --rollback --force
```

Loads the most recently applied migration from the `disc_migrations` table, executes its stored rollback SQL in a transaction, and removes the migration record. The `--force` flag is required because rollbacks are destructive operations.

### Rollback to a Specific Migration

```bash
disc migrate --rollback-to m20240115T103000_abc123 --force
```

Rolls back all migrations applied after the specified migration ID, in reverse chronological order (most recent first). The target migration itself is preserved.

For example, if you have migrations `m001`, `m002`, `m003` applied and you run `--rollback-to m001`, then `m003` is rolled back first, followed by `m002`. Migration `m001` remains applied.

### Rollback Safety

Not all operations can be cleanly rolled back. The migration engine validates rollback safety and warns about operations that may require manual intervention:

- **DropType** -- Rolling back a `DROP TABLE` cannot restore the original data. The table structure is gone.
- **DropProperty** -- Rolling back a dropped column loses any data that was in that column.
- **AlterProperty (ChangeType)** -- Type changes may not be reversible if the conversion is lossy.

When the engine cannot generate automatic rollback SQL for an operation, it emits a comment in the rollback SQL:

```sql
-- MANUAL ROLLBACK REQUIRED: Recreate table 'user'
-- The original table structure was lost when it was dropped.
-- Please restore from backup or recreate the table manually.
```

### Rollback on Error

When `rollbackOnError` is enabled in the migration configuration (the default), the engine automatically rolls back a failed migration. If the migration DDL fails partway through, the pre-generated rollback SQL is executed to restore the database to its prior state.

```typescript
const engine = new MigrationEngine({
  // ...
  rollbackOnError: true
});

// If any DDL statement fails, the engine automatically
// executes the rollback SQL before returning the error.
const result = await engine.executeMigrationWithRollback(plan);
```

## Data Migrations

Schema (DDL) migrations handle structural changes -- creating tables, adding columns, changing types. Data migrations handle the content transformations that accompany those structural changes -- backfilling new columns, converting data formats, or splitting tables.

### Creating a Data Migration

Data migration files live alongside schema migrations in `dbschema/migrations/` and follow the naming pattern:

```
m<timestamp>_<name>.data.ts
```

The timestamp must match the schema migration it pairs with. When the engine applies a schema migration, it automatically discovers and runs any data migration file with a matching timestamp.

### Data Migration Structure

Each data migration file exports a default object implementing the `DataMigration` interface:

```typescript
// dbschema/migrations/m20240601T120000_backfill_roles.data.ts

export default {
  async down(ctx) {
    await ctx.sql(`
      UPDATE "user" SET role = NULL WHERE role = 'member'
    `);

    ctx.log("Reverted role backfill");
  },
  name: "backfill_roles",
  timestamp: "20240601T120000",
  async up(ctx) {
    // ctx.sql() executes raw SQL within the migration transaction
    await ctx.sql(`
      UPDATE "user" SET role = 'member' WHERE role IS NULL
    `);

    ctx.log("Backfilled default roles for all users");
  },
};
```

### DataMigrationContext

The context object passed to `up()` and `down()` provides:

| Method                    | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `ctx.sql(query, params?)` | Execute a SQL query within the migration transaction. Returns row results. |
| `ctx.log(message)`        | Log a message to the migration output.                                     |
| `ctx.pool`                | Direct access to the connection pool (for advanced use cases).             |

The `ctx.edgeql()` method is reserved for future use. Currently, data migrations must use raw SQL via `ctx.sql()`.

### Data Migration Rules

- Data migration `up()` runs inside the same transaction as the schema migration.
- If `up()` throws, the entire migration (schema + data) is rolled back.
- The `down()` function is optional but recommended. Without it, the data migration cannot be rolled back.
- Data migrations cannot be squashed (see below).

## Squashing

Over time, a project accumulates many small migrations. Squashing combines multiple sequential migrations into a single consolidated migration.

### Squash All Migrations

```bash
disc migrate --squash
```

Combines all applied migrations into one. The resulting migration contains all DDL statements in order, and all rollback statements in reverse order.

### Squash a Range

```bash
disc migrate --squash-from m20240101_aaa --squash-to m20240601_zzz
```

Combines only the migrations in the specified range (inclusive on both ends). The `--squash-from` migration must precede `--squash-to` in chronological order.

### Squash Restrictions

- **Data migrations cannot be squashed.** If any migration in the range has an associated data migration, the squash fails with an error listing the affected migration IDs.
- The squash produces a new migration named `squashed_<first_id>_to_<last_id>`.
- Forward DDL statements are concatenated in order; rollback statements are concatenated in reverse order.

## Supported Operations

The schema differ detects the following changes between the old and new schema:

### Type-Level Operations

| Operation    | Description                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateType` | A new object type was added to the schema. Generates `CREATE TABLE` with columns, primary key, foreign keys, constraints, indexes, triggers, and rewrite rules. |
| `DropType`   | An object type was removed. Generates `DROP TABLE IF EXISTS ... CASCADE`.                                                                                       |
| `AlterType`  | An existing type was modified. Contains sub-operations (see below).                                                                                             |

### Property Operations (within AlterType)

| Operation       | Description                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AddProperty`   | A new property was added. Generates `ALTER TABLE ... ADD COLUMN`. Computed properties are virtual and produce no DDL. |
| `DropProperty`  | A property was removed. Generates `ALTER TABLE ... DROP COLUMN`.                                                      |
| `AlterProperty` | A property was modified. Detects changes to type, required, multi, default, and constraints.                          |

### Property Changes (within AlterProperty)

| Change           | Description                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ChangeType`     | The property type changed (e.g., `str` to `int32`). Generates `ALTER COLUMN ... TYPE`.                           |
| `ChangeRequired` | The required flag changed. Generates `SET NOT NULL` or `DROP NOT NULL`.                                          |
| `ChangeMulti`    | The cardinality changed between single and multi.                                                                |
| `ChangeDefault`  | The default value changed. Generates `SET DEFAULT` or `DROP DEFAULT`.                                            |
| `AddConstraint`  | A new constraint was added. Generates `ADD CONSTRAINT ... CHECK (...)` or `CREATE UNIQUE INDEX` for `exclusive`. |
| `DropConstraint` | A constraint was removed. Generates `DROP CONSTRAINT`.                                                           |

### Link Operations (within AlterType)

| Operation   | Description                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `AddLink`   | A new link was added. For single links, adds a foreign key column. For multi links, creates a junction table.    |
| `DropLink`  | A link was removed. Drops the junction table or foreign key column.                                              |
| `AlterLink` | A link was modified. Detects changes to target, required, multi, cardinality, on-delete behavior, and extending. |

### Trigger Operations (within AlterType)

| Operation     | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| `AddTrigger`  | A new trigger was added. Generates `CREATE FUNCTION` and `CREATE TRIGGER`. |
| `DropTrigger` | A trigger was removed. Generates `DROP TRIGGER` and `DROP FUNCTION`.       |

Trigger modifications are handled as drop + add (triggers cannot be altered in place in PostgreSQL).

### Rewrite Operations (within AlterType)

| Operation     | Description                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AddRewrite`  | A new rewrite rule was added to a property. Generates a `BEFORE INSERT/UPDATE` trigger that sets the column value. |
| `DropRewrite` | A rewrite rule was removed. Drops the trigger and function.                                                        |

Rewrite modifications are handled as drop + add.

### Alias Operations

| Operation     | Description                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- |
| `CreateAlias` | A new alias (expression alias) was added. Aliases are compile-time only and produce no DDL. |
| `DropAlias`   | An alias was removed. No DDL produced.                                                      |

Alias modifications are handled as drop + add (aliases are compile-time constructs).

### Global Operations

| Operation      | Description                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `CreateGlobal` | A new global variable was added. Globals are compile-time constructs backed by PostgreSQL session variables. |
| `DropGlobal`   | A global variable was removed.                                                                               |

Global modifications are handled as drop + add.

### Index Operations

| Operation     | Description                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CreateIndex` | A new index was added. Supports btree, hash, gist, gin, and brin methods, plus partial indexes with `WHERE` clauses. |
| `DropIndex`   | An index was removed.                                                                                                |

## Migration Tracking

Disc persists migration state in two PostgreSQL tables, created automatically when the migration engine initializes.

### disc_migrations

| Column           | Type                   | Description                                                         |
| ---------------- | ---------------------- | ------------------------------------------------------------------- |
| `id`             | `TEXT PRIMARY KEY`     | Migration ID (e.g., `m20240115T103000_abc123`)                      |
| `name`           | `TEXT NOT NULL`        | Auto-generated name (e.g., `create_user`, `schema_changes_3_types`) |
| `description`    | `TEXT`                 | Human-readable description of the operations                        |
| `schema_hash`    | `TEXT NOT NULL`        | Hash of the target schema after this migration                      |
| `applied_at`     | `TIMESTAMPTZ NOT NULL` | When the migration was applied                                      |
| `duration_ms`    | `INTEGER NOT NULL`     | Execution time in milliseconds                                      |
| `rollback_sql`   | `TEXT[]`               | Array of DDL statements to undo this migration                      |
| `checksum`       | `TEXT NOT NULL`        | Content checksum for integrity verification                         |
| `created_at`     | `TIMESTAMPTZ NOT NULL` | When the migration was generated                                    |
| `data_migration` | `BOOLEAN NOT NULL`     | Whether this migration has an associated data migration             |

### disc_migration_checkpoints

| Column            | Type                   | Description                                                   |
| ----------------- | ---------------------- | ------------------------------------------------------------- |
| `id`              | `TEXT PRIMARY KEY`     | Checkpoint ID                                                 |
| `name`            | `TEXT NOT NULL`        | Human-readable checkpoint name                                |
| `created_at`      | `TIMESTAMPTZ NOT NULL` | When the checkpoint was created                               |
| `schema_state`    | `JSONB NOT NULL`       | Serialized schema state at checkpoint time                    |
| `migration_state` | `JSONB NOT NULL`       | Serialized migration state (applied migrations, current hash) |

## Programmatic API

For advanced use cases, you can drive the migration system from TypeScript code instead of the CLI.

### SchemaManager

The primary entry point. Bridges SDL parsing, the query compiler schema, and migration planning/execution.

```typescript
import { ConnectionPool } from "disc/lib/connection-pool.ts";
import { SchemaManager } from "disc/migration/schema-manager.ts";

const pool = new ConnectionPool({ connectionString: "postgresql://..." });
await pool.initialize();

const manager = new SchemaManager({ pool, dryRun: false });
await manager.initialize();
```

#### Parse and Apply

```typescript
const result = await manager.applySchema(`
  module default {
    type User {
      required email: str { constraint exclusive; };
      required name: str;
    };
  };
`);

if (result.ok) {
  for (const migration of result.value) {
    console.log(`Applied ${migration.migrationId} in ${migration.durationMs}ms`);
  }
}
```

#### Plan Without Executing

```typescript
const plan = manager.planSchema(sdlSource);

if (plan.ok) {
  console.log(`${plan.value.operationsCount} operations`);
  console.log(`Estimated duration: ${plan.value.estimatedDuration}ms`);
}
```

#### Generate DDL from a Plan

```typescript
const ddl = manager.generateDDL(plan.value);

if (ddl.ok) {
  for (const stmt of ddl.value) {
    console.log(stmt);
  }
}
```

#### Validate a Plan

```typescript
const validation = manager.validateMigration(plan.value);

if (!validation.ok)
  console.error("Validation failed:", validation.error.message);
```

#### Rollback

```typescript
// Rollback the last migration
await manager.rollbackLastMigration();

// Rollback to a specific point
await manager.rollbackToMigration("m20240115T103000_abc123");
```

#### Status and History

```typescript
const status = await manager.getMigrationStatus();

if (status.ok) {
  console.log(`Applied: ${status.value.applied}`);
  console.log(`Latest: ${status.value.latestMigration?.id}`);
}

const history = await manager.getMigrationHistory();

if (history.ok) {
  for (const entry of history.value) {
    console.log(`${entry.id} - ${entry.name} (${entry.durationMs}ms)`);
  }
}
```

### MigrationEngine

Lower-level API for direct control over planning, execution, and rollback.

```typescript
import { MigrationEngine } from "disc/migration/engine.ts";

const engine = new MigrationEngine({
  migrationsDir: "./dbschema/migrations",
  schemaFile: "./dbschema/default.disc",
  databaseUrl: "postgresql://...",
  dryRun: false,
  autoApprove: true,
  backupBeforeMigration: false,
  rollbackOnError: true,
  connectionPool: pool,
});

await engine.initialize();

// Plan a migration
const plan = engine.planMigration(oldModules, newModules);

// Execute with automatic rollback on error
const result = await engine.executeMigrationWithRollback(plan.value);

// Generate rollback SQL for inspection
const rollbackSQL = engine.generateRollbackSQL(migration);

// Check rollback safety
const safety = engine.validateRollbackSafety(plan.value);
```

## Best Practices

### Always Preview in Production

Before applying migrations to a production database, use `--dry-run` to see exactly what DDL will be executed:

```bash
disc migrate --dry-run
```

Review the output carefully. Look for `DROP` statements, type changes, and new `NOT NULL` columns without defaults.

### Commit Migrations to Version Control

Migration history is tracked in the database, but your schema files should be committed alongside your application code. This ensures reproducibility and allows team members to see schema changes in pull request reviews.

### Test Migrations in Staging

Apply migrations to a staging environment that mirrors production before deploying. This catches issues like:

- Missing default values on required columns with existing data.
- Foreign key violations when dropping types that are referenced elsewhere.
- Index creation on large tables that may lock the table for an extended period.

### Use Data Migrations for Complex Transformations

When a schema change requires data transformation (e.g., splitting a `full_name` column into `first_name` and `last_name`), write a data migration instead of trying to encode the transformation in the DDL.

```typescript
// dbschema/migrations/m20240601T120000_split_name.data.ts
export default {
  name: "split_name",
  timestamp: "20240601T120000",

  async up(ctx) {
    await ctx.sql(`
      UPDATE "user"
      SET first_name = split_part(full_name, ' ', 1),
          last_name = split_part(full_name, ' ', 2)
      WHERE full_name IS NOT NULL
    `);
  },

  async down(ctx) {
    await ctx.sql(`
      UPDATE "user"
      SET full_name = first_name || ' ' || last_name
      WHERE first_name IS NOT NULL
    `);
  },
};
```

### Handle Required Columns Carefully

Adding a `required` property to an existing type with data will fail unless you provide a default value. The engine generates data migration hints for this:

```
Data migration hint: New required property User.role has no default value
```

Options:

1. Add a `default` clause to the property in your schema.
2. Write a data migration to backfill the column before making it required.
3. Split the change into two migrations: first add the column as optional, backfill it, then make it required.

### Keep Migrations Small

Prefer frequent, small schema changes over large, infrequent ones. Small migrations are easier to review, test, and rollback. If a migration touches more than 3-4 types, consider splitting it.
