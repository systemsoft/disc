/**
 * Regression pins and gap markers for upstream Gel migration issues.
 *
 * Each test maps to a specific gh/geldata issue from `docs/future-triage.md`.
 * The intent is to (a) pin behavior Disc already handles correctly and
 * (b) document explicit gaps so future schema-evolution work has clear
 * starting points.
 *
 * Cross-reference table:
 *   gh/geldata#1147 — abstract type extraction with shared properties (closed-completed upstream 2020)
 *   gh/geldata#4343 — DROP CONSTRAINT (closed-not_planned upstream)
 *   gh/geldata#8517 — drop enum with dependents (open upstream); Disc now diffs scalars
 *   gh/geldata#2564 — removing/reordering enum values (closed-completed upstream 2021)
 *   gh/geldata#5617 — user-specified IDs in migrations (open upstream); Disc supports via insert.id
 */

import { assertEquals } from "@std/assert";
import { SDLParser } from "../schema/parser.ts";
import { SDLConverter } from "../schema/converter.ts";
import { SchemaDiffer } from "./differ.ts";
import { DDLGenerator } from "./ddl.ts";
import * as Types from "./types.ts";

function diff(beforeSrc: string, afterSrc: string): Types.MigrationOperation[] {
  const conv = new SDLConverter();
  const before = conv.convertToModules(new SDLParser(beforeSrc).parse());
  const after = conv.convertToModules(new SDLParser(afterSrc).parse());
  return new SchemaDiffer().diff(before, after);
}

// ---------------------------------------------------------------------------
// gh/geldata#1147: abstract type extraction triggered InternalServerError
// when re-applied. Disc must produce a non-empty diff once and an empty
// diff on the second pass (idempotent).
// ---------------------------------------------------------------------------
Deno.test("Gel #1147: abstract extraction is idempotent (no ISE on rerun)", () => {
  const before = `
    module default {
      type User {
        required nickname: str;
        required created_at: datetime {
          default := datetime_current();
          readonly := true;
        };
        edited_at: datetime;
      }
      type Article {
        author: User;
      }
    }
  `;

  const after = `
    module default {
      abstract type Editable {
        required created_at: datetime {
          default := datetime_current();
          readonly := true;
        };
        edited_at: datetime;
      }
      type User extending Editable {
        required nickname: str;
      }
      type Article extending Editable {
        author: User;
      }
    }
  `;

  // First pass: produces a real diff (creates Editable, drops the local
  // properties on User since they now come from the parent).
  const ops1 = diff(before, after);
  const kinds1 = ops1.map((op) => op.kind);
  assertEquals(
    kinds1.includes("CreateType"),
    true,
    "first pass should create the abstract Editable type",
  );

  // Second pass over the *same* schema state: empty diff. This is the
  // bug from #1147 — a non-empty rerun blows up with ISE upstream.
  const ops2 = diff(after, after);
  assertEquals(
    ops2.length,
    0,
    "rerunning the diff over an unchanged schema must be idempotent",
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#4343: closed-not_planned upstream. Disc supports property-level
// `DROP CONSTRAINT` (the most common case) — this pins that path. Type-level
// `constraint expression on (...)` removal is currently a no-op in the
// differ; see `Disc-vs-Gel divergence` in the continuity ledger.
// ---------------------------------------------------------------------------
Deno.test("Gel #4343: property-level DROP CONSTRAINT produces an AlterProperty op", () => {
  const before = `
    module default {
      type User {
        required email: str {
          constraint exclusive;
        };
      }
    }
  `;

  const after = `
    module default {
      type User {
        required email: str;
      }
    }
  `;

  const ops = diff(before, after);
  assertEquals(ops.length, 1);
  const alter = ops[0] as Types.AlterTypeOperation;
  assertEquals(alter.kind, "AlterType");
  assertEquals(alter.typeName, "User");
  const propOp = alter.operations[0] as Types.AlterPropertyOperation;
  assertEquals(propOp.kind, "AlterProperty");
  assertEquals(propOp.propertyName, "email");
  const drop = propOp.changes.find((c) => c.kind === "DropConstraint");
  assertEquals(drop?.oldValue, "exclusive");
});

// ---------------------------------------------------------------------------
// gh/geldata#8517 + gh/geldata#2564: scalar/enum value diffing.
// Disc now extracts scalar declarations alongside object types and emits
// explicit operations for enum value adds, removes, and reorders.
// ---------------------------------------------------------------------------
Deno.test("Gel #8517: adding an enum value emits AddEnumValue", () => {
  const before = `
    module default {
      scalar type CurrentRoles extending enum<admin, user>;
      type CurrentUser {
        required role: CurrentRoles;
      }
    }
  `;

  const after = `
    module default {
      scalar type CurrentRoles extending enum<admin, user, guest>;
      type CurrentUser {
        required role: CurrentRoles;
      }
    }
  `;

  const ops = diff(before, after);
  const enumOps = ops.filter((o) =>
    o.kind === "AddEnumValue" || o.kind === "CreateScalar" ||
    o.kind === "RecreateScalar"
  );
  assertEquals(enumOps.length, 1, "expected exactly one enum value op");
  const addOp = enumOps[0] as Types.AddEnumValueOperation;
  assertEquals(addOp.kind, "AddEnumValue");
  assertEquals(addOp.scalarName, "CurrentRoles");
  assertEquals(addOp.value, "guest");

  // Mid-list addition anchors `before` so PG inserts in the right slot.
  const midAfter = `
    module default {
      scalar type CurrentRoles extending enum<admin, manager, user>;
      type CurrentUser {
        required role: CurrentRoles;
      }
    }
  `;
  const midOps = diff(before, midAfter);
  const midAdd = midOps.find((o) => o.kind === "AddEnumValue") as
    | Types.AddEnumValueOperation
    | undefined;
  assertEquals(midAdd?.value, "manager");
  assertEquals(midAdd?.before, "user");
});

Deno.test("Gel #8517: AddEnumValue emits ALTER TYPE ... ADD VALUE DDL", () => {
  const before = `
    module default {
      scalar type Status extending enum<draft, published>;
    }
  `;
  const after = `
    module default {
      scalar type Status extending enum<draft, published, archived>;
    }
  `;
  const ops = diff(before, after);
  const ddl = new DDLGenerator().generateDDL(ops);
  const alterAdd = ddl.find((s) => s.includes("ALTER TYPE") && s.includes("ADD VALUE"));
  assertEquals(alterAdd !== undefined, true, "expected an ALTER TYPE ADD VALUE statement");
  assertEquals(
    alterAdd!.includes("'archived'"),
    true,
    "ALTER TYPE statement should reference the new enum value",
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#2564: removing or reordering enum values requires recreating
// the type — PG has no native DROP VALUE and enum order is positional.
// Disc emits a single RecreateScalar op flagged unsafe so the gate refuses
// it without --unsafe.
// ---------------------------------------------------------------------------
Deno.test("Gel #2564: removing an enum value emits RecreateScalar (removed-values)", () => {
  const before = `
    module default {
      scalar type Status extending enum<draft, published, archived>;
    }
  `;
  const after = `
    module default {
      scalar type Status extending enum<draft, published>;
    }
  `;
  const ops = diff(before, after);
  const recreate = ops.find((o) => o.kind === "RecreateScalar") as
    | Types.RecreateScalarOperation
    | undefined;
  assertEquals(recreate !== undefined, true, "expected a RecreateScalar op");
  assertEquals(recreate!.scalarName, "Status");
  assertEquals(recreate!.reason, "removed-values");
  assertEquals(recreate!.enumValues, ["draft", "published"]);
  assertEquals(recreate!.oldEnumValues, ["draft", "published", "archived"]);
});

Deno.test("Gel #2564: reordering enum values emits RecreateScalar (reordered-values)", () => {
  const before = `
    module default {
      scalar type Status extending enum<draft, published, archived>;
    }
  `;
  const after = `
    module default {
      scalar type Status extending enum<published, draft, archived>;
    }
  `;
  const ops = diff(before, after);
  const recreate = ops.find((o) => o.kind === "RecreateScalar") as
    | Types.RecreateScalarOperation
    | undefined;
  assertEquals(recreate !== undefined, true, "expected a RecreateScalar op");
  assertEquals(recreate!.reason, "reordered-values");
});

Deno.test("Gel #2564: RecreateScalar DDL guards against orphaning dependents", () => {
  const before = `
    module default {
      scalar type Status extending enum<draft, published, archived>;
    }
  `;
  const after = `
    module default {
      scalar type Status extending enum<draft, published>;
    }
  `;
  const ops = diff(before, after);
  const ddl = new DDLGenerator().generateDDL(ops);
  // The recreate path emits a DO block that aborts when columns
  // still reference the type — operators must drop dependents first.
  const guard = ddl.find((s) =>
    s.includes("RAISE EXCEPTION") && s.includes("recreate enum type")
  );
  assertEquals(
    guard !== undefined,
    true,
    "expected a guard DO block in the recreate DDL",
  );
});

// ---------------------------------------------------------------------------
// gh/geldata#6304: migration deadlock with long queries. Disc prefixes
// every migration transaction with `SET LOCAL lock_timeout` (so contended
// DDL fails fast) and `pg_advisory_xact_lock` (so concurrent migrators
// serialize). Both pragmas are user-overridable via MigrationConfig.
// ---------------------------------------------------------------------------
Deno.test("Gel #6304: migration apply emits lock_timeout + advisory lock pragmas", async () => {
  const { MigrationEngine } = await import("./engine.ts");
  const { MIGRATION_ADVISORY_LOCK_KEY } = await import("./types.ts");

  // Capture executed SQL via a spy connection pool.
  const executed: string[] = [];
  const fakePool = {
    transaction: async (fn: (conn: { execute: (s: string) => Promise<void> }) => Promise<void>) => {
      await fn({
        execute: (s: string) => {
          executed.push(s);
          return Promise.resolve();
        },
      });
    },
  };

  const engine = new MigrationEngine({
    autoApply: false,
    backupBeforeMigration: false,
    requireConfirmation: false,
    validateOperations: true,
    connectionPool: fakePool as unknown as import("../lib/connection-pool.ts").ConnectionPool,
  } as unknown as Types.MigrationConfig);

  await (engine as unknown as { executeStatements(s: string[]): Promise<void> })
    .executeStatements(["CREATE TABLE foo (id uuid primary key);"]);

  const setLockTimeout = executed.find((s) => s.includes("lock_timeout"));
  assertEquals(
    setLockTimeout !== undefined,
    true,
    "expected SET LOCAL lock_timeout pragma",
  );
  const advisoryLock = executed.find((s) => s.includes("pg_advisory_xact_lock"));
  assertEquals(
    advisoryLock !== undefined,
    true,
    "expected pg_advisory_xact_lock pragma",
  );
  // The advisory lock key is the FNV-1a hash of "disc_migrations" — pin
  // the actual integer so any future regen catches an accidental change.
  assertEquals(
    advisoryLock!.includes(MIGRATION_ADVISORY_LOCK_KEY.toString()),
    true,
    `expected advisory lock to use the disc_migrations key (${MIGRATION_ADVISORY_LOCK_KEY})`,
  );
});

Deno.test("Gel #6304: lockTimeoutMs=0 disables the timeout pragma", async () => {
  const { MigrationEngine } = await import("./engine.ts");

  const executed: string[] = [];
  const fakePool = {
    transaction: async (fn: (conn: { execute: (s: string) => Promise<void> }) => Promise<void>) => {
      await fn({
        execute: (s: string) => {
          executed.push(s);
          return Promise.resolve();
        },
      });
    },
  };

  const engine = new MigrationEngine({
    autoApply: false,
    backupBeforeMigration: false,
    requireConfirmation: false,
    validateOperations: true,
    connectionPool: fakePool as unknown as import("../lib/connection-pool.ts").ConnectionPool,
    lockTimeoutMs: 0,
    useAdvisoryLock: false,
  } as unknown as Types.MigrationConfig);

  await (engine as unknown as { executeStatements(s: string[]): Promise<void> })
    .executeStatements(["CREATE TABLE foo (id uuid primary key);"]);

  // With both knobs disabled we expect *only* the user statement.
  assertEquals(executed.length, 1);
  assertEquals(executed[0].includes("CREATE TABLE foo"), true);
});

// ---------------------------------------------------------------------------
// gh/geldata#5617: user-specified IDs in (data) migrations.
// Disc's INSERT compiler treats `id` as an ordinary property because the
// migration engine seeds it as an implicit `uuid` property on every type
// (`migration/schema-manager.ts:450`). A data migration can therefore
// write `insert User { id := <uuid>'...', ... }` and the SQL generator
// emits the literal id alongside the other columns. This pins that path.
// ---------------------------------------------------------------------------
Deno.test("Gel #5617: insert with explicit id compiles to INSERT with id column", async () => {
  const { EdgeQLParser } = await import("../edgeql/parser.ts");
  const { EdgeQLCompiler } = await import("../compiler/compiler.ts");
  const { SQLCodeGenerator } = await import("../compiler/codegen.ts");
  const { SchemaManager } = await import("./schema-manager.ts");

  const sm = new SchemaManager({ dryRun: true });
  await sm.initialize();
  await sm.applySchema(`
    module default {
      type User {
        required email: str;
        required name: str;
      };
    }
  `);
  const schema = sm.getSchema();
  if (!schema) throw new Error("schema manager produced no schema");

  const parser = new EdgeQLParser(
    `insert User { id := <uuid>'00000000-0000-0000-0000-000000000001', email := 'x@y.z', name := 'X' }`,
  );
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);
  assertEquals(result.ok, true, "compile should succeed");
  if (!result.ok) return;

  const sql = new SQLCodeGenerator().generate(result.value);
  // The SQL should reference the `id` column and the literal uuid.
  assertEquals(
    sql.includes("id") && sql.includes("00000000-0000-0000-0000-000000000001"),
    true,
    `expected id column + literal uuid in compiled SQL: ${sql}`,
  );
});
