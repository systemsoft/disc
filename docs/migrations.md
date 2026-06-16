# Migrations

Disc uses a declarative, schema-first migration system. You write your schema in SDL (`.disc`, `.gel`, or `.esdl` files), and Disc automatically generates the DDL statements needed to bring your PostgreSQL database in sync. Every migration is tracked in a `disc_migrations` table, and rollback SQL is stored alongside each migration for safe reversal.

Related documentation: [Schema](schema.md) | [CLI](cli.md) | [Bundled PostgreSQL](bundled-postgres.md)

## How Migrations Work

The migration pipeline has four stages:

```
SDL Source  -->  Parse  -->  Diff  -->  DDL  -->  Execute
(.disc)        (AST)     (Operations)  (SQL)   (PostgreSQL)
```

1. **Parse** -- The SDL parser reads your schema files and produces an AST (`Module[]`).
2. **Diff** -- The `SchemaDiffer` compares the new AST against the previously applied schema and produces a list of `MigrationOperation` objects describing what changed.
3. **Generate DDL** -- The `DDLGenerator` converts each operation into PostgreSQL DDL statements (`CREATE TABLE`, `ALTER TABLE`, etc.).
4. **Execute** -- The `MigrationEngine` runs the DDL inside a PostgreSQL transaction. If any statement fails, the entire migration is rolled back. On success, the migration is recorded in the `disc_migrations` table with its rollback SQL.

Each migration gets an auto-generated ID following the format `m<timestamp>_<random>`, for example `m20240115T103000_abc123`. The timestamp comes from `new Date().toISOString()` with separators stripped, and the random suffix is a 6-character base-36 string.

## Basic Workflow

> **Note (gh/geldata#3465):** `disc migrate` is a single-step command —
> it diffs the schema against the DB's last applied state, plans the
> DDL, and executes it in one pass. There is no separate "create the
> migration first, apply it second" step. Tools that ship file-based
> migrations (Gel, Rails, etc.) often require both; Disc tracks applied
> migrations in the `disc_migrations` table and replans from the schema
> every run, so a file-creation step has no purpose.
>
> `disc migrate --create` is a _preview_ — it prints the planned
> migration and generated DDL to stdout without executing or writing
> any file. Use it like `--dry-run` to see the impact of your changes
> before applying.

The typical development cycle is:

1. Edit your `.disc` schema file.
2. Run `disc migrate` to generate and apply the migration.
3. Review the output to confirm what was created, altered, or dropped.
4. Commit both the schema file and the migration history to version control.

### Example

Start with a schema file at `dbschema/default.disc`:

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

Run `disc migrate` again. Disc detects the diff and generates the DDL for the new `Post` table, the `author` foreign key, and the `user_posts` junction table.

## Creating Migrations

### Generate and Apply

```bash
disc migrate
```

Parses the schema, diffs against the current state, generates DDL, and executes it. This is the default behavior.

### Generate Without Applying

```bash
disc migrate --create
```

Generates the migration plan and shows the DDL that would be executed, but does not apply it to the database. Use this to review changes before committing.

### Preview (Dry Run)

```bash
disc migrate --dry-run
```

Runs the full pipeline including execution logging, but no DDL is actually sent to PostgreSQL. The schema state is updated internally so you can see what the next migration would look like, but the database is untouched.

### Auto-Approve

```bash
disc migrate --auto-approve
```

Skips the confirmation prompt and applies the migration immediately. Useful in CI/CD pipelines.

## Migration Status

Check the state of your migrations:

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

- **Applied** -- Total number of migrations that have been applied.
- **Latest** -- The ID and name of the most recently applied migration.
- **Schema** -- The schema hash of the current state.

## Rollback

Disc stores rollback SQL for each migration at apply time. You can use this to undo migrations.

### Rollback the Last Migration

```bash
disc migrate --rollback --force
```

Loads the most recently applied migration from the `disc_migrations` table, executes its stored rollback SQL in a transaction, and removes the migration record. The `--force` flag is required because rollbacks are destructive operations.

### Rollback to a Specific Migration

```bash
disc migrate --rollback-to m20240115T103000_abc123 --force
```

Rolls back all migrations applied after the specified migration ID, in reverse chronological order (most recent first). The target migration itself is preserved.

For example, if you have migrations `m001`, `m002`, `m003` applied and you run `--rollback-to m001`, then `m003` is rolled back first, followed by `m002`. Migration `m001` remains applied.

### Rollback Safety

Not all operations can be cleanly rolled back. The migration engine validates rollback safety and warns about operations that may require manual intervention:

- **DropType** -- Rolling back a `DROP TABLE` cannot restore the original data. The table structure is gone.
- **DropProperty** -- Rolling back a dropped column loses any data that was in that column.
- **AlterProperty (ChangeType)** -- Type changes may not be reversible if the conversion is lossy.

When the engine cannot generate automatic rollback SQL for an operation, it emits a comment in the rollback SQL:

```sql
-- MANUAL ROLLBACK REQUIRED: Recreate table 'user'
-- The original table structure was lost when it was dropped.
-- Please restore from backup or recreate the table manually.
```

### Rollback on Error

When `rollbackOnError` is enabled in the migration configuration (the default), the engine automatically rolls back a failed migration. If the migration DDL fails partway through, the pre-generated rollback SQL is executed to restore the database to its prior state.

```typescript
const engine = new MigrationEngine({
  // ...
  rollbackOnError: true
});

// If any DDL statement fails, the engine automatically
// executes the rollback SQL before returning the error.
const result = await engine.executeMigrationWithRollback(plan);
```

## Operation Classification: Safe / Unsafe / Ambiguous

Disc classifies every migration operation into one of three categories (`migration/types.ts` `MigrationOperation.classification`):

| Class       | Meaning                                                                                                                                                                                      | Gate behavior                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `safe`      | Additive, reversible, no data loss (e.g. `CreateType`, `AddProperty`, `AddConstraint` on a new column).                                                                                      | Applied without prompting.           |
| `unsafe`    | Drops or destroys data (`DropType`, `DropProperty`, `RecreateScalar` for enum changes).                                                                                                      | Refused unless `--unsafe` is passed. |
| `ambiguous` | Could be interpreted multiple ways and the differ can't pick — type narrowing without a cast, optional→required without a default, single↔multi cardinality flips, `AlterLink ChangeTarget`. | Refused unless `--unsafe` is passed. |

The classifier (`migration/engine.ts` `classifyUnsafeOperations`) is non-interactive: Disc _labels_ the plan and refuses, rather than prompting. Non-CLI callers (the admin UI, programmatic invocations) get the same structured classification on `MigrationOperation.classification` and can render their own UX.

To apply an unsafe plan from the CLI, acknowledge with `--unsafe`:

```bash
disc migrate --unsafe
```

For ambiguous operations, the right fix is usually to disambiguate at the SDL level (add a default, add an explicit cast, split the change into two migrations) rather than reach for `--unsafe`. The flag is the escape hatch, not the workflow.

### Enum value removal — `RecreateScalar`

PostgreSQL's `ALTER TYPE ... ADD VALUE` is safe and inside-transaction-friendly on PG 12+, so adding enum values is a `safe` op (`AddEnumValue`). Removing or reordering enum values isn't supported in PostgreSQL DDL — Disc emits a single `RecreateScalar` op that drops and recreates the type. That op is flagged `unsafe`, and the generated DDL emits a guard `DO` block that aborts when columns still reference the type:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE udt_name = 'disc_enum_status'
  ) THEN
    RAISE EXCEPTION 'Enum disc_enum_status still has dependent columns; '
      'migrate the columns to a different type first';
  END IF;
END $$;

DROP TYPE disc_enum_status;
CREATE TYPE disc_enum_status AS ENUM ('open', 'closed', 'archived');
```

The guard is intentional: an operator who skips manually migrating the dependent columns gets a clear error rather than silent corruption. (`migration/ddl.ts` `generateRecreateScalar`, gh/geldata#2564 + #8517)

### Enum scalar columns wire through to the PG enum type

When a property is typed as a user-declared enum scalar, the migration emits a column of the matching `disc_enum_<name>` PG type instead of the historical `TEXT` fallback. The DDL generator carries an enum-scalar registry (primed by `MigrationEngine.planMigration` from the post-state schema) so that:

```
module default {
  scalar type Status extending enum<draft, published, archived>;
  type Article {
    required title: str;
    status: Status;
  };
}
```

…emits:

```sql
CREATE TYPE disc_enum_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE article (
  id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  status disc_enum_status
);
```

…instead of `status TEXT`. Both unqualified (`status: Status`) and qualified (`status: default::Status`) property type strings resolve. A cascade-aware reordering pass in the differ guarantees `CreateScalar` runs before any column referencing it and `DropScalar`/`RecreateScalar` runs after any column dependency has been removed in the same migration plan. (`migration/ddl.ts` `setEnumScalars` + `migration/differ.ts` `reorderForCascade`, gh/geldata#8517 full impl)

## Production Migration Rollout

Migrating a production database is a five-step ritual:

1. **Plan in dry-run.** Before touching the prod DB, run the migration against a staging copy and inspect the generated DDL:

   ```bash
   DATABASE_URL="postgres://staging-user@staging-host/disc" disc migrate --dry-run
   ```

   Look for `DROP` statements, `ALTER COLUMN ... TYPE` (especially when the cast can fail), and any operation marked `unsafe` or `ambiguous`.

2. **Apply to staging first.** Run the same migration without `--dry-run` against staging and exercise the application's hot paths against the new schema. Catch:
   - Foreign-key violations from concurrent writes.
   - Default-value mismatches on newly required columns.
   - Index-creation hangs on large tables (PostgreSQL's `CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock on the table; use `CREATE INDEX CONCURRENTLY` manually for hot tables, or split the migration).

3. **Schedule the production window.** Disc serializes migrations on a per-database advisory lock (see [Advisory Lock + Lock Timeout](#advisory-lock--lock-timeout)) so a second `disc migrate` will queue rather than collide. Still, schedule away from peak traffic if the migration creates indexes or rewrites large tables.

4. **Apply with `--auto-approve` and capture output.** In CI/CD pipelines:

   ```bash
   disc migrate --auto-approve 2>&1 | tee migration-$(date -u +%Y%m%dT%H%M%SZ).log
   ```

   Persist the log: it includes the migration ID, applied DDL, and duration — useful for post-mortems.

5. **Verify.** After apply:

   ```bash
   disc migrate --status
   curl -sf https://disc.example.com/health/ready
   ```

   The status output shows the migration ID and the new schema hash.

### Rollback strategy in production

Disc stores rollback SQL alongside every applied migration in the `disc_migrations` table. Rollback paths:

- **Last migration was wrong:** `disc migrate --rollback --force` reverses the most recent migration using its stored rollback SQL.
- **Need to revert further:** `disc migrate --rollback-to <id> --force` rolls back every migration applied after `<id>` in reverse chronological order. The target migration itself stays applied.
- **Operation can't be auto-rolled-back:** If the rollback SQL contains a `MANUAL ROLLBACK REQUIRED` comment (e.g., a dropped table whose data is gone), restore from a database backup. Disc does not snapshot data — that's PostgreSQL's job (see [Bundled PostgreSQL → Backups](bundled-postgres.md)).

Rollback is destructive — `--force` is required so you can't typo the command.

> Disc ships migration rollback as a first-class CLI flag; upstream Gel tracks the same feature at [gh/geldata#4300](https://github.com/geldata/gel/issues/4300) and hasn't shipped it.

### Advisory Lock + Lock Timeout

Every `disc migrate` transaction starts with two pragmas to keep concurrent-traffic interactions safe (gh/geldata#6304):

```sql
SET LOCAL lock_timeout = '60000ms';
SELECT pg_advisory_xact_lock(<MIGRATION_ADVISORY_LOCK_KEY>);
```

- `lock_timeout` makes DDL statements that contend with a long-running query fail fast (60s by default) instead of blocking indefinitely. Tunable via `MigrationConfig.lockTimeoutMs`; pass `0` to disable.
- `pg_advisory_xact_lock` serializes concurrent `disc migrate` invocations against the same database. Tunable via `MigrationConfig.useAdvisoryLock` (default `true`).

The advisory lock key is `MIGRATION_ADVISORY_LOCK_KEY` from `migration/types.ts` — a stable 64-bit constant derived from `"disc_migrations"` via FNV-1a. If you need to drop the lock by hand (e.g., after a crash), find it in `pg_locks WHERE locktype = 'advisory'`.

### CI/CD pattern

A typical pipeline shape:

```yaml
# .github/workflows/migrate.yml
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
      - name: Plan against staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
        run: deno task cli migrate --dry-run
      - name: Apply to staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
        run: deno task cli migrate --auto-approve
      - name: Smoke test staging
        run: ./scripts/smoke.sh ${{ secrets.STAGING_URL }}
      - name: Apply to production
        if: github.ref == 'refs/heads/main'
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
        run: deno task cli migrate --auto-approve
```

The dry-run step has no side effects on staging (planned but never applied). Add `--unsafe` only when the migration is intentionally destructive _and_ the previous step (smoke or backup) succeeded.

### Pre-migration backup

For any irreversible production migration, snapshot the database first:

```bash
pg_dump --format=custom --file=pre-migration-$(date -u +%Y%m%dT%H%M%SZ).dump \
  "$DATABASE_URL"
disc migrate --auto-approve
```

Restore via `pg_restore` if rollback isn't viable. See [CLI → disc db](cli.md#disc-db-create) for Disc-side database management.

## Workflow: Create → Review → Apply → Rollback

The migration commands compose into a coherent narrative; full reference for each lives in the [CLI documentation](cli.md#disc-migrate). Here's the lifecycle in one place:

| Step     | Command                              | What it does                                                                             |
| -------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Create   | `disc migrate --create`              | Print the planned migration plan + DDL without executing or writing files. Preview only. |
| Review   | `disc migrate --dry-run`             | Same plan, plus the post-apply schema state, against the live DB.                        |
| Apply    | `disc migrate` (or `--auto-approve`) | Generate, execute, and record the migration in `disc_migrations`.                        |
| Status   | `disc migrate --status`              | Show count of applied migrations and the latest ID/name/schema hash.                     |
| Rollback | `disc migrate --rollback --force`    | Reverse the most recent migration via stored rollback SQL.                               |
| Squash   | `disc migrate --squash`              | Combine accumulated migrations into one consolidated entry.                              |

The full flag set (e.g., `--rollback-to`, `--squash-from`/`--squash-to`, `--unsafe`) is documented in [CLI → disc migrate](cli.md#disc-migrate). The narrative above maps each command back to a step in the production rollout — re-read that section before running anything against a production database.

## Data Migrations

Schema (DDL) migrations handle structural changes -- creating tables, adding columns, changing types. Data migrations handle the content transformations that accompany those structural changes -- backfilling new columns, converting data formats, or splitting tables.

### Creating a Data Migration

Data migration files live alongside schema migrations in `dbschema/migrations/` and follow the naming pattern:

```
m<timestamp>_<name>.data.ts
```

The timestamp must match the schema migration it pairs with. When the engine applies a schema migration, it automatically discovers and runs any data migration file with a matching timestamp.

### Data Migration Structure

Each data migration file exports a default object implementing the `DataMigration` interface:

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
  }
};
```

### DataMigrationContext

The context object passed to `up()` and `down()` provides:

| Method                    | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `ctx.sql(query, params?)` | Execute a SQL query within the migration transaction. Returns row results. |
| `ctx.log(message)`        | Log a message to the migration output.                                     |
| `ctx.pool`                | Direct access to the connection pool (for advanced use cases).             |

The `ctx.edgeql()` method is reserved for future use. Currently, data migrations must use raw SQL via `ctx.sql()`.

### Data Migration Rules

- Data migration `up()` runs inside the same transaction as the schema migration.
- If `up()` throws, the entire migration (schema + data) is rolled back.
- The `down()` function is optional but recommended. Without it, the data migration cannot be rolled back.
- Data migrations cannot be squashed (see below).

## Squashing

Over time, a project accumulates many small migrations. Squashing combines multiple sequential migrations into a single consolidated migration.

### Squash All Migrations

```bash
disc migrate --squash
```

Combines all applied migrations into one. The resulting migration contains all DDL statements in order, and all rollback statements in reverse order.

### Squash a Range

```bash
disc migrate --squash-from m20240101_aaa --squash-to m20240601_zzz
```

Combines only the migrations in the specified range (inclusive on both ends). The `--squash-from` migration must precede `--squash-to` in chronological order.

### Squash Restrictions

- **Data migrations cannot be squashed.** If any migration in the range has an associated data migration, the squash fails with an error listing the affected migration IDs.
- The squash produces a new migration named `squashed_<first_id>_to_<last_id>`.
- Forward DDL statements are concatenated in order; rollback statements are concatenated in reverse order.

## Supported Operations

The schema differ detects the following changes between the old and new schema:

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

Trigger modifications are handled as drop + add (triggers cannot be altered in place in PostgreSQL).

### Rewrite Operations (within AlterType)

| Operation     | Description                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AddRewrite`  | A new rewrite rule was added to a property. Generates a `BEFORE INSERT/UPDATE` trigger that sets the column value. |
| `DropRewrite` | A rewrite rule was removed. Drops the trigger and function.                                                        |

Rewrite modifications are handled as drop + add.

### Alias Operations

| Operation     | Description                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- |
| `CreateAlias` | A new alias (expression alias) was added. Aliases are compile-time only and produce no DDL. |
| `DropAlias`   | An alias was removed. No DDL produced.                                                      |

Alias modifications are handled as drop + add (aliases are compile-time constructs).

### Global Operations

| Operation      | Description                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `CreateGlobal` | A new global variable was added. Globals are compile-time constructs backed by PostgreSQL session variables. |
| `DropGlobal`   | A global variable was removed.                                                                               |

Global modifications are handled as drop + add.

### Index Operations

The differ compares the index sets on a surviving type and emits standalone index operations:

| Operation     | Description                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CreateIndex` | A new index was added. Supports btree, hash, gist, gin, and brin methods, plus partial indexes with `WHERE` clauses. |
| `DropIndex`   | An index was removed.                                                                                                |

- **Added** index → `CreateIndex`, emitting `CREATE INDEX idx_<table>_<col> ON <table> (col);` (with `UNIQUE`, `USING <method>`, and a partial `WHERE` clause added when the index declares them).
- **Removed** index → `DropIndex`, emitting `DROP INDEX IF EXISTS idx_<table>_<col>;`.
- **Changed** index (same name, different columns or uniqueness) → a `DropIndex` followed by a `CreateIndex` — the old definition is dropped first so the re-create can't collide with the stale one.
- **Unchanged** index → no operation.

Indexes are keyed by name plus their ordered column list (and uniqueness), so reordering columns or toggling `unique` counts as a change. All four index operations are classified `safe`.

## Migration Tracking

Disc persists migration state in two PostgreSQL tables, created automatically when the migration engine initializes.

### disc_migrations

| Column           | Type                   | Description                                                                  |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `id`             | `TEXT PRIMARY KEY`     | Migration ID (e.g., `m20240115T103000_abc123`)                               |
| `name`           | `TEXT NOT NULL`        | Auto-generated name (e.g., `create_user`, `schema_changes_3_types`)          |
| `description`    | `TEXT`                 | Human-readable description of the operations                                 |
| `schema_hash`    | `TEXT NOT NULL`        | Hash of the target schema after this migration                               |
| `applied_at`     | `TIMESTAMPTZ NOT NULL` | When the migration was applied                                               |
| `duration_ms`    | `INTEGER NOT NULL`     | Execution time in milliseconds                                               |
| `rollback_sql`   | `TEXT[]`               | Array of DDL statements to undo this migration                               |
| `checksum`       | `TEXT NOT NULL`        | Content checksum for integrity verification                                  |
| `created_at`     | `TIMESTAMPTZ NOT NULL` | When the migration was generated                                             |
| `data_migration` | `BOOLEAN NOT NULL`     | Whether this migration has an associated data migration                      |
| `applied_order`  | `INTEGER NOT NULL`     | Monotonic apply order (backfilled from `applied_at` for older instances)     |
| `schema_modules` | `JSONB`                | Serialized schema modules, used to reconstruct the baseline on the next diff |

### disc_migration_checkpoints

| Column            | Type                   | Description                                                   |
| ----------------- | ---------------------- | ------------------------------------------------------------- |
| `id`              | `TEXT PRIMARY KEY`     | Checkpoint ID                                                 |
| `name`            | `TEXT NOT NULL`        | Human-readable checkpoint name                                |
| `created_at`      | `TIMESTAMPTZ NOT NULL` | When the checkpoint was created                               |
| `schema_state`    | `JSONB NOT NULL`       | Serialized schema state at checkpoint time                    |
| `migration_state` | `JSONB NOT NULL`       | Serialized migration state (applied migrations, current hash) |

## Programmatic API

For advanced use cases — tooling, custom CI flows, embedding Disc's
migration engine inside another app, building an admin UI on top —
you can drive the migration system from TypeScript code instead of
the CLI. (gh/geldata#6094)

### Lifecycle Overview

The migration system is layered from highest-level (most batteries
included) to lowest-level (most control):

| Layer               | Best for                                                         | Module                        |
| ------------------- | ---------------------------------------------------------------- | ----------------------------- |
| `SchemaManager`     | Drive the full pipeline: parse SDL → diff → plan → DDL → execute | `migration/schema-manager.ts` |
| `MigrationEngine`   | Plan / execute / rollback against pre-built `Module[]` ASTs      | `migration/engine.ts`         |
| `SchemaDiffer`      | Pure diff over two `Module[]` trees, no DB I/O                   | `migration/differ.ts`         |
| `DDLGenerator`      | Pure DDL emission from `MigrationOperation[]`, no DB I/O         | `migration/ddl.ts`            |
| `MigrationTracker`  | Read-write access to `disc_migrations` / checkpoint tables       | `migration/tracker.ts`        |
| `MigrationSquasher` | Combine N applied migrations into one rolled-up form             | `migration/squash.ts`         |

The high-level `SchemaManager` covers the common case; reach further
down only when you need primitives the higher layer hides.

### Connection Injection

Every layer accepts a `ConnectionPool` from `disc/lib/connection-pool.ts`.
The pool wraps a `pg`-compatible driver and exposes `withConnection()`,
`withTransaction()`, plus pool stats. **You own the pool lifecycle** —
the migration code never closes a pool you passed in. This makes it
safe to share a single pool across both your app's query traffic and
its migration runs.

```typescript
import { ConnectionPool } from "disc/lib/connection-pool.ts";

const pool = new ConnectionPool({
  connectionString: process.env.DATABASE_URL!,
  max: 10
});
await pool.initialize();

// Pass into SchemaManager / MigrationEngine — they share, don't close
const manager = new SchemaManager({ pool, dryRun: false });
await manager.initialize();

// …work…

await manager.close(); // closes the manager's tracker only, NOT the pool
await pool.close(); // app shuts down the pool when it's truly done
```

### Inspecting the Diff Before Applying

The most common reason to drop down from the CLI is "I want to see what
the differ produces before deciding to apply it." Two ways:

```typescript
// 1. Plan-only with full operation detail (no DB writes)
const plan = manager.planSchema(sdlSource);
if (plan.ok) {
  for (const m of plan.value.migrations) {
    for (const op of m.operations) {
      // op.kind: "CreateType" | "DropProperty" | … | "RecreateScalar"
      // op.classification: "safe" | "unsafe" | "ambiguous"
      console.log(`${op.kind} (${op.classification ?? "safe"})`);
    }
  }
}

// 2. Generate the DDL but don't execute
const ddl = manager.generateDDL(plan.value);
if (ddl.ok) {
  console.log(ddl.value.join("\n"));
}
```

The `classification` field carries the same `safe | unsafe | ambiguous`
labels the CLI's gate uses (see [Operation Classification](#operation-classification-safe--unsafe--ambiguous)).
A programmatic caller can branch on it to either auto-apply, prompt
the human, or refuse — whatever the surrounding tool needs.

### Safe vs Unsafe Gates from Code

The unsafe gate behaves the same way for programmatic callers as for
the CLI. By default the gate refuses any plan containing an `unsafe`
or `ambiguous` operation; opt in by setting `allowUnsafe` on the
engine config (or by passing it through `SchemaManager.applySchema()`
when supported by your version).

For finer control, use `MigrationEngine` directly — it lets you
inspect the operation list, classify ops yourself, and execute one
migration at a time inside your own transaction.

### Pure Diff (No DB)

When all you have are two `Module[]` ASTs (e.g. you're testing the
differ inside a unit test, or building a "preview the diff" UI on
the schema editor):

```typescript
import { SchemaDiffer } from "disc/migration/differ.ts";

const differ = new SchemaDiffer();
const operations = differ.diff(oldModules, newModules);

// operations: MigrationOperation[] — kind, classification, payload
```

`SchemaDiffer` does no I/O. The output is the same `MigrationOperation[]`
the engine consumes; pass it to `DDLGenerator` for raw SQL or feed it
back into `MigrationEngine` to apply.

### Direct DDL Emission

```typescript
import { DDLGenerator } from "disc/migration/ddl.ts";

const ddl = new DDLGenerator();
const statements = ddl.generateDDL(operations);
// string[] — each entry is one DDL statement, ready for `pool.query(stmt)`
```

This is the layer the higher-level engine uses. No transaction
wrapping is added — caller is responsible for `BEGIN` / `COMMIT` if
they want the apply to be atomic.

### Reading State

```typescript
import { MigrationTracker } from "disc/migration/tracker.ts";

const tracker = new MigrationTracker(pool);
await tracker.initialize();

const applied = await tracker.getAppliedMigrations(); // Result<string[]>
const history = await tracker.getMigrationHistory(); // Result<HistoryEntry[]>
```

The tracker creates `disc_migrations` and `disc_migration_checkpoints`
on `initialize()` if they don't already exist — safe to call repeatedly.

### Embedding in Another App

A typical embed-in-an-app pattern looks like:

```typescript
import { ConnectionPool } from "disc/lib/connection-pool.ts";
import { SchemaManager } from "disc/migration/schema-manager.ts";

export async function migrate(opts: {
  databaseUrl: string;
  sdlSource: string;
  dryRun?: boolean;
}): Promise<{ migrationsApplied: number; durationMs: number; }> {
  const pool = new ConnectionPool({ connectionString: opts.databaseUrl });
  await pool.initialize();

  const manager = new SchemaManager({ pool, dryRun: opts.dryRun ?? false });
  await manager.initialize();

  try {
    const start = Date.now();
    const result = await manager.applySchema(opts.sdlSource);
    if (!result.ok) {
      throw new Error(`migrate failed: ${result.error.message}`);
    }
    return {
      migrationsApplied: result.value.length,
      durationMs: Date.now() - start
    };
  } finally {
    await manager.close();
    await pool.close();
  }
}
```

The shape mirrors what the CLI does: call `applySchema()` once with
your SDL, get back a list of applied migrations or a structured error.
The Result-based API means programmatic callers never need to catch
`MigrationError` exceptions for the common failure modes (gate refused,
diff was empty, DB rejected a statement) — those all flow through
`result.ok === false`.

### SchemaManager

The primary entry point. Bridges SDL parsing, the query compiler schema, and migration planning/execution.

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
    console.log(
      `Applied ${migration.migrationId} in ${migration.durationMs}ms`
    );
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

if (!validation.ok) {
  console.error("Validation failed:", validation.error.message);
}
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

Lower-level API for direct control over planning, execution, and rollback.

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
  connectionPool: pool
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

## Resolving Merge Conflicts (gh/geldata#6085)

Disc tracks applied migrations in the `disc_migrations` database table,
not as files on disk — there is no `dbschema/migrations/` for schema
migrations to write to (data-migration `.data.ts` files are the
exception; see [Data Migrations](#data-migrations)). This makes the
merge-conflict story simpler than tools that ship file-based
migrations: the only thing in your repo that two developers might
both edit is the schema source (`dbschema/default.disc`) itself.

**The git-level conflict.** When two branches change the same SDL
file, you get a normal git merge conflict in `dbschema/default.disc`.
Resolve it like any other source conflict — keep both additions, pick
one rename, hand-merge type definitions — and commit the resolved
schema.

**The DDL-level reconciliation.** After the schema is merged, run:

```bash
disc migrate --dry-run
```

The schema differ compares your merged schema against the DB's last
applied state and plans the DDL needed to bring the DB up to date.
Because Disc replans from the schema each run (rather than replaying a
stack of migration files), the order in which the two branches landed
their changes in any given database is irrelevant — the differ will
always emit the right delta.

**True intent conflicts.** If both branches changed the _same_ field
in incompatible ways (one renamed `created_at` → `createdAt`, the
other changed its type), that's a conflict no auto-merger can fix.
Resolve at the SDL level: pick one intent, discard or harmonize the
other, then `disc migrate --dry-run` to verify the resulting plan
matches your intention.

**Multi-environment reconciliation.** The above assumes the merge
target is a single dev database tracked by `disc_migrations`. If two
production environments diverged because each was advanced by a
different branch's migrations, reconcile by:

1. Picking one as the canonical state.
2. Pointing both schemas (and the schemas in version control) at the
   same merged SDL.
3. Running `disc migrate --dry-run` against each environment to see
   the per-DB delta.
4. Applying with `disc migrate` (and `--unsafe` if any environment
   needs destructive ops to converge).

**Avoiding the situation.** Treat `dbschema/*.disc` like
`package-lock.json` in PR review: any change deserves a careful look
at what `disc migrate --dry-run` would emit. Squash long migration
chains (`disc migrate --squash`) periodically so historical state is
compact and easier to reason about.

## Branch Workflows (gh/geldata#6083)

The merge-conflict guidance above covers the moment two branches
land. This section walks through the day-to-day workflow on a
single branch — the "how do I iterate without leaving migration
debris in my git history" question.

### Recipe: rapid prototyping with `disc db push`

`disc db push` (gh/geldata#3761) applies the current SDL directly
to the live database without recording a migration:

```bash
# Edit dbschema/default.disc — add a field, drop one, change a type
$EDITOR dbschema/default.disc

# Push to the live DB. No migration history written.
disc db push --force

# Iterate freely: edit, push, run tests
$EDITOR dbschema/default.disc
disc db push --force
```

When the design settles, snapshot it as a migration:

```bash
disc migrate --create
```

The differ produces a single migration covering the cumulative
shape change since the last recorded baseline — no intermediate
"add field, oh wait, remove it, oh wait, change its type" steps
in the migration log.

`--force` is required because `db push` skips the audit history;
this is the foot-gun gate so production environments can't be
pushed by accident.

### Recipe: feature branch with schema changes

When you start a feature branch on top of `main`:

```bash
git checkout -b feature/add-tags
$EDITOR dbschema/default.disc      # add tag schema
disc db push --force               # apply to local DB
# write code that uses the new types, run tests, iterate
```

When the feature is ready:

```bash
disc migrate --create              # produces one migration covering
                                   #  every schema change in the branch
git add dbschema/default.disc
git commit -am "feat: add tags"
git push origin feature/add-tags
```

The migration table tracks _what's applied_ to the database, not
_what's in git_ — so a branch that hasn't been merged just has
extra rows in the local dev DB's `disc_migrations` table. Branch
switching needs no special action; `disc migrate` against the
branch's schema brings the DB back into sync (potentially with
unsafe operations gated by `--unsafe` if you're undoing
destructive changes).

### Recipe: combining migrations + data transformations

Schema changes and the data backfill that goes with them belong
together. Disc's data-migration system (see [Data Migrations](#data-migrations))
links a `*.data.ts` file to a schema migration by timestamp:

```bash
disc migrate --create               # creates m20260507120000_add_user_status
                                   #  (schema migration, recorded automatically)
```

Then write the matching data migration:

```typescript
// dbschema/migrations/m20260507120000_add_user_status.data.ts
export default {
  name: "Backfill user status",
  timestamp: "20260507120000", // matches the schema migration
  async up({ sql }) {
    await sql(`UPDATE users SET status = 'active' WHERE status IS NULL`);
  },
  async down({ sql }) {
    await sql(`UPDATE users SET status = NULL WHERE status = 'active'`);
  }
};
```

The next `disc migrate` runs the schema migration first, then the
matching data migration — both inside the same PG transaction. If
the data migration throws, the entire migration rolls back atomically.

### Recipe: rolling back a feature branch's migrations

If a branch's migrations were applied to your dev DB but the
feature was cancelled, roll back to the pre-branch baseline:

```bash
disc migrate --rollback-to <id-of-migration-before-branch> --force
git checkout main
disc migrate                       # re-applies main's state
```

Or — for the dev database specifically — wipe and re-apply:

```bash
disc db wipe <name> --force        # drops + recreates the DB
disc migrate                       # re-applies main's full chain
```

`db wipe` is the nuclear option; only use on dev.

## Best Practices

### Always Preview in Production

Before applying migrations to a production database, use `--dry-run` to see exactly what DDL will be executed:

```bash
disc migrate --dry-run
```

Review the output carefully. Look for `DROP` statements, type changes, and new `NOT NULL` columns without defaults.

### Commit Migrations to Version Control

Migration history is tracked in the database, but your schema files should be committed alongside your application code. This ensures reproducibility and allows team members to see schema changes in pull request reviews.

### Test Migrations in Staging

Apply migrations to a staging environment that mirrors production before deploying. This catches issues like:

- Missing default values on required columns with existing data.
- Foreign key violations when dropping types that are referenced elsewhere.
- Index creation on large tables that may lock the table for an extended period.

### Use Data Migrations for Complex Transformations

When a schema change requires data transformation (e.g., splitting a `full_name` column into `first_name` and `last_name`), write a data migration instead of trying to encode the transformation in the DDL.

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
  }
};
```

### Handle Required Columns Carefully

Adding a `required` property to an existing type with data will fail unless you provide a default value. The engine generates data migration hints for this:

```
Data migration hint: New required property User.role has no default value
```

Options:

1. Add a `default` clause to the property in your schema.
2. Write a data migration to backfill the column before making it required.
3. Split the change into two migrations: first add the column as optional, backfill it, then make it required.

### Keep Migrations Small

Prefer frequent, small schema changes over large, infrequent ones. Small migrations are easier to review, test, and rollback. If a migration touches more than 3-4 types, consider splitting it.
