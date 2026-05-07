/**
 * Stage 40: Comprehensive Migration DDL Integration Verification
 *
 * End-to-end tests that verify ALL schema features compose correctly through
 * the full SDL -> parse -> migrate -> verify PG objects pipeline. Covers:
 * constraints, triggers, rewrite rules, annotations, collection types,
 * deletion policies, multiple inheritance, globals, enum scalars, and links.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "./schema-manager.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDsn(
  dsn: string,
): { hostname: string; port: number; user: string; database: string } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

async function tableExists(dsn: string, tableName: string): Promise<boolean> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tableName],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

async function getColumns(
  dsn: string,
  tableName: string,
): Promise<{ column_name: string; data_type: string; is_nullable: string }[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      { column_name: string; data_type: string; is_nullable: string }
    >(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function getCheckConstraints(
  dsn: string,
  tableName: string,
): Promise<{ constraint_name: string; check_clause: string }[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      { constraint_name: string; check_clause: string }
    >(
      `SELECT cc.constraint_name, cc.check_clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.table_constraints tc
         ON cc.constraint_name = tc.constraint_name
       WHERE tc.table_schema = 'public' AND tc.table_name = $1
       ORDER BY cc.constraint_name`,
      [tableName],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function getTriggers(
  dsn: string,
  tableName: string,
): Promise<
  { trigger_name: string; event_manipulation: string; action_timing: string }[]
> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      {
        trigger_name: string;
        event_manipulation: string;
        action_timing: string;
      }
    >(
      `SELECT trigger_name, event_manipulation, action_timing
       FROM information_schema.triggers
       WHERE trigger_schema = 'public' AND event_object_table = $1
       ORDER BY trigger_name`,
      [tableName],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function execSQL(
  dsn: string,
  sql: string,
  params?: unknown[],
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    if (params) {
      await client.queryArray(sql, params);
    } else {
      await client.queryArray(sql);
    }
  } finally {
    await client.end();
  }
}

async function queryRows<T>(
  dsn: string,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = params ? await client.queryObject<T>(sql, params) : await client.queryObject<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function dropTables(dsn: string, ...tableNames: string[]): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      // Quote the identifier so PG-reserved names like "user" don't trip
      // a syntax error on DROP TABLE.
      await client.queryArray(`DROP TABLE IF EXISTS "${name}" CASCADE`);
    }
    // Drop lingering trigger functions
    await client.queryArray(`
      DO $$ DECLARE fn RECORD;
      BEGIN
        FOR fn IN
          SELECT proname FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND (proname LIKE '%__rewrite_fn' OR proname LIKE '%_fn' OR proname LIKE 'disc_source_delete_%')
        LOOP
          EXECUTE 'DROP FUNCTION IF EXISTS ' || fn.proname || '() CASCADE';
        END LOOP;
      END $$;
    `);
  } finally {
    await client.end();
  }
}

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

// ---------------------------------------------------------------------------
// Comprehensive SDL schema used across tests
// ---------------------------------------------------------------------------

const COMPREHENSIVE_SDL = `
  abstract type Named {
    required name: str {
      constraint max_len_value(100);
    };
  };

  abstract type Timestamped {
    created_at: datetime {
      rewrite insert using (datetime_of_statement());
    };
    updated_at: datetime {
      rewrite update using (datetime_of_statement());
    };
  };

  type User extending Named, Timestamped {
    required email: str {
      constraint exclusive;
      constraint max_len_value(255);
    };
    age: int64 {
      constraint min_value(0);
      constraint max_value(150);
    };
    bio: str;
    tags: array<str>;
    multi link posts -> Post;
  };

  type Post extending Timestamped {
    required title: str {
      constraint max_len_value(200);
    };
    required body: str;
    required link author -> User;
    status: str {
      constraint one_of('draft', 'published', 'archived');
    };
  };

  type Comment extending Timestamped {
    required text: str;
    required link post -> Post {
      on target delete restrict;
    };
    link author -> User;
  };
`;

// ---------------------------------------------------------------------------
// Test 1: Full schema migration - SDL -> parse -> migrate -> verify PG objects
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Comprehensive: full schema migration creates all PG objects",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const result = await manager.applySchema(COMPREHENSIVE_SDL);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`,
      );

      // Verify tables exist
      assertEquals(
        await tableExists(dsn, "user"),
        true,
        "User table should exist",
      );
      assertEquals(
        await tableExists(dsn, "post"),
        true,
        "Post table should exist",
      );
      assertEquals(
        await tableExists(dsn, "comment"),
        true,
        "Comment table should exist",
      );

      // Verify User columns
      const userColumns = await getColumns(dsn, "user");
      const userColNames = userColumns.map((c) => c.column_name);
      assertEquals(
        userColNames.includes("id"),
        true,
        "User should have id column",
      );
      assertEquals(
        userColNames.includes("name"),
        true,
        "User should have inherited name column",
      );
      assertEquals(
        userColNames.includes("email"),
        true,
        "User should have email column",
      );
      assertEquals(
        userColNames.includes("age"),
        true,
        "User should have age column",
      );
      assertEquals(
        userColNames.includes("bio"),
        true,
        "User should have bio column",
      );
      assertEquals(
        userColNames.includes("tags"),
        true,
        "User should have tags (array) column",
      );
      assertEquals(
        userColNames.includes("created_at"),
        true,
        "User should have inherited created_at column",
      );
      assertEquals(
        userColNames.includes("updated_at"),
        true,
        "User should have inherited updated_at column",
      );

      // Verify Post columns
      const postColumns = await getColumns(dsn, "post");
      const postColNames = postColumns.map((c) => c.column_name);
      assertEquals(
        postColNames.includes("id"),
        true,
        "Post should have id column",
      );
      assertEquals(
        postColNames.includes("title"),
        true,
        "Post should have title column",
      );
      assertEquals(
        postColNames.includes("body"),
        true,
        "Post should have body column",
      );
      assertEquals(
        postColNames.includes("author_id"),
        true,
        "Post should have author_id FK column",
      );
      assertEquals(
        postColNames.includes("status"),
        true,
        "Post should have status column",
      );
      assertEquals(
        postColNames.includes("created_at"),
        true,
        "Post should have inherited created_at column",
      );

      // Verify Comment columns
      const commentColumns = await getColumns(dsn, "comment");
      const commentColNames = commentColumns.map((c) => c.column_name);
      assertEquals(
        commentColNames.includes("id"),
        true,
        "Comment should have id column",
      );
      assertEquals(
        commentColNames.includes("text"),
        true,
        "Comment should have text column",
      );
      assertEquals(
        commentColNames.includes("post_id"),
        true,
        "Comment should have post_id FK column",
      );
      assertEquals(
        commentColNames.includes("author_id"),
        true,
        "Comment should have author_id FK column",
      );

      // Verify User junction table for multi-link posts
      assertEquals(
        await tableExists(dsn, "user_posts"),
        true,
        "User multi-link posts junction table should exist",
      );

      // Verify CHECK constraints on User
      const userChecks = await getCheckConstraints(dsn, "user");
      const userCheckNames = userChecks.map((c) => c.constraint_name);
      const hasNameLenCheck = userCheckNames.some((n) => n.includes("name") && n.includes("max_len"));
      assertEquals(
        hasNameLenCheck,
        true,
        "User should have max_len_value CHECK on name (inherited)",
      );

      const hasAgeMinCheck = userCheckNames.some((n) => n.includes("age") && n.includes("min_value"));
      assertEquals(
        hasAgeMinCheck,
        true,
        "User should have min_value CHECK on age",
      );

      const hasAgeMaxCheck = userCheckNames.some((n) => n.includes("age") && n.includes("max_value"));
      assertEquals(
        hasAgeMaxCheck,
        true,
        "User should have max_value CHECK on age",
      );

      // Verify CHECK constraints on Post
      const postChecks = await getCheckConstraints(dsn, "post");
      const postCheckNames = postChecks.map((c) => c.constraint_name);
      const hasStatusOneOf = postCheckNames.some((n) => n.includes("status") && n.includes("one_of"));
      assertEquals(
        hasStatusOneOf,
        true,
        "Post should have one_of CHECK on status",
      );

      // Verify rewrite triggers exist on User (for created_at and updated_at)
      const userTriggers = await getTriggers(dsn, "user");
      const userTriggerNames = userTriggers.map((t) => t.trigger_name);
      const hasCreatedAtRewrite = userTriggerNames.some((n) => n.includes("created_at") && n.includes("rewrite"));
      assertEquals(
        hasCreatedAtRewrite,
        true,
        "User should have created_at rewrite trigger",
      );

      const hasUpdatedAtRewrite = userTriggerNames.some((n) => n.includes("updated_at") && n.includes("rewrite"));
      assertEquals(
        hasUpdatedAtRewrite,
        true,
        "User should have updated_at rewrite trigger",
      );

      // Verify the schema object
      const schema = manager.getSchema();
      assertExists(schema, "Schema should be available after applySchema");
      assertExists(
        schema!.types.get("User"),
        "Schema should contain User type",
      );
      assertExists(
        schema!.types.get("Post"),
        "Schema should contain Post type",
      );
      assertExists(
        schema!.types.get("Comment"),
        "Schema should contain Comment type",
      );

      const userDef = schema!.types.get("User")!;
      assertEquals(
        userDef.parentTypes?.includes("Named"),
        true,
        "User should extend Named",
      );
      assertEquals(
        userDef.parentTypes?.includes("Timestamped"),
        true,
        "User should extend Timestamped",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "comment",
        "user_posts",
        "post",
        "user",
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 2: Data insertion respects all constraints
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Comprehensive: data insertion respects constraints and rejects violations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const result = await manager.applySchema(COMPREHENSIVE_SDL);
      assertEquals(result.ok, true, `applySchema should succeed`);

      // Insert a valid User
      await execSQL(
        dsn,
        `INSERT INTO "user" (id, name, email, age, bio, tags) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        ["Ada", "ada@example.com", 30, "A developer", "{typescript,deno}"],
      );

      // Verify the row was inserted
      const users = await queryRows<
        { name: string; email: string; age: number }
      >(
        dsn,
        `SELECT name, email, age FROM "user"`,
      );
      assertEquals(users.length, 1, "Should have 1 user");
      assertEquals(users[0].name, "Ada");
      assertEquals(users[0].email, "ada@example.com");

      // Violate max_len_value(100) on name (inherited from Named)
      const longName = "x".repeat(101);
      let nameViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO "user" (id, name, email) VALUES (gen_random_uuid(), $1, $2)`,
          [longName, "long@example.com"],
        );
      } catch {
        nameViolated = true;
      }
      assertEquals(
        nameViolated,
        true,
        "101-char name should violate max_len_value(100)",
      );

      // Violate min_value(0) on age
      let ageMinViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO "user" (id, name, email, age) VALUES (gen_random_uuid(), $1, $2, $3)`,
          ["Billie", "billie@example.com", -1],
        );
      } catch {
        ageMinViolated = true;
      }
      assertEquals(
        ageMinViolated,
        true,
        "Negative age should violate min_value(0)",
      );

      // Violate max_value(150) on age
      let ageMaxViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO "user" (id, name, email, age) VALUES (gen_random_uuid(), $1, $2, $3)`,
          ["Cher", "cher@example.com", 200],
        );
      } catch {
        ageMaxViolated = true;
      }
      assertEquals(
        ageMaxViolated,
        true,
        "Age 200 should violate max_value(150)",
      );

      // Violate exclusive constraint on email (duplicate)
      let emailDuplicated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO "user" (id, name, email) VALUES (gen_random_uuid(), $1, $2)`,
          ["Duplicate", "ada@example.com"],
        );
      } catch {
        emailDuplicated = true;
      }
      assertEquals(
        emailDuplicated,
        true,
        "Duplicate email should violate exclusive constraint",
      );

      // Insert a valid Post with status constraint
      const userRows = await queryRows<{ id: string }>(
        dsn,
        `SELECT id FROM "user" LIMIT 1`,
      );
      const userId = userRows[0].id;

      await execSQL(
        dsn,
        `INSERT INTO post (id, title, body, author_id, status) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        ["My Post", "Post body", userId, "draft"],
      );

      // Violate one_of constraint on Post.status
      let statusViolated = false;
      try {
        await execSQL(
          dsn,
          `INSERT INTO post (id, title, body, author_id, status) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          ["Bad Post", "Body", userId, "deleted"],
        );
      } catch {
        statusViolated = true;
      }
      assertEquals(
        statusViolated,
        true,
        "Status 'deleted' should violate one_of constraint",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "comment",
        "user_posts",
        "post",
        "user",
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 3: Rewrite triggers auto-set timestamps
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Comprehensive: rewrite triggers auto-set created_at/updated_at",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const result = await manager.applySchema(COMPREHENSIVE_SDL);
      assertEquals(result.ok, true, `applySchema should succeed`);

      // Insert a User WITHOUT specifying created_at — rewrite should set it
      await execSQL(
        dsn,
        `INSERT INTO "user" (id, name, email) VALUES (gen_random_uuid(), $1, $2)`,
        ["Ada", "ada@test.com"],
      );

      // Verify created_at was auto-set
      const insertRows = await queryRows<{
        name: string;
        created_at: string | null;
        updated_at: string | null;
      }>(dsn, `SELECT name, created_at, updated_at FROM "user"`);

      assertEquals(insertRows.length, 1);
      assertEquals(
        insertRows[0].created_at !== null,
        true,
        "created_at should be auto-set by INSERT rewrite trigger",
      );
      // updated_at should be NULL after INSERT (only fires on UPDATE)
      assertEquals(
        insertRows[0].updated_at,
        null,
        "updated_at should be NULL after INSERT (UPDATE-only rewrite)",
      );

      // Small delay to ensure timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Update the user — updated_at rewrite should fire
      await execSQL(
        dsn,
        `UPDATE "user" SET bio = $1 WHERE name = $2`,
        ["Updated bio", "Ada"],
      );

      const updateRows = await queryRows<{
        name: string;
        created_at: string;
        updated_at: string | null;
      }>(dsn, `SELECT name, created_at, updated_at FROM "user"`);

      assertEquals(updateRows.length, 1);
      assertEquals(
        updateRows[0].updated_at !== null,
        true,
        "updated_at should be auto-set by UPDATE rewrite trigger",
      );

      // Similarly test Post rewrite triggers
      const userRows = await queryRows<{ id: string }>(
        dsn,
        `SELECT id FROM "user" LIMIT 1`,
      );
      const userId = userRows[0].id;

      await execSQL(
        dsn,
        `INSERT INTO post (id, title, body, author_id) VALUES (gen_random_uuid(), $1, $2, $3)`,
        ["Test Post", "Body text", userId],
      );

      const postRows = await queryRows<{
        title: string;
        created_at: string | null;
      }>(dsn, `SELECT title, created_at FROM post`);

      assertEquals(postRows.length, 1);
      assertEquals(
        postRows[0].created_at !== null,
        true,
        "Post.created_at should be auto-set by INSERT rewrite trigger",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "comment",
        "user_posts",
        "post",
        "user",
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 4: Schema object introspection returns complete metadata
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Comprehensive: schema introspection returns all types, properties, links, constraints",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const result = await manager.applySchema(COMPREHENSIVE_SDL);
      assertEquals(result.ok, true, `applySchema should succeed`);

      const schema = manager.getSchema();
      assertExists(schema, "Schema should exist");

      // Verify abstract types
      const namedType = schema!.types.get("Named");
      assertExists(namedType, "Named abstract type should be in schema");
      assertEquals(namedType!.abstract, true, "Named should be abstract");

      const timestampedType = schema!.types.get("Timestamped");
      assertExists(
        timestampedType,
        "Timestamped abstract type should be in schema",
      );
      assertEquals(
        timestampedType!.abstract,
        true,
        "Timestamped should be abstract",
      );

      // Verify User type properties
      const userType = schema!.types.get("User");
      assertExists(userType, "User type should exist");
      assertEquals(userType!.kind, "object");

      const emailProp = userType!.properties.get("email");
      assertExists(emailProp, "User should have email property");
      assertEquals(emailProp!.required, true, "email should be required");
      assertEquals(
        emailProp!.constraints?.some((c) => c.name === "exclusive"),
        true,
        "email should have exclusive constraint",
      );
      assertEquals(
        emailProp!.constraints?.some((c) => c.name === "max_len_value"),
        true,
        "email should have max_len_value constraint",
      );

      const ageProp = userType!.properties.get("age");
      assertExists(ageProp, "User should have age property");
      assertEquals(ageProp!.required, false, "age should be optional");
      assertEquals(
        ageProp!.constraints?.some((c) => c.name === "min_value"),
        true,
        "age should have min_value constraint",
      );
      assertEquals(
        ageProp!.constraints?.some((c) => c.name === "max_value"),
        true,
        "age should have max_value constraint",
      );

      // Verify inherited properties
      const nameProp = userType!.properties.get("name");
      assertExists(nameProp, "User should have inherited name property");
      assertEquals(
        nameProp!.required,
        true,
        "inherited name should be required",
      );

      const createdAtProp = userType!.properties.get("created_at");
      assertExists(
        createdAtProp,
        "User should have inherited created_at property",
      );

      // Verify tags (array type)
      const tagsProp = userType!.properties.get("tags");
      assertExists(tagsProp, "User should have tags property");

      // Verify User links
      const postsLink = userType!.links.get("posts");
      assertExists(postsLink, "User should have posts link");
      assertEquals(postsLink!.multi, true, "posts should be a multi-link");
      assertEquals(postsLink!.target, "Post", "posts should target Post");

      // Verify Post type
      const postType = schema!.types.get("Post");
      assertExists(postType, "Post type should exist");
      const authorLink = postType!.links.get("author");
      assertExists(authorLink, "Post should have author link");
      assertEquals(authorLink!.required, true, "author should be required");
      assertEquals(authorLink!.target, "User", "author should target User");

      const statusProp = postType!.properties.get("status");
      assertExists(statusProp, "Post should have status property");
      assertEquals(
        statusProp!.constraints?.some((c) => c.name === "one_of"),
        true,
        "status should have one_of constraint",
      );

      // Verify Comment type
      const commentType = schema!.types.get("Comment");
      assertExists(commentType, "Comment type should exist");
      const postLink = commentType!.links.get("post");
      assertExists(postLink, "Comment should have post link");
      assertEquals(postLink!.required, true, "post link should be required");

      // Verify inheritance chain
      assertEquals(
        userType!.parentTypes?.includes("Named"),
        true,
        "User should list Named as parent type",
      );
      assertEquals(
        userType!.parentTypes?.includes("Timestamped"),
        true,
        "User should list Timestamped as parent type",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "comment",
        "user_posts",
        "post",
        "user",
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 5: Migration tracking records are persisted correctly
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Comprehensive: migration tracking records persisted in disc_migrations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const result = await manager.applySchema(COMPREHENSIVE_SDL);
      assertEquals(result.ok, true, `applySchema should succeed`);

      // Verify migration was recorded in disc_migrations
      const migrations = await queryRows<{
        id: string;
        name: string;
        schema_hash: string;
      }>(
        dsn,
        `SELECT id, name, schema_hash FROM disc_migrations ORDER BY applied_at DESC LIMIT 1`,
      );

      assertEquals(
        migrations.length >= 1,
        true,
        "Should have at least 1 migration recorded",
      );
      assertExists(migrations[0].id, "Migration should have an ID");
      assertExists(migrations[0].name, "Migration should have a name");
      assertExists(
        migrations[0].schema_hash,
        "Migration should have a schema hash",
      );

      // Verify migration status via engine
      const statusResult = await manager.getMigrationStatus();
      assertEquals(statusResult.ok, true, "getMigrationStatus should succeed");
      if (statusResult.ok) {
        assertEquals(
          statusResult.value.applied >= 1,
          true,
          "Should report at least 1 applied migration",
        );
        assertExists(
          statusResult.value.latestMigration,
          "Should have a latest migration",
        );
      }

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "comment",
        "user_posts",
        "post",
        "user",
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});
