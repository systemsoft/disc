/**
 * Tests for error propagation in executeSQL / executeQuery methods.
 *
 * Verifies that database errors are NOT silently swallowed and replaced
 * with mock data when a real connection pool is configured.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseExecutionError } from "../lib/errors.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import * as Types from "./types.ts";

// --- Helpers ---

function makeContext(): Types.QueryContext {
  return {
    session: {
      sessionId: "test_error_propagation",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };
}

/**
 * Creates a mock ConnectionPool whose `query()` always throws.
 * We cast through `unknown` because we only need the `query` method
 * for the code path under test.
 */
function makeFaultyPool(errorMessage: string): ConnectionPool {
  return {
    query: () => {
      throw new Error(errorMessage);
    },
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve()
  } as unknown as ConnectionPool;
}

// --- DatabaseExecutionError unit tests ---

Deno.test(
  "DatabaseExecutionError - wraps original error and includes SQL",
  () => {
    const originalError = new Error("relation \"users\" does not exist");
    const sql = "SELECT * FROM users WHERE id = $1";
    const dbError = new DatabaseExecutionError(
      `Database query failed: ${originalError.message}`,
      sql,
      originalError
    );

    assertEquals(dbError.name, "DatabaseExecutionError");
    assertStringIncludes(dbError.message, "relation \"users\" does not exist");
    assertEquals(dbError.sql, sql);
    assertEquals(dbError.cause, originalError);

    const formatted = dbError.formatError();
    assertStringIncludes(formatted, "DatabaseExecutionError");
    assertStringIncludes(formatted, sql);
    assertStringIncludes(formatted, "Caused by:");
    assertStringIncludes(formatted, "relation \"users\" does not exist");
  }
);

// --- EdgeQLProtocolHandler (full compiler) ---

Deno.test(
  "EdgeQLProtocolHandler - pool error propagates as EXECUTION_ERROR, not mock data",
  async () => {
    const faultyPool = makeFaultyPool(
      "connection refused"
    );

    const handler = new EdgeQLProtocolHandler({
      connectionPool: faultyPool
    });

    const request = {
      query: "select User { name, email }",
      variables: {}
    };

    const response = await handler.handleRequest(request, makeContext());

    // The error must surface — NOT be swallowed into mock data
    assert(response.errors !== undefined, "Expected errors in response");
    assert(response.errors!.length > 0, "Expected at least one error");
    assertEquals(response.errors![0].extensions?.code, "EXECUTION_ERROR");
    assertStringIncludes(response.errors![0].message, "connection refused");

    // Critically: data must NOT contain mock user records
    assert(
      response.data === undefined,
      "Expected no data when pool throws — mock fallback should not be used"
    );
  }
);

Deno.test(
  "EdgeQLProtocolHandler - no pool returns mock data (dev mode preserved)",
  async () => {
    // No connectionPool, no databaseUrl → mock path
    const handler = new EdgeQLProtocolHandler();

    const request = {
      query: "select User { name, email }",
      variables: {}
    };

    const response = await handler.handleRequest(request, makeContext());

    // Mock data should be returned successfully
    assertEquals(response.errors, undefined);
    assert(response.data !== undefined, "Expected mock data in response");
    assert(Array.isArray(response.data), "Expected mock data to be an array");
  }
);

// --- SimpleEdgeQLProtocolHandler ---

Deno.test(
  "SimpleEdgeQLProtocolHandler - pool error propagates as EXECUTION_ERROR, not mock data",
  async () => {
    const faultyPool = makeFaultyPool(
      "timeout expired"
    );

    const handler = new SimpleEdgeQLProtocolHandler({
      connectionPool: faultyPool
    });

    const request = {
      query: "select User { name, email }",
      variables: {}
    };

    const response = await handler.handleRequest(request, makeContext());

    // The error must surface
    assert(response.errors !== undefined, "Expected errors in response");
    assert(response.errors!.length > 0, "Expected at least one error");
    assertEquals(response.errors![0].extensions?.code, "EXECUTION_ERROR");
    assertStringIncludes(response.errors![0].message, "timeout expired");

    // No mock data
    assert(
      response.data === undefined,
      "Expected no data when pool throws — mock fallback should not be used"
    );
  }
);

Deno.test(
  "SimpleEdgeQLProtocolHandler - no pool returns mock data (dev mode preserved)",
  async () => {
    // No connectionPool, no databaseUrl → mock path
    const handler = new SimpleEdgeQLProtocolHandler();

    const request = {
      query: "select User { name, email }",
      variables: {}
    };

    const response = await handler.handleRequest(request, makeContext());

    // Mock data should be returned successfully
    assertEquals(response.errors, undefined);
    assert(response.data !== undefined, "Expected mock data in response");
    assert(Array.isArray(response.data), "Expected mock data to be an array");
  }
);
