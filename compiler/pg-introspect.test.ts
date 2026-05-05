/**
 * PostgreSQL introspection transformer (#3452 — Phase 3)
 *
 * Pure tests for `buildSchemaFromIntrospection` — turns flat
 * information_schema-style metadata into an in-memory `Schema`.
 * The live-DB SQL queries that produce that metadata land in the
 * CLI phase that follows (the queries are best validated against
 * a real Postgres; the mapping is best validated in isolation).
 */

import { assertEquals } from "@std/assert";
import {
  buildSchemaFromIntrospection,
  pgTypeToEdgeqlType,
  type IntrospectionData,
} from "./pg-introspect.ts";

// =========================================================================
// pgTypeToEdgeqlType — type mapping
// =========================================================================

Deno.test("pgTypeToEdgeqlType - common scalars", () => {
  assertEquals(pgTypeToEdgeqlType("text"), "str");
  assertEquals(pgTypeToEdgeqlType("varchar"), "str");
  assertEquals(pgTypeToEdgeqlType("character varying"), "str");
  assertEquals(pgTypeToEdgeqlType("smallint"), "int16");
  assertEquals(pgTypeToEdgeqlType("int2"), "int16");
  assertEquals(pgTypeToEdgeqlType("integer"), "int32");
  assertEquals(pgTypeToEdgeqlType("int4"), "int32");
  assertEquals(pgTypeToEdgeqlType("bigint"), "int64");
  assertEquals(pgTypeToEdgeqlType("int8"), "int64");
  assertEquals(pgTypeToEdgeqlType("real"), "float32");
  assertEquals(pgTypeToEdgeqlType("double precision"), "float64");
  assertEquals(pgTypeToEdgeqlType("boolean"), "bool");
  assertEquals(pgTypeToEdgeqlType("bytea"), "bytes");
  assertEquals(pgTypeToEdgeqlType("timestamptz"), "datetime");
  assertEquals(pgTypeToEdgeqlType("timestamp with time zone"), "datetime");
  assertEquals(pgTypeToEdgeqlType("timestamp"), "local_datetime");
  assertEquals(pgTypeToEdgeqlType("date"), "local_date");
  assertEquals(pgTypeToEdgeqlType("time"), "local_time");
  assertEquals(pgTypeToEdgeqlType("interval"), "duration");
  assertEquals(pgTypeToEdgeqlType("uuid"), "uuid");
  assertEquals(pgTypeToEdgeqlType("numeric"), "decimal");
  assertEquals(pgTypeToEdgeqlType("decimal"), "decimal");
  assertEquals(pgTypeToEdgeqlType("json"), "json");
  assertEquals(pgTypeToEdgeqlType("jsonb"), "json");
});

Deno.test("pgTypeToEdgeqlType - unknown type falls back to str (best-effort)", () => {
  // Unknown types aren't an error — emit `str` so the user can edit
  // the resulting SDL rather than failing the entire export.
  assertEquals(pgTypeToEdgeqlType("citext"), "str");
});

// =========================================================================
// Table → object type
// =========================================================================

Deno.test("buildSchemaFromIntrospection - simple table becomes object type", () => {
  const data: IntrospectionData = {
    tables: [{
      schemaName: "public",
      tableName: "users",
      columns: [
        { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        { name: "name", pgType: "text", nullable: false, hasDefault: false },
        { name: "email", pgType: "text", nullable: false, hasDefault: false },
      ],
      primaryKey: ["id"],
      uniqueConstraints: [["email"]],
    }],
    foreignKeys: [],
  };

  const schema = buildSchemaFromIntrospection(data);
  const user = schema.types.get("User");
  assertEquals(user !== undefined, true);
  assertEquals(user!.kind, "object");
  assertEquals(user!.tableName, "users");

  // id is preserved as a property, marked as PK
  const id = user!.properties.get("id");
  assertEquals(id !== undefined, true);
  assertEquals(id!.required, true);

  const name = user!.properties.get("name")!;
  assertEquals(name.required, true);
  assertEquals(name.edgeqlType, "str");

  const email = user!.properties.get("email")!;
  // Unique constraint maps to `constraint exclusive`
  assertEquals(
    email.constraints?.some((c) => c.name === "exclusive"),
    true,
  );
});

Deno.test("buildSchemaFromIntrospection - nullable column → optional property", () => {
  const data: IntrospectionData = {
    tables: [{
      schemaName: "public",
      tableName: "users",
      columns: [
        { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        { name: "nickname", pgType: "text", nullable: true, hasDefault: false },
      ],
      primaryKey: ["id"],
    }],
    foreignKeys: [],
  };
  const schema = buildSchemaFromIntrospection(data);
  const user = schema.types.get("User")!;
  assertEquals(user.properties.get("nickname")!.required, false);
});

Deno.test("buildSchemaFromIntrospection - column with default sets hasDefault", () => {
  const data: IntrospectionData = {
    tables: [{
      schemaName: "public",
      tableName: "users",
      columns: [
        { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        {
          name: "createdAt",
          pgType: "timestamptz",
          nullable: false,
          hasDefault: true,
          defaultExpression: "now()",
        },
      ],
      primaryKey: ["id"],
    }],
    foreignKeys: [],
  };
  const schema = buildSchemaFromIntrospection(data);
  const ts = schema.types.get("User")!.properties.get("createdAt")!;
  assertEquals(ts.hasDefault, true);
});

// =========================================================================
// Foreign keys → links
// =========================================================================

Deno.test("buildSchemaFromIntrospection - FK column becomes single link", () => {
  const data: IntrospectionData = {
    tables: [
      {
        schemaName: "public",
        tableName: "users",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        ],
        primaryKey: ["id"],
      },
      {
        schemaName: "public",
        tableName: "posts",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
          { name: "title", pgType: "text", nullable: false, hasDefault: false },
          { name: "author_id", pgType: "uuid", nullable: false, hasDefault: false },
        ],
        primaryKey: ["id"],
      },
    ],
    foreignKeys: [
      {
        fromTable: "posts",
        fromColumn: "author_id",
        toTable: "users",
        toColumn: "id",
      },
    ],
  };

  const schema = buildSchemaFromIntrospection(data);
  const post = schema.types.get("Post")!;
  // The FK column should NOT appear as a property
  assertEquals(post.properties.has("author_id"), false);
  // It should appear as a link, named after the FK without the `_id` suffix
  const author = post.links.get("author");
  assertEquals(author !== undefined, true);
  assertEquals(author!.target, "User");
  assertEquals(author!.required, true);
  assertEquals(author!.multi, false);
});

Deno.test("buildSchemaFromIntrospection - nullable FK becomes optional link", () => {
  const data: IntrospectionData = {
    tables: [
      {
        schemaName: "public",
        tableName: "users",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        ],
        primaryKey: ["id"],
      },
      {
        schemaName: "public",
        tableName: "posts",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
          { name: "editor_id", pgType: "uuid", nullable: true, hasDefault: false },
        ],
        primaryKey: ["id"],
      },
    ],
    foreignKeys: [
      {
        fromTable: "posts",
        fromColumn: "editor_id",
        toTable: "users",
        toColumn: "id",
      },
    ],
  };

  const schema = buildSchemaFromIntrospection(data);
  const editor = schema.types.get("Post")!.links.get("editor")!;
  assertEquals(editor.required, false);
});

Deno.test("buildSchemaFromIntrospection - junction table becomes multi link on both sides", () => {
  const data: IntrospectionData = {
    tables: [
      {
        schemaName: "public",
        tableName: "users",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        ],
        primaryKey: ["id"],
      },
      {
        schemaName: "public",
        tableName: "tags",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
          { name: "name", pgType: "text", nullable: false, hasDefault: false },
        ],
        primaryKey: ["id"],
      },
      // Junction: only the two FK columns, both PK members.
      {
        schemaName: "public",
        tableName: "users_tags",
        columns: [
          { name: "user_id", pgType: "uuid", nullable: false, hasDefault: false },
          { name: "tag_id", pgType: "uuid", nullable: false, hasDefault: false },
        ],
        primaryKey: ["user_id", "tag_id"],
      },
    ],
    foreignKeys: [
      {
        fromTable: "users_tags",
        fromColumn: "user_id",
        toTable: "users",
        toColumn: "id",
      },
      {
        fromTable: "users_tags",
        fromColumn: "tag_id",
        toTable: "tags",
        toColumn: "id",
      },
    ],
  };

  const schema = buildSchemaFromIntrospection(data);

  // Junction table should NOT produce its own type
  assertEquals(schema.types.has("UsersTag"), false);
  assertEquals(schema.types.has("UsersTags"), false);
  assertEquals(schema.types.has("Users_tag"), false);

  // User has multi link to Tag
  const userToTags = schema.types.get("User")!.links.get("tags");
  assertEquals(userToTags !== undefined, true, "User.tags missing");
  assertEquals(userToTags!.target, "Tag");
  assertEquals(userToTags!.multi, true);

  // Tag has multi link to User
  const tagToUsers = schema.types.get("Tag")!.links.get("users");
  assertEquals(tagToUsers !== undefined, true, "Tag.users missing");
  assertEquals(tagToUsers!.target, "User");
  assertEquals(tagToUsers!.multi, true);
});

// =========================================================================
// Naming + filters
// =========================================================================

Deno.test("buildSchemaFromIntrospection - snake_case table → PascalCase type", () => {
  const data: IntrospectionData = {
    tables: [{
      schemaName: "public",
      tableName: "user_profiles",
      columns: [
        { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
      ],
      primaryKey: ["id"],
    }],
    foreignKeys: [],
  };
  const schema = buildSchemaFromIntrospection(data);
  assertEquals(schema.types.has("UserProfile"), true);
});

Deno.test("buildSchemaFromIntrospection - skips disc-internal tables", () => {
  const data: IntrospectionData = {
    tables: [
      {
        schemaName: "public",
        tableName: "disc_migrations",
        columns: [
          { name: "id", pgType: "text", nullable: false, hasDefault: false },
        ],
        primaryKey: ["id"],
      },
      {
        schemaName: "public",
        tableName: "disc_config",
        columns: [
          { name: "key", pgType: "text", nullable: false, hasDefault: false },
        ],
        primaryKey: ["key"],
      },
      {
        schemaName: "public",
        tableName: "users",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        ],
        primaryKey: ["id"],
      },
    ],
    foreignKeys: [],
  };

  const schema = buildSchemaFromIntrospection(data);
  assertEquals(schema.types.has("DiscMigration"), false);
  assertEquals(schema.types.has("DiscConfig"), false);
  assertEquals(schema.types.has("User"), true);
});

Deno.test("buildSchemaFromIntrospection - non-public schemas are namespaced into modules", () => {
  const data: IntrospectionData = {
    tables: [
      {
        schemaName: "public",
        tableName: "users",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        ],
        primaryKey: ["id"],
      },
      {
        schemaName: "billing",
        tableName: "invoices",
        columns: [
          { name: "id", pgType: "uuid", nullable: false, hasDefault: true },
        ],
        primaryKey: ["id"],
      },
    ],
    foreignKeys: [],
  };
  const schema = buildSchemaFromIntrospection(data);
  // public.users → default::User
  assertEquals(schema.types.get("User")?.module, "default");
  // billing.invoices → billing::Invoice
  const inv = schema.types.get("billing::Invoice");
  assertEquals(inv !== undefined, true);
  assertEquals(inv!.module, "billing");
});
