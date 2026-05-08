/**
 * Access Policy End-to-End PostgreSQL Tests
 *
 * Proves that access policy WHERE clauses work against real PostgreSQL.
 * The pipeline under test:
 *   SDL -> SchemaManager -> AccessPolicy -> EdgeQLCompiler (with RLS) -> SQL -> PG
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import type { AccessExpressionNode } from "../access/ast.ts";
import type { AccessConfig, AccessContext, AccessPolicy } from "../access/mod.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import type { Schema } from "../compiler/context.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

/** Standard migration cleanup tables to drop alongside test tables. */
const MIGRATION_TABLES = [
  "disc_migrations",
  "disc_migration_checkpoints"
];

/** Apply SDL via SchemaManager and return the schema. Caller handles cleanup. */
async function applyTestSchema(
  pool: ConnectionPool,
  sdl: string
): Promise<{ manager: SchemaManager; schema: Schema; }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(sdl);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

/**
 * Compile an EdgeQL query to SQL using the full access-control-aware pipeline.
 *
 * Steps:
 *   1. Create compiler with access control enabled
 *   2. Register the policies for the given type
 *   3. Set the access context
 *   4. Parse and compile the EdgeQL query
 *   5. Return the generated SQL string (or null if compilation denied)
 */
function compileWithAccess(
  edgeql: string,
  schema: Schema,
  policies: AccessPolicy[],
  accessConfig: AccessConfig,
  accessContext: AccessContext
): { ok: true; sql: string; } | { ok: false; error: string; } {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  const compiler = new EdgeQLCompiler(schema, {
    enableAccessControl: true,
    accessConfig,
    accessContext
  });

  // Register each policy with the compiler's internal evaluator
  for (const policy of policies) {
    compiler.registerAccessPolicy(policy);
  }

  const result = compiler.compile(ast);

  if (!result.ok) {
    return { ok: false, error: result.error.message };
  }

  const codegen = new SQLCodeGenerator();
  const sql = codegen.generate(result.value);
  return { ok: true, sql };
}

/**
 * Build an AccessPolicy manually for testing.
 *
 * The `condition` field is intentionally left undefined so the policy always
 * fires for matching operations. The `using` expression generates the SQL
 * WHERE clause for row-level security.
 *
 * This avoids the dual-assignment issue in adaptAccessPolicies where both
 * `condition` and `using` are set to the same expression, causing in-memory
 * evaluation to fail on column-referencing expressions like `.id`.
 */
function buildPolicy(
  name: string,
  objectType: string,
  allow: boolean,
  operations: ("select" | "insert" | "update" | "delete" | "all")[],
  using?: AccessExpressionNode
): AccessPolicy {
  return {
    name,
    objectType,
    actions: [{ allow, operations }],
    using
  };
}

/** Standard access config for most tests: permissive mode, RLS on, deny by default. */
const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  mode: "permissive",
  defaultAllow: false,
  enableRLS: true,
  enableAudit: false
};

/** Drop a list of tables, ignoring errors. */
async function dropTables(
  pool: ConnectionPool,
  tables: string[]
): Promise<void> {
  for (const table of tables) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}

// =========================================================================
// Stage 1: Basic RLS (Tests 1-5)
// =========================================================================

Deno.test({
  name: "Access PG: allow SELECT with owner filter returns only owned row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "access_user";
    const SDL = `
      type AccessUser {
        required name: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      // Insert 3 users with known UUIDs
      const uuid1 = "11111111-1111-1111-1111-111111111111";
      const uuid2 = "22222222-2222-2222-2222-222222222222";
      const uuid3 = "33333333-3333-3333-3333-333333333333";

      await pool.query(
        `INSERT INTO ${TABLE} (id, name) VALUES
          ('${uuid1}', 'Ada'),
          ('${uuid2}', 'Billie'),
          ('${uuid3}', 'Cher')`
      );

      // Build policy: allow select using (.id = global current_user)
      const policy = buildPolicy("owner_only", "AccessUser", true, ["select"], {
        kind: "AccessComparison",
        operator: "=",
        left: { kind: "AccessPath", path: ["id"] },
        right: { kind: "AccessGlobal", name: "current_user" }
      });

      // Compile with userId = uuid1 (Ada)
      const compiled = compileWithAccess(
        "select AccessUser { name }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid1 }
      );

      assertEquals(compiled.ok, true, "Compilation should succeed");
      if (!compiled.ok)
        return;

      // The SQL should contain a WHERE clause filtering by the user's id
      const result = await pool.query(compiled.sql);

      assertEquals(result.rowCount, 1, "Should return exactly 1 row (Ada)");

      const row = result.rows[0];
      const data = row.jsonb_build_object ?? row;
      const name = data.name ?? Object.values(data)[0];
      assertEquals(name, "Ada", "Returned row should be Ada");

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: no auth context with defaultAllow=false returns 0 rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "no_auth_user";
    const SDL = `
      type NoAuthUser {
        required name: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      // Insert data
      await pool.query(
        `INSERT INTO ${TABLE} (id, name) VALUES
          (gen_random_uuid(), 'Ada'),
          (gen_random_uuid(), 'Billie')`
      );

      // Build policy: allow select using (.id = global current_user)
      // With no userId, the evaluator's expressionToSQL produces NULL for
      // current_user, but more importantly, when the policy's condition check
      // is skipped (condition = undefined), the evaluator still generates
      // the SQL. However, we want to test the "no allow fires -> denied" path.
      //
      // Use a condition that checks if current_user is set:
      const policy = buildPolicy(
        "owner_only",
        "NoAuthUser",
        true,
        ["select"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["id"] },
          right: { kind: "AccessGlobal", name: "current_user" }
        }
      );

      // Set condition so the policy only fires when userId is truthy.
      // When userId is empty, the global evaluates to false in-memory,
      // so the condition fails and the allow is skipped.
      policy.condition = { kind: "AccessGlobal", name: "current_user" };

      // Compile with empty access context (no userId)
      const compiled = compileWithAccess(
        "select NoAuthUser { name }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        {} // empty context
      );

      assertEquals(
        compiled.ok,
        true,
        "Compilation should succeed (WHERE FALSE injected)"
      );
      if (!compiled.ok)
        return;

      // The compiler should inject WHERE FALSE since no allow policy fires
      const result = await pool.query(compiled.sql);
      assertEquals(
        result.rowCount,
        0,
        "Should return 0 rows when no auth context"
      );

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: deny INSERT at compile time",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "restricted_user";
    const SDL = `
      type RestrictedUser {
        required name: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      // Build policy: deny insert (unconditional)
      const policy = buildPolicy(
        "no_insert",
        "RestrictedUser",
        false, // deny
        ["insert"]
      );

      // Compile INSERT — should fail at compilation
      const compiled = compileWithAccess(
        "insert RestrictedUser { name := \"Hacker\" }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: "some-user" }
      );

      assertEquals(compiled.ok, false, "INSERT compilation should be denied");
      if (!compiled.ok) {
        assertEquals(
          compiled.error.includes("not allowed"),
          true,
          `Error should mention 'not allowed', got: ${compiled.error}`
        );
      }

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: allow UPDATE with owner condition updates only owned row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "updatable_user";
    const SDL = `
      type UpdatableUser {
        required name: str;
        required status: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      const uuid1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const uuid2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

      await pool.query(
        `INSERT INTO ${TABLE} (id, name, status) VALUES
          ('${uuid1}', 'Ada', 'active'),
          ('${uuid2}', 'Billie', 'active')`
      );

      // Build policy: allow update using (.id = global current_user)
      const policy = buildPolicy(
        "owner_update",
        "UpdatableUser",
        true,
        ["update"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["id"] },
          right: { kind: "AccessGlobal", name: "current_user" }
        }
      );

      // Compile UPDATE with userId = uuid1 (Ada)
      const compiled = compileWithAccess(
        "update UpdatableUser set { status := \"inactive\" }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid1 }
      );

      assertEquals(compiled.ok, true, "UPDATE compilation should succeed");
      if (!compiled.ok)
        return;

      // Execute the update
      await pool.query(compiled.sql);

      // Verify: Ada should be 'inactive', Billie should remain 'active'
      const adaResult = await pool.query(
        `SELECT status FROM ${TABLE} WHERE id = '${uuid1}'`
      );
      assertEquals(
        adaResult.rows[0].status,
        "inactive",
        "Ada should be inactive"
      );

      const billieResult = await pool.query(
        `SELECT status FROM ${TABLE} WHERE id = '${uuid2}'`
      );
      assertEquals(
        billieResult.rows[0].status,
        "active",
        "Billie should remain active"
      );

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: allow DELETE with owner condition deletes only owned row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "deletable_user";
    const SDL = `
      type DeletableUser {
        required name: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      const uuid1 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const uuid2 = "dddddddd-dddd-dddd-dddd-dddddddddddd";

      await pool.query(
        `INSERT INTO ${TABLE} (id, name) VALUES
          ('${uuid1}', 'Ada'),
          ('${uuid2}', 'Billie')`
      );

      // Build policy: allow delete using (.id = global current_user)
      const policy = buildPolicy(
        "owner_delete",
        "DeletableUser",
        true,
        ["delete"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["id"] },
          right: { kind: "AccessGlobal", name: "current_user" }
        }
      );

      // Compile DELETE with userId = uuid1 (Ada)
      const compiled = compileWithAccess(
        "delete DeletableUser",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid1 }
      );

      assertEquals(compiled.ok, true, "DELETE compilation should succeed");
      if (!compiled.ok)
        return;

      // Execute the delete
      await pool.query(compiled.sql);

      // Verify: Ada should be gone, Billie should remain
      const remaining = await pool.query(
        `SELECT name FROM ${TABLE} ORDER BY name`
      );
      assertEquals(
        remaining.rowCount,
        1,
        "Should have exactly 1 row remaining"
      );
      assertEquals(remaining.rows[0].name, "Billie", "Billie should remain");

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

// =========================================================================
// Stage 2: Complex Policy Expressions (Tests 6-10)
// =========================================================================

Deno.test({
  name: "Access PG: nested AND condition filters correctly",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "and_user";
    const SDL = `
      type AndUser {
        required name: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      const uuid1 = "11110000-1111-1111-1111-111111111111";
      const uuid2 = "22220000-2222-2222-2222-222222222222";
      const uuid3 = "33330000-3333-3333-3333-333333333333";

      await pool.query(
        `INSERT INTO ${TABLE} (id, name) VALUES
          ('${uuid1}', 'Ada'),
          ('${uuid2}', ''),
          ('${uuid3}', 'Cher')`
      );

      // Build policy: allow select using (.id = global current_user AND .name != '')
      const policy = buildPolicy(
        "owner_and_named",
        "AndUser",
        true,
        ["select"],
        {
          kind: "AccessLogical",
          operator: "and",
          operands: [
            {
              kind: "AccessComparison",
              operator: "=",
              left: { kind: "AccessPath", path: ["id"] },
              right: { kind: "AccessGlobal", name: "current_user" }
            },
            {
              kind: "AccessComparison",
              operator: "!=",
              left: { kind: "AccessPath", path: ["name"] },
              right: { kind: "AccessLiteral", type: "string", value: "" }
            }
          ]
        }
      );

      // Query as Ada (uuid1, name='Ada' != '') -> should pass both conditions
      const compiledAda = compileWithAccess(
        "select AndUser { name }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid1 }
      );

      assertEquals(
        compiledAda.ok,
        true,
        "Compilation for Ada should succeed"
      );
      if (!compiledAda.ok)
        return;

      const adaResult = await pool.query(compiledAda.sql);
      assertEquals(adaResult.rowCount, 1, "Ada should see exactly 1 row");

      // Query as uuid2 (name='') -> id matches but name='' fails the AND
      const compiledEmpty = compileWithAccess(
        "select AndUser { name }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid2 }
      );

      assertEquals(
        compiledEmpty.ok,
        true,
        "Compilation for empty-name user should succeed"
      );
      if (!compiledEmpty.ok)
        return;

      const emptyResult = await pool.query(compiledEmpty.sql);
      assertEquals(
        emptyResult.rowCount,
        0,
        "User with empty name should see 0 rows (AND condition fails)"
      );

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: OR condition returns rows matching either branch",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "or_user";
    const SDL = `
      type OrUser {
        required name: str;
        required role: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      const uuid1 = "aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const uuid2 = "bbbb0000-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const uuid3 = "cccc0000-cccc-cccc-cccc-cccccccccccc";

      await pool.query(
        `INSERT INTO ${TABLE} (id, name, role) VALUES
          ('${uuid1}', 'Ada', 'admin'),
          ('${uuid2}', 'Billie', 'user'),
          ('${uuid3}', 'Cher', 'admin')`
      );

      // Build policy: allow select using (.role = global current_role OR .id = global current_user)
      const policy = buildPolicy(
        "role_or_owner",
        "OrUser",
        true,
        ["select"],
        {
          kind: "AccessLogical",
          operator: "or",
          operands: [
            {
              kind: "AccessComparison",
              operator: "=",
              left: { kind: "AccessPath", path: ["role"] },
              right: { kind: "AccessGlobal", name: "current_role" }
            },
            {
              kind: "AccessComparison",
              operator: "=",
              left: { kind: "AccessPath", path: ["id"] },
              right: { kind: "AccessGlobal", name: "current_user" }
            }
          ]
        }
      );

      // Query as Billie (uuid2) with role='user'
      // Billie should see: himself (id match) + nobody else with role='user'
      // Actually: .role = 'user' matches Billie, .id = uuid2 also matches Billie.
      // Neither condition matches Ada or Cher.
      const compiledBillie = compileWithAccess(
        "select OrUser { name }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid2, userRole: "user" }
      );

      assertEquals(compiledBillie.ok, true, "Compilation for Billie should succeed");
      if (!compiledBillie.ok)
        return;

      const billieResult = await pool.query(compiledBillie.sql);
      assertEquals(
        billieResult.rowCount,
        1,
        "Billie should see exactly 1 row (himself)"
      );

      // Query as Billie (uuid2) with role='admin'
      // Billie should see: Ada (admin), Cher (admin), and himself (id match)
      const compiledAdmin = compileWithAccess(
        "select OrUser { name }",
        schema,
        [policy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid2, userRole: "admin" }
      );

      assertEquals(
        compiledAdmin.ok,
        true,
        "Compilation for admin role should succeed"
      );
      if (!compiledAdmin.ok)
        return;

      const adminResult = await pool.query(compiledAdmin.sql);
      assertEquals(
        adminResult.rowCount,
        3,
        "Admin role + Billie's id should see all 3 rows"
      );

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: multiple permissive allow policies combine with OR",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "multi_policy_user";
    const SDL = `
      type MultiPolicyUser {
        required name: str;
        required role: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      const uuid1 = "11112222-1111-1111-1111-111111111111";
      const uuid2 = "22223333-2222-2222-2222-222222222222";
      const uuid3 = "33334444-3333-3333-3333-333333333333";

      await pool.query(
        `INSERT INTO ${TABLE} (id, name, role) VALUES
          ('${uuid1}', 'Ada', 'admin'),
          ('${uuid2}', 'Billie', 'editor'),
          ('${uuid3}', 'Cher', 'viewer')`
      );

      // Policy 1: allow select using (.id = global current_user)
      const ownerPolicy = buildPolicy(
        "owner_select",
        "MultiPolicyUser",
        true,
        ["select"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["id"] },
          right: { kind: "AccessGlobal", name: "current_user" }
        }
      );

      // Policy 2: allow select using (.role = global current_role)
      const rolePolicy = buildPolicy(
        "role_select",
        "MultiPolicyUser",
        true,
        ["select"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["role"] },
          right: { kind: "AccessGlobal", name: "current_role" }
        }
      );

      // Query as Cher (uuid3) with role='admin'
      // owner_select: .id = uuid3 -> matches Cher
      // role_select: .role = 'admin' -> matches Ada
      // Permissive OR: should see both Ada and Cher
      const compiled = compileWithAccess(
        "select MultiPolicyUser { name }",
        schema,
        [ownerPolicy, rolePolicy],
        DEFAULT_ACCESS_CONFIG,
        { userId: uuid3, userRole: "admin" }
      );

      assertEquals(compiled.ok, true, "Compilation should succeed");
      if (!compiled.ok)
        return;

      const result = await pool.query(compiled.sql);
      assertEquals(
        result.rowCount,
        2,
        "Should return 2 rows (Ada via role, Cher via ownership)"
      );

      // Extract names and verify
      const names = result
        .rows
        .map((r: Record<string, unknown>) => {
          const data = (r as Record<string, Record<string, unknown>>).jsonb_build_object ??
            r;
          return data.name;
        })
        .sort();
      assertEquals(names, ["Ada", "Cher"], "Should see Ada and Cher");

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: deny overrides allow, returns 0 rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE = "deny_override_user";
    const SDL = `
      type DenyOverrideUser {
        required name: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      await pool.query(
        `INSERT INTO ${TABLE} (id, name) VALUES
          (gen_random_uuid(), 'Ada'),
          (gen_random_uuid(), 'Billie')`
      );

      // Policy 1: allow select (unconditional, no using expression)
      const allowPolicy = buildPolicy(
        "allow_all_select",
        "DenyOverrideUser",
        true,
        ["select"]
      );

      // Policy 2: deny select (unconditional)
      // In permissive mode: hasDeny=true overrides hasAllow -> allowed=false -> WHERE FALSE
      const denyPolicy = buildPolicy(
        "deny_select",
        "DenyOverrideUser",
        false, // deny
        ["select"]
      );

      const compiled = compileWithAccess(
        "select DenyOverrideUser { name }",
        schema,
        [allowPolicy, denyPolicy],
        DEFAULT_ACCESS_CONFIG,
        { userId: "some-user" }
      );

      assertEquals(
        compiled.ok,
        true,
        "Compilation should succeed (WHERE FALSE injected)"
      );
      if (!compiled.ok)
        return;

      // The evaluator sees hasDeny=true -> allowed=false -> compiler injects WHERE FALSE
      const result = await pool.query(compiled.sql);
      assertEquals(
        result.rowCount,
        0,
        "Deny should override allow, returning 0 rows"
      );

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "Access PG: policies on multiple types filter independently",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const TABLE_A = "team_member";
    const TABLE_B = "team_doc";
    const SDL = `
      type TeamMember {
        required name: str;
        required team: str;
      }

      type TeamDoc {
        required title: str;
        required team: str;
      }
    `;

    try {
      const { manager, schema } = await applyTestSchema(pool, SDL);

      const uuid1 = "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const uuid2 = "bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

      await pool.query(
        `INSERT INTO ${TABLE_A} (id, name, team) VALUES
          ('${uuid1}', 'Ada', 'engineering'),
          ('${uuid2}', 'Billie', 'marketing')`
      );

      await pool.query(
        `INSERT INTO ${TABLE_B} (id, title, team) VALUES
          (gen_random_uuid(), 'Design Doc', 'engineering'),
          (gen_random_uuid(), 'Campaign Plan', 'marketing'),
          (gen_random_uuid(), 'Architecture RFC', 'engineering')`
      );

      // TeamMember policy: allow select using (.id = global current_user)
      const memberPolicy = buildPolicy(
        "member_owner",
        "TeamMember",
        true,
        ["select"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["id"] },
          right: { kind: "AccessGlobal", name: "current_user" }
        }
      );

      // TeamDoc policy: allow select using (.team = global current_role)
      // Here we repurpose current_role to hold the team name
      const docPolicy = buildPolicy(
        "team_docs",
        "TeamDoc",
        true,
        ["select"],
        {
          kind: "AccessComparison",
          operator: "=",
          left: { kind: "AccessPath", path: ["team"] },
          right: { kind: "AccessGlobal", name: "current_role" }
        }
      );

      const context: AccessContext = {
        userId: uuid1, // Ada
        userRole: "engineering" // Ada's team
      };

      // Query TeamMember — should return only Ada (owner filter)
      const compiledMembers = compileWithAccess(
        "select TeamMember { name }",
        schema,
        [memberPolicy, docPolicy],
        DEFAULT_ACCESS_CONFIG,
        context
      );

      assertEquals(
        compiledMembers.ok,
        true,
        "TeamMember compilation should succeed"
      );
      if (!compiledMembers.ok)
        return;

      const memberResult = await pool.query(compiledMembers.sql);
      assertEquals(
        memberResult.rowCount,
        1,
        "Should see only 1 TeamMember (Ada)"
      );

      // Query TeamDoc — should return 2 engineering docs
      const compiledDocs = compileWithAccess(
        "select TeamDoc { title }",
        schema,
        [memberPolicy, docPolicy],
        DEFAULT_ACCESS_CONFIG,
        context
      );

      assertEquals(compiledDocs.ok, true, "TeamDoc compilation should succeed");
      if (!compiledDocs.ok)
        return;

      const docResult = await pool.query(compiledDocs.sql);
      assertEquals(
        docResult.rowCount,
        2,
        "Should see 2 TeamDocs (engineering team)"
      );

      // Extract titles and verify
      const titles = docResult
        .rows
        .map((r: Record<string, unknown>) => {
          const data = (r as Record<string, Record<string, unknown>>).jsonb_build_object ??
            r;
          return data.title;
        })
        .sort();
      assertEquals(
        titles,
        ["Architecture RFC", "Design Doc"],
        "Should see the two engineering docs"
      );

      await manager.close();
    } finally {
      await dropTables(pool, [TABLE_A, TABLE_B, ...MIGRATION_TABLES]);
      await pool.close();
    }
  }
});
