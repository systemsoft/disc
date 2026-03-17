/**
 * Tests for Disc Server
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DiscServer } from "./server.ts";
import { EdgeQLProtocolHandler } from "./protocol.ts";
import {
  ConnectionManager,
  SessionManager,
  TransactionManager,
} from "./connection.ts";

Deno.test("Server Config - Default Values", () => {
  const server = new DiscServer();
  const config = server.get_config();

  assertEquals(config.host, "localhost");
  assertEquals(config.port, 5656);
  assertEquals(config.enable_cors, true);
  assertEquals(config.enable_websockets, true);
  assertEquals(config.max_connections, 100);
});

Deno.test("Server Config - Custom Values", () => {
  const server = new DiscServer({
    host: "0.0.0.0",
    port: 8080,
    enable_cors: false,
    max_connections: 50,
  });

  const config = server.get_config();

  assertEquals(config.host, "0.0.0.0");
  assertEquals(config.port, 8080);
  assertEquals(config.enable_cors, false);
  assertEquals(config.max_connections, 50);
});

Deno.test("Protocol Handler - Validate EdgeQL Request", () => {
  const handler = new EdgeQLProtocolHandler();

  // Valid request
  const valid_request = {
    query: "select User { name, email }",
    variables: {},
  };

  const valid_errors = handler.validate_request(valid_request);
  assertEquals(valid_errors.length, 0);

  // Invalid request - missing query
  const invalid_request = {
    query: "",
    variables: {},
  };

  const invalid_errors = handler.validate_request(invalid_request);
  assertEquals(invalid_errors.length > 0, true);
  assertStringIncludes(invalid_errors[0].message, "Query is required");
});

Deno.test("Protocol Handler - Query Too Large", () => {
  const handler = new EdgeQLProtocolHandler();

  const large_query = "select User { name }".repeat(10000); // > 100KB
  const request = {
    query: large_query,
    variables: {},
  };

  const errors = handler.validate_request(request);
  assertEquals(errors.length > 0, true);
  assertStringIncludes(errors[0].message, "Query too large");
});

Deno.test("Protocol Handler - Syntax Validation", () => {
  const handler = new EdgeQLProtocolHandler();

  // Unbalanced braces
  const unbalanced_request = {
    query: "select User { name, email",
    variables: {},
  };

  const errors = handler.validate_request(unbalanced_request);
  assertEquals(errors.length > 0, true);
  assertStringIncludes(errors[0].message, "Unbalanced braces");
});

Deno.test("Session Manager - Create and Retrieve Session", () => {
  const manager = new SessionManager();
  const session = manager.create_session("test_db");

  assertEquals(session.database, "test_db");
  assertEquals(typeof session.session_id, "string");
  assertEquals(session.variables, {});

  const retrieved = manager.get_session(session.session_id);
  assertEquals(retrieved?.session_id, session.session_id);
  assertEquals(retrieved?.database, "test_db");
});

Deno.test("Session Manager - Update Activity", async () => {
  const manager = new SessionManager();
  const session = manager.create_session("test_db");
  const original_time = session.last_activity;

  // Wait a bit and update activity
  await new Promise((resolve) => setTimeout(resolve, 10));
  manager.update_activity(session.session_id);

  const updated = manager.get_session(session.session_id);
  assertEquals(updated!.last_activity > original_time, true);
});

Deno.test("Session Manager - Close Session", () => {
  const manager = new SessionManager();

  const session = manager.create_session("test_db");
  assertEquals(manager.get_session(session.session_id) !== null, true);

  manager.close_session(session.session_id);
  assertEquals(manager.get_session(session.session_id), null);
});

Deno.test("Connection Manager - Create Connection", () => {
  const manager = new ConnectionManager();
  const connection = manager.create_connection("http", "127.0.0.1");

  assertEquals(connection.type, "http");
  assertEquals(connection.remote_addr, "127.0.0.1");
  assertEquals(typeof connection.id, "string");
  assertEquals(typeof connection.session.session_id, "string");
});

Deno.test("Connection Manager - Get Stats", () => {
  const manager = new ConnectionManager();

  manager.create_connection("http", "127.0.0.1");
  manager.create_connection("websocket", "127.0.0.1");
  manager.create_connection("http", "192.168.1.1");

  const stats = manager.get_stats();

  assertEquals(stats.active, 3);
  assertEquals(stats.total, 3);
  assertEquals(stats.http, 2);
  assertEquals(stats.websocket, 1);
});

Deno.test("Transaction Manager - Begin Transaction", () => {
  const manager = new TransactionManager();

  const transaction = manager.begin_transaction("session_001", {
    isolation_level: "serializable",
    read_only: true,
  });

  assertEquals(transaction.session_id, "session_001");
  assertEquals(transaction.isolation_level, "serializable");
  assertEquals(transaction.read_only, true);
  assertEquals(typeof transaction.id, "string");
  assertEquals(Array.isArray(transaction.statements), true);
});

Deno.test("Transaction Manager - Commit Transaction", async () => {
  const manager = new TransactionManager();
  const transaction = manager.begin_transaction("session_001");
  assertEquals(manager.get_transaction(transaction.id) !== null, true);

  await manager.commit_transaction(transaction.id);
  assertEquals(manager.get_transaction(transaction.id), null);
});

Deno.test("Transaction Manager - Rollback Transaction", async () => {
  const manager = new TransactionManager();
  const transaction = manager.begin_transaction("session_001");
  assertEquals(manager.get_transaction(transaction.id) !== null, true);

  await manager.rollback_transaction(transaction.id);
  assertEquals(manager.get_transaction(transaction.id), null);
});

Deno.test("Protocol Handler - Mock Query Execution", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "select User { name, email }",
    variables: {},
  };

  const context = {
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

  assertEquals(response.errors, undefined);
  assertEquals(Array.isArray(response.data), true);
  assertEquals(response.extensions?.duration_ms !== undefined, true);
  assertEquals(typeof response.extensions?.query_hash, "string");
});

Deno.test("Protocol Handler - Error Handling", async () => {
  const handler = new EdgeQLProtocolHandler();

  const request = {
    query: "", // Invalid empty query
    variables: {},
  };

  const context = {
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

  assertEquals(response.data, undefined);
  assertEquals(Array.isArray(response.errors), true);
  assertEquals(response.errors!.length > 0, true);
});
