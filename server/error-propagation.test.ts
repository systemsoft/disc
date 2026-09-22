/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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

// --- SQLSTATE in the error envelope (Phase 7, S5) ---

/** What deno-postgres throws: an Error whose `fields` carry the server's error fields. */
function makePostgresErrorPool(fields: Record<string, string | undefined>): ConnectionPool {
  return {
    query: () => {
      const error = new Error(`Database error: ${fields.message ?? "failed"}`);
      Object.assign(error, { fields });
      throw error;
    },
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve()
  } as unknown as ConnectionPool;
}

Deno.test("EdgeQLProtocolHandler - a unique violation reports sqlState, constraint, table and detail in extensions", async () => {
  const handler = new EdgeQLProtocolHandler({
    connectionPool: makePostgresErrorPool({
      code: "23505",
      constraint: "uk_git_ref_program_id_name",
      detail: "Key (program_id, name)=(p, refs/heads/main) already exists.",
      message: "duplicate key value violates unique constraint \"uk_git_ref_program_id_name\"",
      severity: "ERROR",
      table: "git_ref"
    })
  });

  const response = await handler.handleRequest({ query: "insert User { name := 'x' }", variables: {} }, makeContext());

  assert(response.errors, "expected errors");
  const extensions = response.errors[0].extensions!;
  assertEquals(extensions.code, "EXECUTION_ERROR");
  assertEquals(extensions.sqlState, "23505");
  assertEquals(extensions.constraint, "uk_git_ref_program_id_name");
  assertEquals(extensions.table, "git_ref");
  assertEquals(extensions.detail, "Key (program_id, name)=(p, refs/heads/main) already exists.");
  assertStringIncludes(response.errors[0].message, "duplicate key");
});

Deno.test("EdgeQLProtocolHandler - a serialization failure carries only the fields PostgreSQL sent", async () => {
  const handler = new EdgeQLProtocolHandler({
    connectionPool: makePostgresErrorPool({ code: "40001", message: "could not serialize access due to concurrent update", severity: "ERROR" })
  });

  const response = await handler.handleRequest({ query: "insert User { name := 'x' }", variables: {} }, makeContext());

  const extensions = response.errors![0].extensions!;
  assertEquals(extensions.sqlState, "40001");
  assertEquals("constraint" in extensions, false);
  assertEquals("table" in extensions, false);
  assertEquals("detail" in extensions, false);
});

Deno.test("EdgeQLProtocolHandler - an error without PostgreSQL fields has no sqlState", async () => {
  const handler = new EdgeQLProtocolHandler({ connectionPool: makeFaultyPool("connection refused") });

  const response = await handler.handleRequest({ query: "select User { name }", variables: {} }, makeContext());

  const extensions = response.errors![0].extensions!;
  assertEquals(extensions.code, "EXECUTION_ERROR");
  assertEquals("sqlState" in extensions, false);
});

Deno.test("SimpleEdgeQLProtocolHandler - a unique violation reports sqlState too", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    connectionPool: makePostgresErrorPool({ code: "23505", constraint: "uk_x", message: "duplicate key", severity: "ERROR" })
  });

  const response = await handler.handleRequest({ query: "insert User { name := 'x' }", variables: {} }, makeContext());

  const extensions = response.errors![0].extensions!;
  assertEquals(extensions.code, "EXECUTION_ERROR");
  assertEquals(extensions.sqlState, "23505");
  assertEquals(extensions.constraint, "uk_x");
});

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
