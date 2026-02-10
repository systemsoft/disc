/**
 * Server types module tests
 */

import { assertEquals, assertExists } from "@std/assert";
import * as Types from "./types.ts";

Deno.test("ServerConfig - default structure", () => {
  const config: Types.ServerConfig = {
    host: "localhost",
    port: 5656,
    database_url: "postgresql://localhost:5432/disc_dev",
    enable_cors: true,
    enable_websockets: true,
    max_connections: 100,
    request_timeout: 30000,
  };

  assertEquals(config.host, "localhost");
  assertEquals(config.port, 5656);
  assertEquals(config.enable_cors, true);
  assertEquals(config.enable_websockets, true);
  assertEquals(config.max_connections, 100);
  assertEquals(config.request_timeout, 30000);
});

Deno.test("SessionContext - structure and lifecycle", () => {
  const session: Types.SessionContext = {
    session_id: "sess_123456",
    database: "disc_app",
    created_at: new Date("2024-01-01T00:00:00Z"),
    last_activity: new Date("2024-01-01T00:01:00Z"),
    variables: {
      user_id: "user_123",
      role: "admin",
    },
  };

  assertEquals(session.session_id, "sess_123456");
  assertEquals(session.database, "disc_app");
  assertEquals(session.variables.user_id, "user_123");
  assertEquals(session.variables.role, "admin");
  assertExists(session.created_at);
  assertExists(session.last_activity);
});

Deno.test("Connection - different types", () => {
  const httpConnection: Types.Connection = {
    id: "conn_001",
    type: "http",
    remote_addr: "192.168.1.100",
    created_at: new Date(),
    session: {
      session_id: "sess_001",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
  };

  const wsConnection: Types.Connection = {
    id: "conn_002",
    type: "websocket",
    remote_addr: "192.168.1.101",
    created_at: new Date(),
    session: {
      session_id: "sess_002",
      database: "test_db",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
  };

  assertEquals(httpConnection.type, "http");
  assertEquals(wsConnection.type, "websocket");
  assertEquals(httpConnection.remote_addr, "192.168.1.100");
  assertEquals(wsConnection.remote_addr, "192.168.1.101");
});

Deno.test("QueryRequest - structure validation", () => {
  const request: Types.QueryRequest = {
    query: "select User { name, email } filter .id = <uuid>$user_id",
    variables: {
      user_id: "550e8400-e29b-41d4-a716-446655440000",
    },
  };

  assertEquals(typeof request.query, "string");
  assertEquals(typeof request.variables, "object");
  assertEquals(request.variables!.user_id, "550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("QueryResponse - success case", () => {
  const response: Types.QueryResponse = {
    data: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Alice Smith",
        email: "alice@example.com",
      },
    ],
    extensions: {
      query_hash: "abc123def456",
      duration_ms: 42,
      cache_hit: false,
    },
  };

  assertEquals(Array.isArray(response.data), true);
  assertEquals(response.data?.[0].name, "Alice Smith");
  assertEquals(response.extensions?.duration_ms, 42);
  assertEquals(response.extensions?.cache_hit, false);
  assertEquals(response.errors, undefined);
});

Deno.test("QueryResponse - error case", () => {
  const response: Types.QueryResponse = {
    errors: [
      {
        message: "Type 'NonExistentType' does not exist",
        locations: [{ line: 1, column: 8 }],
        extensions: {
          code: "INVALID_TYPE_NAME",
          context: "select NonExistentType",
        },
      },
    ],
    extensions: {
      query_hash: "error123",
      duration_ms: 5,
      cache_hit: false,
    },
  };

  assertEquals(response.data, undefined);
  assertEquals(Array.isArray(response.errors), true);
  assertEquals(response.errors?.[0].extensions?.code, "INVALID_TYPE_NAME");
  assertEquals(response.errors?.[0].locations?.[0].line, 1);
});

Deno.test("QueryError - comprehensive structure", () => {
  const error: Types.QueryError = {
    message: "Constraint violation: duplicate key value",
    locations: [{ line: 1, column: 15 }],
    path: ["insert", "User"],
    extensions: {
      code: "CONSTRAINT_VIOLATION",
      constraint: "user_email_unique",
      table: "user",
      column: "email",
      value: "duplicate@example.com",
      hint: "Choose a different email address",
    },
  };

  assertEquals(error.message, "Constraint violation: duplicate key value");
  assertEquals(error.extensions?.code, "CONSTRAINT_VIOLATION");
  assertEquals(error.extensions?.constraint, "user_email_unique");
  assertEquals(error.extensions?.hint, "Choose a different email address");
});

Deno.test("Transaction - different isolation levels", () => {
  const readCommitted: Types.Transaction = {
    id: "tx_001",
    session_id: "sess_001",
    isolation_level: "read_committed",
    read_only: false,
    started_at: new Date(),
    statements: [],
  };

  const serializable: Types.Transaction = {
    id: "tx_002",
    session_id: "sess_001",
    isolation_level: "serializable",
    read_only: true,
    started_at: new Date(),
    statements: ["select User { name }"],
  };

  assertEquals(readCommitted.isolation_level, "read_committed");
  assertEquals(readCommitted.read_only, false);
  assertEquals(serializable.isolation_level, "serializable");
  assertEquals(serializable.read_only, true);
  assertEquals(serializable.statements.length, 1);
});

Deno.test("QueryContext - complete structure", () => {
  const context: Types.QueryContext = {
    session: {
      session_id: "sess_123",
      database: "app_db",
      created_at: new Date("2024-01-01T10:00:00Z"),
      last_activity: new Date("2024-01-01T10:05:00Z"),
      variables: {
        current_user: "user_456",
        tenant_id: "tenant_789",
      },
    },
    auth: {
      roles: ["user", "editor"],
      permissions: ["read", "write"],
    },
    request_id: "req_987654321",
    started_at: new Date("2024-01-01T10:05:00Z"),
  };

  assertEquals(context.session.session_id, "sess_123");
  assertEquals(context.auth.roles.length, 2);
  assertEquals(context.auth.permissions.includes("write"), true);
  assertEquals(context.request_id, "req_987654321");
  assertExists(context.started_at);
});

Deno.test("ServerStats - metrics structure", () => {
  const stats: Types.ServerStats = {
    connections: {
      active: 15,
      total: 150,
      http: 10,
      websocket: 5,
    },
    queries: {
      total: 1000,
      successful: 950,
      failed: 50,
      avg_duration_ms: 25.5,
    },
    transactions: {
      active: 2,
      committed: 800,
      rolled_back: 10,
    },
    memory_usage: {
      heap_used: 50000000,
      heap_total: 100000000,
      external: 5000000,
    },
    uptime_ms: 3600000,
  };

  assertEquals(stats.connections.active, 15);
  assertEquals(stats.connections.total, 150);
  assertEquals(stats.connections.http + stats.connections.websocket, stats.connections.active);
  assertEquals(stats.queries.avg_duration_ms, 25.5);
  assertEquals(stats.uptime_ms, 3600000);
});

Deno.test("AuthContext - roles and permissions", () => {
  const auth: Types.AuthContext = {
    roles: ["admin", "user", "moderator"],
    permissions: ["read", "write", "delete", "moderate"],
  };

  assertEquals(auth.roles.length, 3);
  assertEquals(auth.permissions.length, 4);
  assertEquals(auth.roles.includes("admin"), true);
  assertEquals(auth.permissions.includes("moderate"), true);
});

Deno.test("QueryRequest - empty variables", () => {
  const request: Types.QueryRequest = {
    query: "select User",
    variables: {},
  };

  assertEquals(request.query, "select User");
  assertEquals(Object.keys(request.variables!).length, 0);
});

Deno.test("QueryRequest - complex variables", () => {
  const request: Types.QueryRequest = {
    query: "insert User { name := <str>$name, age := <int32>$age, tags := <array<str>>$tags }",
    variables: {
      name: "John Doe",
      age: 30,
      tags: ["developer", "typescript", "deno"],
    },
  };

  assertEquals(request.variables!.name, "John Doe");
  assertEquals(request.variables!.age, 30);
  assertEquals(Array.isArray(request.variables!.tags), true);
  assertEquals(request.variables!.tags.length, 3);
});

Deno.test("SessionContext - variables type safety", () => {
  const session: Types.SessionContext = {
    session_id: "sess_types_test",
    database: "test_db",
    created_at: new Date(),
    last_activity: new Date(),
    variables: {
      stringVar: "hello",
      numberVar: 42,
      booleanVar: true,
      arrayVar: [1, 2, 3],
      objectVar: { nested: "value" },
    },
  };

  assertEquals(typeof session.variables.stringVar, "string");
  assertEquals(typeof session.variables.numberVar, "number");
  assertEquals(typeof session.variables.booleanVar, "boolean");
  assertEquals(Array.isArray(session.variables.arrayVar), true);
  assertEquals(typeof session.variables.objectVar, "object");
});

Deno.test("Transaction - statement tracking", () => {
  const transaction: Types.Transaction = {
    id: "tx_stmt_test",
    session_id: "sess_001",
    isolation_level: "read_committed",
    read_only: false,
    started_at: new Date(),
    statements: [
      "begin",
      "insert User { name := 'Alice' }",
      "select User { name } filter .name = 'Alice'",
      "commit",
    ],
  };

  assertEquals(transaction.statements.length, 4);
  assertEquals(transaction.statements[0], "begin");
  assertEquals(transaction.statements[3], "commit");
  assertEquals(transaction.statements[1].includes("insert"), true);
  assertEquals(transaction.statements[2].includes("select"), true);
});