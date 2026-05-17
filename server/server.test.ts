/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Disc Server
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ConnectionManager,
  SessionManager,
  TransactionManager
} from "./connection.ts";
import { EdgeQLProtocolHandler } from "./protocol.ts";
import { DiscServer } from "./server.ts";

Deno.test("Server Config - Default Values", () => {
  const server = new DiscServer();
  const config = server.get_config();

  assertEquals(config.host, "localhost");
  assertEquals(config.port, 5656);
  assertEquals(config.enableCors, true);
  assertEquals(config.enableWebsockets, true);
  assertEquals(config.maxConnections, 100);
});

Deno.test("Server Config - Custom Values", () => {
  const server = new DiscServer({
    host: "0.0.0.0",
    port: 8080,
    enableCors: false,
    maxConnections: 50
  });

  const config = server.get_config();

  assertEquals(config.host, "0.0.0.0");
  assertEquals(config.port, 8080);
  assertEquals(config.enableCors, false);
  assertEquals(config.maxConnections, 50);
});

Deno.test("Protocol Handler - Validate EdgeQL Request", () => {
  const handler = new EdgeQLProtocolHandler();

  // Valid request
  const validRequest = {
    query: "select User { name, email }",
    variables: {}
  };

  const validErrors = handler.validateRequest(validRequest);
  assertEquals(validErrors.length, 0);

  // Invalid request - missing query
  const invalidRequest = {
    query: "",
    variables: {}
  };

  const invalidErrors = handler.validateRequest(invalidRequest);
  assertEquals(invalidErrors.length > 0, true);
  assertStringIncludes(invalidErrors[0].message, "Query is required");
});

Deno.test("Protocol Handler - Query Too Large", () => {
  const handler = new EdgeQLProtocolHandler();

  const largeQuery = "select User { name }".repeat(10000); // > 100KB
  const request = {
    query: largeQuery,
    variables: {}
  };

  const errors = handler.validateRequest(request);
  assertEquals(errors.length > 0, true);
  assertStringIncludes(errors[0].message, "Query too large");
});

Deno.test("Protocol Handler - Syntax Validation", () => {
  const handler = new EdgeQLProtocolHandler();

  // Unbalanced braces
  const unbalancedRequest = {
    query: "select User { name, email",
    variables: {}
  };

  const errors = handler.validateRequest(unbalancedRequest);
  assertEquals(errors.length > 0, true);
  assertStringIncludes(errors[0].message, "Unbalanced braces");
});

Deno.test("Session Manager - Create and Retrieve Session", () => {
  const manager = new SessionManager();
  const session = manager.createSession("test_db");

  assertEquals(session.database, "test_db");
  assertEquals(typeof session.sessionId, "string");
  assertEquals(session.variables, {});

  const retrieved = manager.getSession(session.sessionId);
  assertEquals(retrieved?.sessionId, session.sessionId);
  assertEquals(retrieved?.database, "test_db");
});

Deno.test("Session Manager - Update Activity", async () => {
  const manager = new SessionManager();
  const session = manager.createSession("test_db");
  const originalTime = session.lastActivity;

  // Wait a bit and update activity
  await new Promise(resolve => setTimeout(resolve, 10));
  manager.updateActivity(session.sessionId);

  const updated = manager.getSession(session.sessionId);
  assertEquals(updated!.lastActivity > originalTime, true);
});

Deno.test("Session Manager - Close Session", () => {
  const manager = new SessionManager();

  const session = manager.createSession("test_db");
  assertEquals(manager.getSession(session.sessionId) !== null, true);

  manager.closeSession(session.sessionId);
  assertEquals(manager.getSession(session.sessionId), null);
});

Deno.test("Connection Manager - Create Connection", () => {
  const manager = new ConnectionManager();
  const connection = manager.createConnection("http", "127.0.0.1");

  assertEquals(connection.type, "http");
  assertEquals(connection.remoteAddr, "127.0.0.1");
  assertEquals(typeof connection.id, "string");
  assertEquals(typeof connection.session.sessionId, "string");
});

Deno.test("Connection Manager - Get Stats", () => {
  const manager = new ConnectionManager();

  manager.createConnection("http", "127.0.0.1");
  manager.createConnection("websocket", "127.0.0.1");
  manager.createConnection("http", "192.168.1.1");

  const stats = manager.get_stats();

  assertEquals(stats.active, 3);
  assertEquals(stats.total, 3);
  assertEquals(stats.http, 2);
  assertEquals(stats.websocket, 1);
});

Deno.test("Transaction Manager - Begin Transaction", () => {
  const manager = new TransactionManager();

  const transaction = manager.beginTransaction("session_001", {
    isolationLevel: "serializable",
    readOnly: true
  });

  assertEquals(transaction.sessionId, "session_001");
  assertEquals(transaction.isolationLevel, "serializable");
  assertEquals(transaction.readOnly, true);
  assertEquals(typeof transaction.id, "string");
  assertEquals(Array.isArray(transaction.statements), true);
});

Deno.test("Transaction Manager - Commit Transaction", async () => {
  const manager = new TransactionManager();
  const transaction = manager.beginTransaction("session_001");
  assertEquals(manager.getTransaction(transaction.id) !== null, true);

  await manager.commitTransaction(transaction.id);
  assertEquals(manager.getTransaction(transaction.id), null);
});

Deno.test("Transaction Manager - Rollback Transaction", async () => {
  const manager = new TransactionManager();
  const transaction = manager.beginTransaction("session_001");
  assertEquals(manager.getTransaction(transaction.id) !== null, true);

  await manager.rollbackTransaction(transaction.id);
  assertEquals(manager.getTransaction(transaction.id), null);
});

Deno.test("Protocol Handler - Mock Query Execution", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "select User { name, email }",
    variables: {}
  };

  const context = {
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

  assertEquals(response.errors, undefined);
  assertEquals(Array.isArray(response.data), true);
  assertEquals(response.extensions?.durationMs !== undefined, true);
  assertEquals(typeof response.extensions?.queryHash, "string");
});

Deno.test("Protocol Handler - Error Handling", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "", // Invalid empty query
    variables: {}
  };

  const context = {
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

  assertEquals(response.data, undefined);
  assertEquals(Array.isArray(response.errors), true);
  assertEquals(response.errors!.length > 0, true);
});
