/**
 * Tests for SchemaManager
 *
 * Unit tests that exercise SDL parsing, Module-to-Schema conversion,
 * and dry-run migration without requiring a live PostgreSQL instance.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { SchemaManager } from "./schema-manager.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, cleanupTestTables, getTestDsn } from "../tests/pg-test-harness.ts";

// ---------------------------------------------------------------------------
// 1. parseSDL -- valid SDL produces Module[]
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - parseSDL - valid SDL produces modules", () => {
  const manager = new SchemaManager({});
  const sdl = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const result = manager.parseSDL(sdl);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertNotEquals(result.value.length, 0);

    const defaultModule = result.value.find((m) => m.name === "default");
    assert(defaultModule !== undefined, "Expected a 'default' module");

    const userType = defaultModule.items.find(
      (item) => item.kind === "TypeDeclaration" && item.name.value === "User",
    );
    assert(userType !== undefined, "Expected a 'User' type declaration");
  }
});

// ---------------------------------------------------------------------------
// 2. parseSDL -- invalid SDL returns error
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - parseSDL - invalid SDL returns error", () => {
  const manager = new SchemaManager({});
  const sdl = "type { broken";

  const result = manager.parseSDL(sdl);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.error !== undefined, "Expected an error to be present");
  }
});

Deno.test("SchemaManager - parseSDL - reports multiple SDL errors at once (P2-06)", () => {
  // Three malformed top-level declarations interleaved with one good.
  // parseSDL should now surface all three errors in a single message,
  // not just the first one — that's the user-facing payoff of
  // SDLParser.parseWithRecovery.
  const manager = new SchemaManager({});
  const sdl = `
    type Bad1 { @@@ }
    type Good { required name: str; }
    type Bad2 { 123 }
    type Bad3 { ??? unknown garbage }
  `;

  const result = manager.parseSDL(sdl);
  // ??? doesn't lex, so this is one of the cases parseWithRecovery can't
  // recover from. Either the lexer throws (single-error path) or
  // recovery kicks in (multi-error path) — both are valid; just verify
  // we ALWAYS surface SOME error.
  assertEquals(result.ok, false);
});

Deno.test("SchemaManager - parseSDL - lexable multi-error SDL surfaces every error", () => {
  // Use only lexable bad input so parseWithRecovery actually runs and
  // the multi-error message path is exercised.
  const manager = new SchemaManager({});
  const sdl = `
    type Bad1 { @@@ }
    type Good { required name: str; }
    type Bad2 { 123 garbage }
  `;

  const result = manager.parseSDL(sdl);
  assertEquals(result.ok, false);
  if (!result.ok) {
    // Two distinct error sites should appear in the message.
    const msg = result.error.message;
    assert(
      msg.includes("2 error") || msg.includes("3 error"),
      `Expected multi-error message, got: ${msg}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. modulesToSchema -- correct TypeDef with tableName, properties
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - modulesToSchema - correct TypeDef with tableName and properties", () => {
  const manager = new SchemaManager({});
  const sdl = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const schema = manager.modulesToSchema(parseResult.value);
  const userType = schema.types.get("User");

  assert(userType !== undefined, "Expected a 'User' TypeDef");
  assertEquals(userType.tableName, "user");

  assert(userType.properties.has("name"), "Expected 'name' property");
  assert(userType.properties.has("email"), "Expected 'email' property");
});

// ---------------------------------------------------------------------------
// 4. modulesToSchema -- SDL type to SQL column type mapping
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - modulesToSchema - SDL type to SQL column type mapping", () => {
  const manager = new SchemaManager({});
  const sdl = `
    type AllTypes {
      str_field: str;
      int32_field: int32;
      bool_field: bool;
      datetime_field: datetime;
      uuid_field: uuid;
      float64_field: float64;
    }
  `;

  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const schema = manager.modulesToSchema(parseResult.value);
  const typeDef = schema.types.get("AllTypes");

  assert(typeDef !== undefined, "Expected an 'AllTypes' TypeDef");

  const expectedMappings: Record<string, string> = {
    "str_field": "text",
    "int32_field": "integer",
    "bool_field": "boolean",
    "datetime_field": "timestamptz",
    "uuid_field": "uuid",
    "float64_field": "double precision",
  };

  for (const [propName, expectedSqlType] of Object.entries(expectedMappings)) {
    const prop = typeDef.properties.get(propName);
    assert(prop !== undefined, `Expected '${propName}' property`);
    assertEquals(
      prop.type,
      expectedSqlType,
      `Expected '${propName}' to map to '${expectedSqlType}', got '${prop.type}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. modulesToSchema -- single link gets columnName `_id`, multi link gets no columnName
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - modulesToSchema - single link gets _id columnName, multi link gets undefined", () => {
  const manager = new SchemaManager({});
  const sdl = `
    type Post {
      required link author -> User;
    }
    type User {
      multi link posts -> Post;
      required name: str;
    }
  `;

  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const schema = manager.modulesToSchema(parseResult.value);

  // Single link: Post.author should have columnName "author_id"
  const postType = schema.types.get("Post");
  assert(postType !== undefined, "Expected a 'Post' TypeDef");

  const authorLink = postType.links.get("author");
  assert(authorLink !== undefined, "Expected an 'author' link on Post");
  assertEquals(authorLink.columnName, "author_id");

  // Multi link: User.posts should have no columnName
  const userType = schema.types.get("User");
  assert(userType !== undefined, "Expected a 'User' TypeDef");

  const postsLink = userType.links.get("posts");
  assert(postsLink !== undefined, "Expected a 'posts' link on User");
  assertEquals(postsLink.columnName, undefined);
});

// ---------------------------------------------------------------------------
// 6. modulesToSchema -- implicit id property added
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - modulesToSchema - implicit id property added", () => {
  const manager = new SchemaManager({});
  const sdl = `
    type Widget {
      required label: str;
    }
  `;

  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const schema = manager.modulesToSchema(parseResult.value);
  const widgetType = schema.types.get("Widget");

  assert(widgetType !== undefined, "Expected a 'Widget' TypeDef");

  const idProp = widgetType.properties.get("id");
  assert(idProp !== undefined, "Expected an 'id' property");
  assertEquals(idProp.type, "uuid");
  assertEquals(idProp.required, true);
  assertEquals(idProp.columnName, "id");
});

// ---------------------------------------------------------------------------
// 6b. modulesToSchema -- camelCase property name → snake_case columnName
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - modulesToSchema - camelCase property name → snake_case columnName", () => {
  // The EdgeQL compiler emits SQL using PropertyDef.columnName. If this
  // diverges from the actual table column written by the DDL generator,
  // queries fail with "column does not exist". Both sides must agree on
  // the snake_case form.
  const manager = new SchemaManager({});
  const sdl = `
    type Item {
      required name: str;
      createdAt: datetime;
      lastModifiedBy: str;
      already_snake: str;
    }
  `;

  const parseResult = manager.parseSDL(sdl);
  assertEquals(parseResult.ok, true);
  if (!parseResult.ok) return;

  const schema = manager.modulesToSchema(parseResult.value);
  const itemType = schema.types.get("Item");

  assert(itemType !== undefined, "Expected an 'Item' TypeDef");
  assertEquals(itemType.properties.get("createdAt")?.columnName, "created_at");
  assertEquals(
    itemType.properties.get("lastModifiedBy")?.columnName,
    "last_modified_by",
  );
  assertEquals(
    itemType.properties.get("already_snake")?.columnName,
    "already_snake",
    "snake_case input should be idempotent",
  );
});

// ---------------------------------------------------------------------------
// 7. getSchema returns null before any load
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - getSchema - returns null before any load", () => {
  const manager = new SchemaManager({});
  const schema = manager.getSchema();

  assertEquals(schema, null);
});

// ---------------------------------------------------------------------------
// 8. applySchema in dryRun mode -- no DB needed
// ---------------------------------------------------------------------------
Deno.test("SchemaManager - applySchema - dryRun mode returns ok without DB", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();

  const sdl = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const result = await manager.applySchema(sdl);

  assertEquals(result.ok, true);
  if (result.ok) {
    // After a dry-run apply, getSchema should return the new schema
    const schema = manager.getSchema();
    assert(
      schema !== null,
      "Expected schema to be set after dry-run applySchema",
    );
    assert(
      schema.types.has("User"),
      "Expected schema to contain 'User' type after dry-run apply",
    );
  }

  await manager.close();
});

// ---------------------------------------------------------------------------
// 9. applySchema with skipHistory — applies DDL but does not record
//    a row in disc_migrations. (gh/geldata#3761 — `disc db push`.)
// ---------------------------------------------------------------------------
Deno.test({
  name: "SchemaManager - applySchema with skipHistory leaves disc_migrations untouched (Bundle RR — gh/geldata#3761)",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupTestTables(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      applicationName: "disc-test-push",
    });
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool, dryRun: false });
      await manager.initialize();

      // First apply with skipHistory — DDL runs, no migration recorded.
      const sdl = `
        type Widget {
          required name: str;
        }
      `;
      const result = await manager.applySchema(sdl, { skipHistory: true });
      assertEquals(
        result.ok,
        true,
        "applySchema with skipHistory should succeed",
      );

      // Verify the table was created (DDL ran).
      const widgetExists = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'widget'",
      );
      assertEquals(
        widgetExists.rowCount,
        1,
        "Widget table must exist (DDL ran)",
      );

      // Verify NO row landed in disc_migrations. The tracker creates
      // the table on initialize, so a zero-count select is the right
      // assertion.
      const migrationCount = await pool.query(
        "SELECT COUNT(*)::int AS c FROM disc_migrations",
      );
      assertEquals(
        (migrationCount.rows[0] as { c: number }).c,
        0,
        "disc_migrations must be empty after a skipHistory apply (Gel #3761)",
      );

      // Sanity: a second apply *without* skipHistory records normally.
      // This guards against the option leaking into subsequent calls.
      const sdl2 = `
        type Widget {
          required name: str;
        }
        type Gadget {
          required label: str;
        }
      `;
      const result2 = await manager.applySchema(sdl2);
      assertEquals(
        result2.ok,
        true,
        "applySchema without skipHistory should succeed",
      );

      const migrationCount2 = await pool.query(
        "SELECT COUNT(*)::int AS c FROM disc_migrations",
      );
      assertEquals(
        (migrationCount2.rows[0] as { c: number }).c,
        1,
        "disc_migrations must record the non-skip apply (1 row)",
      );
    } finally {
      await pool.close();
      await cleanupTestTables(dsn);
    }
  },
});
