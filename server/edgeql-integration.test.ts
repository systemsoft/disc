/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for EdgeQL Protocol Integration
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as Context from "../compiler/context.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

Deno.test("EdgeQL Protocol - Basic Query Validation", () => {
  const handler = new EdgeQLProtocolHandler();

  // Valid EdgeQL query
  const validRequest = {
    query: "select User { name, email }",
    variables: {}
  };

  const validErrors = handler.validateRequest(validRequest);
  assertEquals(validErrors.length, 0);

  // Invalid query - missing query
  const invalidRequest = {
    query: "",
    variables: {}
  };

  const invalidErrors = handler.validateRequest(invalidRequest);
  assertEquals(invalidErrors.length > 0, true);
  assertStringIncludes(invalidErrors[0].message, "Query is required");
});

Deno.test("EdgeQL Protocol - EdgeQL Syntax Validation", () => {
  const handler = new EdgeQLProtocolHandler();

  // Unbalanced braces
  const unbalancedRequest = {
    query: "select User { name, email",
    variables: {}
  };

  const errors = handler.validateRequest(unbalancedRequest);
  assertEquals(errors.length > 0, true);
  assertStringIncludes(errors[0].message, "Unbalanced braces");

  // Invalid start keyword
  const invalidStartRequest = {
    query: "invalid User { name }",
    variables: {}
  };

  const startErrors = handler.validateRequest(invalidStartRequest);
  assertEquals(startErrors.length > 0, true);
  assertStringIncludes(startErrors[0].message, "valid EdgeQL statement");
});

Deno.test("EdgeQL Protocol - Simple Select Query Execution", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "select User { name, email }",
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

  // Should have successful response
  assertEquals(response.errors, undefined);
  assertEquals(Array.isArray(response.data), true);
  assertEquals(response.extensions?.durationMs !== undefined, true);
  assertEquals(typeof response.extensions?.queryHash, "string");
});

Deno.test("EdgeQL Protocol - Query with Variables", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "select User filter .name = <str>$name",
    variables: { name: "Ada" }
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

  // Should handle variables correctly
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
  assertEquals(response.extensions?.durationMs !== undefined, true);
});

Deno.test("EdgeQL Protocol - Insert Query", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "insert User { name := 'John Doe', email := 'john@example.com' }",
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

  // Should execute insert successfully
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
  assertEquals(typeof response.data.id, "string");
});

Deno.test("EdgeQL Protocol - Update Query", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "update User filter .name = 'Ada' set { active := false }",
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

  // Should execute update successfully
  assertEquals(response.errors, undefined);
  assertEquals(response.data !== undefined, true);
});

Deno.test("EdgeQL Protocol - Delete Query", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "delete User filter .name = 'Billie'",
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

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
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

  // Should have parse or syntax error
  assertEquals(response.data, undefined);
  assertEquals(Array.isArray(response.errors), true);
  assertEquals(response.errors!.length > 0, true);
  // Accept either PARSE_ERROR or SYNTAX_ERROR depending on which check catches it first
  const errorCode = response.errors![0].extensions?.code;
  assert(
    errorCode === "PARSE_ERROR" || errorCode === "SYNTAX_ERROR" ||
      errorCode === "COMPILATION_ERROR",
    `Expected PARSE_ERROR, SYNTAX_ERROR, or COMPILATION_ERROR but got ${errorCode}`
  );
});

Deno.test("EdgeQL Protocol - Dry Run Mode", async () => {
  const handler = new EdgeQLProtocolHandler({ dryRun: true });

  const request = {
    query: "select User { name, email }",
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

  // Should have dry run response
  assertEquals(response.errors?.length, 1);
  assertEquals(response.errors?.[0].extensions?.code, "WARNING");
  assertEquals(response.data.dryRun, true);
});

Deno.test("EdgeQL Protocol - Explain Mode", async () => {
  const handler = new EdgeQLProtocolHandler({ enableExplain: true });

  const request = {
    query: "select User { name, email }",
    variables: {}
  };

  const context: Types.QueryContext = {
    session: {
      sessionId: "test_session",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };

  const response = await handler.handleRequest(request, context);

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
    links: new Map()
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
