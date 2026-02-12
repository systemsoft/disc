/**
 * Tests for Database Connection Pool
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ConnectionPool, PoolConfig } from "./connection-pool.ts";
import { DatabaseConnection } from "./database.ts";

Deno.test("ConnectionPool - creates pool with default config", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
  });

  assertEquals(pool.getPoolSize(), 0);
  assertEquals(pool.getActiveConnections(), 0);
  assertEquals(pool.getIdleConnections(), 0);

  await pool.close();
});

Deno.test("ConnectionPool - creates pool with custom config", async () => {
  const config: PoolConfig = {
    connectionString: "postgresql://test@localhost/test",
    minConnections: 2,
    maxConnections: 10,
    connectionTimeout: 5000,
    idleTimeout: 30000,
    maxWaitQueueSize: 100,
  };

  const pool = new ConnectionPool(config);

  assertEquals(pool.getMaxConnections(), 10);
  assertEquals(pool.getMinConnections(), 2);

  await pool.close();
});

Deno.test("ConnectionPool - initializes minimum connections", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 3,
    maxConnections: 10,
  });

  // Mock connect method for testing
  const originalConnect = DatabaseConnection.prototype.connect;
  let connectCount = 0;
  DatabaseConnection.prototype.connect = async function () {
    connectCount++;
    return Promise.resolve();
  };

  try {
    await pool.initialize();
    assertEquals(connectCount, 3);
    assertEquals(pool.getPoolSize(), 3);
    assertEquals(pool.getIdleConnections(), 3);
    assertEquals(pool.getActiveConnections(), 0);
  } finally {
    DatabaseConnection.prototype.connect = originalConnect;
    await pool.close();
  }
});

Deno.test("ConnectionPool - acquires and releases connections", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5,
  });

  // Mock connect method
  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn1 = await pool.acquire();
  assertExists(conn1);
  assertEquals(pool.getActiveConnections(), 1);
  assertEquals(pool.getIdleConnections(), 0);

  const conn2 = await pool.acquire();
  assertExists(conn2);
  assertEquals(pool.getActiveConnections(), 2);
  assertEquals(pool.getIdleConnections(), 0);

  pool.release(conn1);
  assertEquals(pool.getActiveConnections(), 1);
  assertEquals(pool.getIdleConnections(), 1);

  pool.release(conn2);
  assertEquals(pool.getActiveConnections(), 0);
  assertEquals(pool.getIdleConnections(), 2);

  await pool.close();
});

Deno.test("ConnectionPool - respects max connections limit", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 0,
    maxConnections: 2,
    connectionTimeout: 100, // Short timeout for testing
  });

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();

  assertEquals(pool.getActiveConnections(), 2);
  assertEquals(pool.getPoolSize(), 2);

  // This should timeout since max connections reached
  await assertRejects(
    async () => {
      await pool.acquire();
    },
    Error,
    "Connection pool timeout",
  );

  pool.release(conn1);
  pool.release(conn2);
  await pool.close();
});

Deno.test("ConnectionPool - handles connection errors gracefully", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://invalid@localhost/test",
    minConnections: 0,
    maxConnections: 5,
    maxRetries: 1,
    retryDelay: 100,
  });

  let connectAttempts = 0;
  DatabaseConnection.prototype.connect = async function () {
    connectAttempts++;
    throw new Error("Connection failed");
  };

  await assertRejects(
    async () => {
      await pool.acquire();
    },
    Error,
    "Failed to create connection after",
  );

  assertEquals(connectAttempts, 1); // maxRetries is 1, so only 1 attempt
  await pool.close();
});

Deno.test("ConnectionPool - validates connections before returning", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5,
    validateOnAcquire: true,
  });

  let validateCalled = false;
  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  // Mock query method for validation
  DatabaseConnection.prototype.query = async function (sql: string) {
    if (sql === "SELECT 1") {
      validateCalled = true;
      return { rows: [{ "?column?": 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  await pool.initialize();
  const conn = await pool.acquire();

  assertEquals(validateCalled, true);

  pool.release(conn);
  await pool.close();
});

Deno.test("ConnectionPool - removes idle connections after timeout", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 0,
    maxConnections: 5,
    idleTimeout: 100, // 100ms for testing
  });

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn = await pool.acquire();
  assertEquals(pool.getPoolSize(), 1);

  pool.release(conn);
  assertEquals(pool.getIdleConnections(), 1);

  // Wait for idle timeout
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Cleanup should remove idle connection
  await pool.cleanupIdleConnections();
  assertEquals(pool.getIdleConnections(), 0);
  assertEquals(pool.getPoolSize(), 0);

  await pool.close();
});

Deno.test("ConnectionPool - handles concurrent acquisitions", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 0,
    maxConnections: 10,
  });

  DatabaseConnection.prototype.connect = async function () {
    await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate connection delay
    return Promise.resolve();
  };

  await pool.initialize();

  // Acquire 5 connections concurrently
  const promises = Array(5).fill(null).map(() => pool.acquire());
  const connections = await Promise.all(promises);

  assertEquals(connections.length, 5);
  assertEquals(pool.getActiveConnections(), 5);
  assertEquals(pool.getPoolSize(), 5);

  // Release all connections
  connections.forEach((conn) => pool.release(conn));

  assertEquals(pool.getActiveConnections(), 0);
  assertEquals(pool.getIdleConnections(), 5);

  await pool.close();
});

Deno.test("ConnectionPool - queues requests when pool is full", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 0,
    maxConnections: 2,
    maxWaitQueueSize: 10,
  });

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();

  // Start acquiring a third connection (will be queued)
  const conn3Promise = pool.acquire();

  assertEquals(pool.getWaitQueueSize(), 1);

  // Release one connection
  pool.release(conn1);

  // The queued request should now get a connection
  const conn3 = await conn3Promise;
  assertExists(conn3);
  assertEquals(pool.getWaitQueueSize(), 0);

  pool.release(conn2);
  pool.release(conn3);
  await pool.close();
});

Deno.test("ConnectionPool - rejects when wait queue is full", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 0,
    maxConnections: 1,
    maxWaitQueueSize: 1,
    connectionTimeout: 100,
  });

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn1 = await pool.acquire();

  // Start two more acquisitions (one queued, one rejected)
  const conn2Promise = pool.acquire();

  await assertRejects(
    async () => {
      await pool.acquire();
    },
    Error,
    "Connection pool wait queue is full",
  );

  pool.release(conn1);
  const conn2 = await conn2Promise;
  pool.release(conn2);
  await pool.close();
});

Deno.test("ConnectionPool - tracks statistics", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5,
  });

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();

  const stats = pool.getStatistics();
  assertEquals(stats.totalConnections, 2);
  assertEquals(stats.activeConnections, 2);
  assertEquals(stats.idleConnections, 0);
  assertEquals(stats.totalAcquired, 2);
  assertEquals(stats.totalReleased, 0);

  pool.release(conn1);

  const updatedStats = pool.getStatistics();
  assertEquals(updatedStats.activeConnections, 1);
  assertEquals(updatedStats.idleConnections, 1);
  assertEquals(updatedStats.totalReleased, 1);

  pool.release(conn2);
  await pool.close();
});

Deno.test("ConnectionPool - executes query through pool", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5,
  });

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  DatabaseConnection.prototype.query = async function (
    sql: string,
    params?: any[],
  ) {
    if (sql === "SELECT $1::text") {
      return { rows: [{ text: params?.[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  await pool.initialize();

  const result = await pool.query("SELECT $1::text", ["hello"]);
  assertEquals(result.rows[0].text, "hello");
  assertEquals(result.rowCount, 1);

  await pool.close();
});

Deno.test("ConnectionPool - executes transaction through pool", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5,
  });

  let transactionStarted = false;
  let transactionCommitted = false;

  DatabaseConnection.prototype.connect = async function () {
    return Promise.resolve();
  };

  DatabaseConnection.prototype.execute = async function (sql: string) {
    if (sql === "BEGIN") transactionStarted = true;
    if (sql === "COMMIT") transactionCommitted = true;
    return Promise.resolve();
  };

  await pool.initialize();

  const result = await pool.transaction(async (_conn) => {
    assertEquals(transactionStarted, true);
    return "success";
  });

  assertEquals(result, "success");
  assertEquals(transactionCommitted, true);

  await pool.close();
});
