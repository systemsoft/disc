/**
 * Live PG introspection queries (#3452 — Phase 4)
 *
 * Integration tests that connect to a real Postgres, set up a sample
 * schema, and verify that `introspectDatabase()` produces accurate
 * `IntrospectionData`. These run only when the PG test harness is
 * available (DISC_PG_AUTO=1 or DISC_PG_TEST_URL set).
 */

import { assert, assertEquals } from "@std/assert";
import { DatabaseConnection } from "../lib/database.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { introspectDatabase } from "./pg-introspect-queries.ts";

const SETUP_SQL = `
DROP TABLE IF EXISTS introspect_posts_tags CASCADE;
DROP TABLE IF EXISTS introspect_posts CASCADE;
DROP TABLE IF EXISTS introspect_tags CASCADE;
DROP TABLE IF EXISTS introspect_users CASCADE;

CREATE TABLE introspect_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  nickname text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE introspect_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE introspect_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  author_id uuid NOT NULL REFERENCES introspect_users(id),
  editor_id uuid REFERENCES introspect_users(id)
);

CREATE TABLE introspect_posts_tags (
  post_id uuid NOT NULL REFERENCES introspect_posts(id),
  tag_id uuid NOT NULL REFERENCES introspect_tags(id),
  PRIMARY KEY (post_id, tag_id)
);
`;

const TEARDOWN_SQL = `
DROP TABLE IF EXISTS introspect_posts_tags CASCADE;
DROP TABLE IF EXISTS introspect_posts CASCADE;
DROP TABLE IF EXISTS introspect_tags CASCADE;
DROP TABLE IF EXISTS introspect_users CASCADE;
`;

async function withSampleSchema<T>(
  fn: (db: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const dsn = await getTestDsn();
  const db = new DatabaseConnection(dsn);
  await db.connect();
  try {
    await db.execute(SETUP_SQL);
    return await fn(db);
  } finally {
    try {
      await db.execute(TEARDOWN_SQL);
    } finally {
      await db.close();
    }
  }
}

Deno.test({
  name: "introspectDatabase - finds the sample tables",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSampleSchema(async (db) => {
      const data = await introspectDatabase(db, {
        tableFilter: (t) => t.startsWith("introspect_"),
      });
      const names = new Set(data.tables.map((t) => t.tableName));
      assert(names.has("introspect_users"));
      assert(names.has("introspect_posts"));
      assert(names.has("introspect_tags"));
      assert(names.has("introspect_posts_tags"));
    });
  },
});

Deno.test({
  name: "introspectDatabase - column metadata: types, nullability, defaults",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSampleSchema(async (db) => {
      const data = await introspectDatabase(db, {
        tableFilter: (t) => t.startsWith("introspect_"),
      });
      const users = data.tables.find((t) => t.tableName === "introspect_users")!;
      const cols = new Map(users.columns.map((c) => [c.name, c]));

      assertEquals(cols.get("id")!.pgType, "uuid");
      assertEquals(cols.get("id")!.nullable, false);
      assertEquals(cols.get("id")!.hasDefault, true);

      assertEquals(cols.get("nickname")!.nullable, true);
      assertEquals(cols.get("nickname")!.hasDefault, false);

      assertEquals(cols.get("name")!.pgType, "text");
      assertEquals(cols.get("name")!.nullable, false);

      assertEquals(cols.get("email")!.pgType, "text");

      const ts = cols.get("created_at")!;
      // PG canonicalizes "timestamp with time zone" — accept either form.
      assert(ts.pgType.includes("timestamp"));
      assertEquals(ts.hasDefault, true);
    });
  },
});

Deno.test({
  name: "introspectDatabase - primary keys are reported",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSampleSchema(async (db) => {
      const data = await introspectDatabase(db, {
        tableFilter: (t) => t.startsWith("introspect_"),
      });
      const users = data.tables.find((t) => t.tableName === "introspect_users")!;
      assertEquals(users.primaryKey, ["id"]);
      const junction = data.tables.find((t) => t.tableName === "introspect_posts_tags")!;
      assertEquals(junction.primaryKey?.sort(), ["post_id", "tag_id"]);
    });
  },
});

Deno.test({
  name: "introspectDatabase - unique constraints are reported",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSampleSchema(async (db) => {
      const data = await introspectDatabase(db, {
        tableFilter: (t) => t.startsWith("introspect_"),
      });
      const users = data.tables.find((t) => t.tableName === "introspect_users")!;
      const hasEmailUnique = (users.uniqueConstraints ?? []).some(
        (uc) => uc.length === 1 && uc[0] === "email",
      );
      assert(hasEmailUnique, "email UNIQUE not detected");
    });
  },
});

Deno.test({
  name: "introspectDatabase - foreign keys are reported",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withSampleSchema(async (db) => {
      const data = await introspectDatabase(db, {
        tableFilter: (t) => t.startsWith("introspect_"),
      });
      const fkPostsAuthor = data.foreignKeys.find(
        (fk) =>
          fk.fromTable === "introspect_posts"
          && fk.fromColumn === "author_id",
      );
      assert(fkPostsAuthor, "posts.author_id FK missing");
      assertEquals(fkPostsAuthor!.toTable, "introspect_users");
      assertEquals(fkPostsAuthor!.toColumn, "id");

      const fkJunctionPost = data.foreignKeys.find(
        (fk) =>
          fk.fromTable === "introspect_posts_tags"
          && fk.fromColumn === "post_id",
      );
      assert(fkJunctionPost, "junction post_id FK missing");
      assertEquals(fkJunctionPost!.toTable, "introspect_posts");
    });
  },
});
