/**
 * Tests for EdgeQL Protocol Integration
 */

import { assertEquals, assertStringIncludes, assert } from "@std/assert";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";
import * as Context from "../compiler/context.ts";

Deno.test("EdgeQL Protocol - Basic Query Validation", () => {
  const handler = new EdgeQLProtocolHandler();
  
  // Valid EdgeQL query
  const valid_request = {
    query: "select User { name, email }",
    variables: {},
  };
  
  const valid_errors = handler.validate_request(valid_request);
  assertEquals(valid_errors.length, 0);
  
  // Invalid query - missing query
  const invalid_request = {
    query: "",
    variables: {},
  };
  
  const invalid_errors = handler.validate_request(invalid_request);
  assertEquals(invalid_errors.length > 0, true);
  assertStringIncludes(invalid_errors[0].message, "Query is required");
});

Deno.test("EdgeQL Protocol - EdgeQL Syntax Validation", () => {
  const handler = new EdgeQLProtocolHandler();
  
  // Unbalanced braces
  const unbalanced_request = {
    query: "select User { name, email",
    variables: {},
  };
  
  const errors = handler.validate_request(unbalanced_request);
  assertEquals(errors.length > 0, true);
  assertStringIncludes(errors[0].message, "Unbalanced braces");
  
  // Invalid start keyword
  const invalid_start_request = {
    query: "invalid User { name }",
    variables: {},
  };
  
  const start_errors = handler.validate_request(invalid_start_request);
  assertEquals(start_errors.length > 0, true);
  assertStringIncludes(start_errors[0].message, "valid EdgeQL statement");
});

Deno.test("EdgeQL Protocol - Simple Select Query Execution", async () => {
  const handler = new EdgeQLProtocolHandler();
  
  const request = {
    query: "select User { name, email }",
    variables: {},
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should have successful response
  assertEquals(response.errors, undefined);
  assertEquals(Array.isArray(response.data), true);
  assertEquals(response.extensions?.duration_ms !== undefined, true);
  assertEquals(typeof response.extensions?.query_hash, "string");
});

Deno.test("EdgeQL Protocol - Query with Variables", async () => {
  const handler = new EdgeQLProtocolHandler();
  
  const request = {
    query: "select User filter .name = <str>$name",
    variables: { name: "Alice" },
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should handle variables correctly
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
  assertEquals(response.extensions?.duration_ms !== undefined, true);
});

Deno.test("EdgeQL Protocol - Insert Query", async () => {
  const handler = new EdgeQLProtocolHandler();
  
  const request = {
    query: "insert User { name := 'John Doe', email := 'john@example.com' }",
    variables: {},
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should execute insert successfully
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
  assertEquals(typeof response.data.id, "string");
});

Deno.test("EdgeQL Protocol - Update Query", async () => {
  const handler = new EdgeQLProtocolHandler();
  
  const request = {
    query: "update User filter .name = 'Alice' set { active := false }",
    variables: {},
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should execute update successfully
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
});

Deno.test("EdgeQL Protocol - Delete Query", async () => {
  const handler = new EdgeQLProtocolHandler();
  
  const request = {
    query: "delete User filter .name = 'Bob'",
    variables: {},
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should execute delete successfully
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
  assertEquals(response.data.deleted, true);
});

Deno.test("EdgeQL Protocol - Parse Error Handling", async () => {
  const handler = new EdgeQLProtocolHandler();

  // Use a query with balanced braces but invalid internal syntax
  // so it passes basic validation but fails during actual parsing
  const request = {
    query: "select User { name, @#$%^ }",
    variables: {},
  };

  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };

  const response = await handler.handle_request(request, context);

  // Should have parse or syntax error
  assertEquals(response.data, undefined);
  assertEquals(Array.isArray(response.errors), true);
  assertEquals(response.errors!.length > 0, true);
  // Accept either PARSE_ERROR or SYNTAX_ERROR depending on which check catches it first
  const errorCode = response.errors![0].extensions?.code;
  assert(errorCode === "PARSE_ERROR" || errorCode === "SYNTAX_ERROR" || errorCode === "COMPILATION_ERROR",
    `Expected PARSE_ERROR, SYNTAX_ERROR, or COMPILATION_ERROR but got ${errorCode}`);
});

Deno.test("EdgeQL Protocol - Dry Run Mode", async () => {
  const handler = new EdgeQLProtocolHandler({ dry_run: true });
  
  const request = {
    query: "select User { name, email }",
    variables: {},
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should have dry run response
  assertEquals(response.errors?.length, 1);
  assertEquals(response.errors?.[0].extensions?.code, "WARNING");
  assertEquals(response.data.dry_run, true);
});

Deno.test("EdgeQL Protocol - Explain Mode", async () => {
  const handler = new EdgeQLProtocolHandler({ enable_explain: true });
  
  const request = {
    query: "select User { name, email }",
    variables: {},
  };
  
  const context: Types.QueryContext = {
    session: {
      session_id: "test_session",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [] },
    request_id: "test_request",
    started_at: new Date(),
  };
  
  const response = await handler.handle_request(request, context);
  
  // Should include SQL in extensions
  assertEquals(response.errors, undefined);
  assertEquals(typeof response.extensions?.sql, "string");
  assertEquals(response.extensions?.compilation_info !== undefined, true);
});

Deno.test("EdgeQL Protocol - Schema Management", () => {
  const handler = new EdgeQLProtocolHandler();
  
  // Should have default schema
  const schema = handler.getSchema();
  assertEquals(schema.types.has("User"), true);
  assertEquals(schema.types.has("Post"), true);
  
  // Should be able to update schema
  const newSchema = Context.createTestSchema();
  newSchema.types.set("NewType", {
    name: "NewType",
    kind: "object",
    tableName: "new_types",
    properties: new Map(),
    links: new Map(),
  });
  
  handler.updateSchema(newSchema);
  const updatedSchema = handler.getSchema();
  assertEquals(updatedSchema.types.has("NewType"), true);
});

Deno.test("EdgeQL Protocol - Compiler Info", () => {
  const handler = new EdgeQLProtocolHandler();
  
  const info = handler.getCompilerInfo();
  assertEquals(typeof info.version, "string");
  assertEquals(Array.isArray(info.features), true);
  assertEquals(info.features.length > 0, true);
});