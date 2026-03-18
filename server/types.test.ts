/**
 * Server types module tests
 */

import { assertEquals, assertExists } from "@std/assert";
import * as Types from "./types.ts";

Deno.test("ServerConfig - default structure", () => {
  const config: Types.ServerConfig = {
    host: "localhost",
    port: 5656,
    databaseUrl: "postgresql://localhost:5432/disc_dev",
    enableCors: true,
    enableWebsockets: true,
    maxConnections: 100,
    requestTimeout: 30000,
  };

  assertEquals(config.host, "localhost");
  assertEquals(config.port, 5656);
  assertEquals(config.enableCors, true);
  assertEquals(config.enableWebsockets, true);
  assertEquals(config.maxConnections, 100);
  assertEquals(config.requestTimeout, 30000);
});

Deno.test("SessionContext - structure and lifecycle", () => {
  const session: Types.SessionContext = {
    sessionId: "sess_123456",
    database: "disc_app",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    lastActivity: new Date("2024-01-01T00:01:00Z"),
    variables: {
      userId: "user_123",
      role: "admin",
    },
  };

  assertEquals(session.sessionId, "sess_123456");
  assertEquals(session.database, "disc_app");
  assertEquals(session.variables.userId, "user_123");
  assertEquals(session.variables.role, "admin");
  assertExists(session.createdAt);
  assertExists(session.lastActivity);
});

Deno.test("Connection - different types", () => {
  const httpConnection: Types.Connection = {
    id: "conn_001",
    type: "http",
    remoteAddr: "192.168.1.100",
    createdAt: new Date(),
    session: {
      sessionId: "sess_001",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {},
    },
  };

  const wsConnection: Types.Connection = {
    id: "conn_002",
    type: "websocket",
    remoteAddr: "192.168.1.101",
    createdAt: new Date(),
    session: {
      sessionId: "sess_002",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {},
    },
  };

  assertEquals(httpConnection.type, "http");
  assertEquals(wsConnection.type, "websocket");
  assertEquals(httpConnection.remoteAddr, "192.168.1.100");
  assertEquals(wsConnection.remoteAddr, "192.168.1.101");
});

Deno.test("QueryRequest - structure validation", () => {
  const request: Types.QueryRequest = {
    query: "select User { name, email } filter .id = <uuid>$userId",
    variables: {
      userId: "550e8400-e29b-41d4-a716-446655440000",
    },
  };

  assertEquals(typeof request.query, "string");
  assertEquals(typeof request.variables, "object");
  assertEquals(
    request.variables!.userId,
    "550e8400-e29b-41d4-a716-446655440000",
  );
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
      queryHash: "abc123def456",
      durationMs: 42,
      cacheHit: false,
    },
  };

  assertEquals(Array.isArray(response.data), true);
  assertEquals(response.data?.[0].name, "Alice Smith");
  assertEquals(response.extensions?.durationMs, 42);
  assertEquals(response.extensions?.cacheHit, false);
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
      queryHash: "error123",
      durationMs: 5,
      cacheHit: false,
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
    sessionId: "sess_001",
    isolationLevel: "read_committed",
    readOnly: false,
    startedAt: new Date(),
    statements: [],
  };

  const serializable: Types.Transaction = {
    id: "tx_002",
    sessionId: "sess_001",
    isolationLevel: "serializable",
    readOnly: true,
    startedAt: new Date(),
    statements: ["select User { name }"],
  };

  assertEquals(readCommitted.isolationLevel, "read_committed");
  assertEquals(readCommitted.readOnly, false);
  assertEquals(serializable.isolationLevel, "serializable");
  assertEquals(serializable.readOnly, true);
  assertEquals(serializable.statements.length, 1);
});

Deno.test("QueryContext - complete structure", () => {
  const context: Types.QueryContext = {
    session: {
      sessionId: "sess_123",
      database: "app_db",
      createdAt: new Date("2024-01-01T10:00:00Z"),
      lastActivity: new Date("2024-01-01T10:05:00Z"),
      variables: {
        current_user: "user_456",
        tenant_id: "tenant_789",
      },
    },
    auth: {
      roles: ["user", "editor"],
      permissions: ["read", "write"],
    },
    requestId: "req_987654321",
    startedAt: new Date("2024-01-01T10:05:00Z"),
  };

  assertEquals(context.session.sessionId, "sess_123");
  assertEquals(context.auth.roles.length, 2);
  assertEquals(context.auth.permissions.includes("write"), true);
  assertEquals(context.requestId, "req_987654321");
  assertExists(context.startedAt);
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
      avgDurationMs: 25.5,
    },
    transactions: {
      active: 2,
      committed: 800,
      rolledBack: 10,
    },
    memoryUsage: {
      heapUsed: 50000000,
      heapTotal: 100000000,
      external: 5000000,
    },
    uptimeMs: 3600000,
  };

  assertEquals(stats.connections.active, 15);
  assertEquals(stats.connections.total, 150);
  assertEquals(
    stats.connections.http + stats.connections.websocket,
    stats.connections.active,
  );
  assertEquals(stats.queries.avgDurationMs, 25.5);
  assertEquals(stats.uptimeMs, 3600000);
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
    query:
      "insert User { name := <str>$name, age := <int32>$age, tags := <array<str>>$tags }",
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
    sessionId: "sess_types_test",
    database: "test_db",
    createdAt: new Date(),
    lastActivity: new Date(),
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
    sessionId: "sess_001",
    isolationLevel: "read_committed",
    readOnly: false,
    startedAt: new Date(),
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
