/**
 * Tests for Runtime Schema Reload
 *
 * Verifies that schema changes propagate from the SchemaManager through
 * the DiscServer and into the ProtocolHandler at runtime.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import type { ProtocolHandler, QueryContext, QueryRequest, QueryResponse } from "./types.ts";
import { DiscServer } from "./server.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock ProtocolHandler that satisfies the interface and optionally
 * records calls to updateSchema.
 */
function createMockHandler(options?: {
  onUpdateSchema?: (schema: Schema) => void;
}): ProtocolHandler {
  return {
    async handle_request(
      _request: QueryRequest,
      _context: QueryContext,
    ): Promise<QueryResponse> {
      return { data: null };
    },
    validate_request(_request: QueryRequest) {
      return [];
    },
    updateSchema: options?.onUpdateSchema
      ? (schema: Schema) => options.onUpdateSchema!(schema)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// 1. Handler receives schema update
// ---------------------------------------------------------------------------
Deno.test("Schema Reload - handler receives schema update", () => {
  let receivedSchema: Schema | null = null;

  const handler = createMockHandler({
    onUpdateSchema: (schema) => {
      receivedSchema = schema;
    },
  });

  const testSchema: Schema = {
    types: new Map([
      ["User", {
        name: "User",
        kind: "object",
        tableName: "user",
        properties: new Map([
          ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id" }],
          ["name", { name: "name", type: "text", required: true, multi: false, columnName: "name" }],
        ]),
        links: new Map(),
      }],
    ]),
    functions: new Map(),
  };

  handler.updateSchema!(testSchema);

  assert(receivedSchema !== null, "Expected updateSchema to be called");
  assertEquals(receivedSchema!.types.has("User"), true);
  assertEquals(receivedSchema!.types.get("User")!.name, "User");
});

// ---------------------------------------------------------------------------
// 2. DiscServer delegates updateSchema to handler
// ---------------------------------------------------------------------------
Deno.test("Schema Reload - DiscServer delegates updateSchema to handler", () => {
  let delegatedSchema: Schema | null = null;

  const server = new DiscServer({
    dry_run: true,
  });

  // Replace the protocol handler with our mock via getProtocolHandler
  // Instead, we construct a server and test the delegation path.
  // The DiscServer constructor creates its own handler, so we verify
  // that calling server.updateSchema doesn't throw (handler may not have updateSchema).
  const testSchema: Schema = {
    types: new Map([
      ["Post", {
        name: "Post",
        kind: "object",
        tableName: "post",
        properties: new Map([
          ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id" }],
          ["title", { name: "title", type: "text", required: true, multi: false, columnName: "title" }],
        ]),
        links: new Map(),
      }],
    ]),
    functions: new Map(),
  };

  // Verify getProtocolHandler returns the internal handler
  const handler = server.getProtocolHandler();
  assert(handler !== undefined, "Expected getProtocolHandler to return a handler");

  // Monkey-patch updateSchema on the handler to verify delegation
  (handler as Record<string, unknown>).updateSchema = (schema: Schema) => {
    delegatedSchema = schema;
  };

  server.updateSchema(testSchema);

  assert(delegatedSchema !== null, "Expected updateSchema to be delegated to handler");
  assertEquals(delegatedSchema!.types.has("Post"), true);
});

// ---------------------------------------------------------------------------
// 3. SchemaManager callback fires after applySchema (dry-run)
// ---------------------------------------------------------------------------
Deno.test("Schema Reload - SchemaManager callback fires after applySchema (dry-run)", async () => {
  let callbackSchema: Schema | null = null;

  const manager = new SchemaManager({
    dryRun: true,
    onSchemaChange: (schema) => {
      callbackSchema = schema;
    },
  });

  await manager.initialize();

  const sdl = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const result = await manager.applySchema(sdl);

  assert(result.ok, "Expected applySchema to succeed");
  assert(callbackSchema !== null, "Expected onSchemaChange callback to fire");
  assert(callbackSchema!.types.has("User"), "Expected schema to contain User type");

  const userType = callbackSchema!.types.get("User")!;
  assertEquals(userType.tableName, "user");
  assert(userType.properties.has("name"), "Expected User to have 'name' property");
  assert(userType.properties.has("email"), "Expected User to have 'email' property");
  assert(userType.properties.has("id"), "Expected User to have implicit 'id' property");
});

// ---------------------------------------------------------------------------
// 4. Stale schema recovery - callback receives updated schema with new types
// ---------------------------------------------------------------------------
Deno.test("Schema Reload - stale schema recovery with evolving types", async () => {
  const schemas: Schema[] = [];

  const manager = new SchemaManager({
    dryRun: true,
    onSchemaChange: (schema) => {
      schemas.push(schema);
    },
  });

  await manager.initialize();

  // First schema: just User
  const sdl1 = `
    type User {
      required name: str;
      email: str;
    }
  `;

  const result1 = await manager.applySchema(sdl1);
  assert(result1.ok, "Expected first applySchema to succeed");
  assertEquals(schemas.length, 1, "Expected callback to fire once after first apply");

  const firstSchema = schemas[0];
  assert(firstSchema.types.has("User"), "First schema should have User");
  assertEquals(firstSchema.types.has("Post"), false, "First schema should not have Post");

  // Second schema: User + Post with link
  const sdl2 = `
    type User {
      required name: str;
      email: str;
    }

    type Post {
      required title: str;
      required link author -> User;
    }
  `;

  const result2 = await manager.applySchema(sdl2);
  assert(result2.ok, "Expected second applySchema to succeed");
  assertEquals(schemas.length, 2, "Expected callback to fire again after second apply");

  const secondSchema = schemas[1];
  assert(secondSchema.types.has("User"), "Second schema should still have User");
  assert(secondSchema.types.has("Post"), "Second schema should have Post");

  const postType = secondSchema.types.get("Post")!;
  assert(postType.properties.has("title"), "Post should have 'title' property");
  assert(postType.links.has("author"), "Post should have 'author' link");
  assertEquals(postType.links.get("author")!.target, "User", "Author link should target User");
});
