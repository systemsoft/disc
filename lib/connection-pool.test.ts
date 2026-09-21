/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Database Connection Pool
 */

import {
  assertEquals,
  assertExists,
  assertRejects
} from "@std/assert";
import { ConnectionPool, PoolConfig } from "./connection-pool.ts";
import { DatabaseConnection } from "./database.ts";

Deno.test("ConnectionPool - creates pool with default config", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test"
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
    maxWaitQueueSize: 100
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
    maxConnections: 10
  });

  // Mock connect method for testing
  const originalConnect = DatabaseConnection.prototype.connect;
  let connectCount = 0;
  DatabaseConnection.prototype.connect = function() {
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

Deno.test("ConnectionPool - initialize is idempotent (no duplicate connections or timers)", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 2,
    maxConnections: 10
  });

  const originalConnect = DatabaseConnection.prototype.connect;
  let connectCount = 0;
  DatabaseConnection.prototype.connect = function() {
    connectCount++;
    return Promise.resolve();
  };

  try {
    await pool.initialize();
    await pool.initialize(); // second call must be a no-op
    await pool.initialize(); // and a third
    // Would-be duplicate connections and timers are the reason disc migrate
    // used to hang on exit (cleanupIntervalId leak).
    assertEquals(connectCount, 2);
    assertEquals(pool.getPoolSize(), 2);
  } finally {
    DatabaseConnection.prototype.connect = originalConnect;
    await pool.close();
  }
});

Deno.test("ConnectionPool - acquires and releases connections", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5
  });

  // Mock connect method
  DatabaseConnection.prototype.connect = function() {
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
    connectionTimeout: 100 // Short timeout for testing
  });

  DatabaseConnection.prototype.connect = function() {
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
    "Connection pool timeout"
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
    retryDelay: 100
  });

  let connectAttempts = 0;
  DatabaseConnection.prototype.connect = function() {
    connectAttempts++;
    return Promise.reject(new Error("Connection failed"));
  };

  await assertRejects(
    async () => {
      await pool.acquire();
    },
    Error,
    "Failed to create connection after"
  );

  assertEquals(connectAttempts, 1); // maxRetries is 1, so only 1 attempt
  await pool.close();
});

Deno.test("ConnectionPool - validates connections before returning", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 1,
    maxConnections: 5,
    validateOnAcquire: true
  });

  let validateCalled = false;
  DatabaseConnection.prototype.connect = function() {
    return Promise.resolve();
  };

  // Mock query method for validation
  DatabaseConnection.prototype.query = function(sql: string) {
    if (sql === "SELECT 1") {
      validateCalled = true;
      return Promise.resolve({ rows: [{ "?column?": 1 }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
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
    idleTimeout: 100 // 100ms for testing
  });

  DatabaseConnection.prototype.connect = function() {
    return Promise.resolve();
  };

  await pool.initialize();

  const conn = await pool.acquire();
  assertEquals(pool.getPoolSize(), 1);

  pool.release(conn);
  assertEquals(pool.getIdleConnections(), 1);

  // Wait for idle timeout
  await new Promise(resolve => setTimeout(resolve, 150));

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
    maxConnections: 10
  });

  DatabaseConnection.prototype.connect = async function() {
    await new Promise(resolve => setTimeout(resolve, 10)); // Simulate connection delay
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
  connections.forEach(conn => pool.release(conn));

  assertEquals(pool.getActiveConnections(), 0);
  assertEquals(pool.getIdleConnections(), 5);

  await pool.close();
});

Deno.test("ConnectionPool - queues requests when pool is full", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    minConnections: 0,
    maxConnections: 2,
    maxWaitQueueSize: 10
  });

  DatabaseConnection.prototype.connect = function() {
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
    connectionTimeout: 100
  });

  DatabaseConnection.prototype.connect = function() {
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
    "Connection pool wait queue is full"
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
    maxConnections: 5
  });

  DatabaseConnection.prototype.connect = function() {
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
    maxConnections: 5
  });

  DatabaseConnection.prototype.connect = function() {
    return Promise.resolve();
  };

  DatabaseConnection.prototype.query = function(
    sql: string,
    params?: any[]
  ) {
    if (sql === "SELECT $1::text") {
      return Promise.resolve({ rows: [{ text: params?.[0] }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
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
    maxConnections: 5
  });

  let transactionStarted = false;
  let transactionCommitted = false;

  DatabaseConnection.prototype.connect = function() {
    return Promise.resolve();
  };

  DatabaseConnection.prototype.execute = function(sql: string) {
    if (sql === "BEGIN") {
      transactionStarted = true;
    }
    if (sql === "COMMIT") {
      transactionCommitted = true;
    }
    return Promise.resolve();
  };

  await pool.initialize();

  const result = await pool.transaction(_conn => {
    assertEquals(transactionStarted, true);
    return Promise.resolve("success");
  });

  assertEquals(result, "success");
  assertEquals(transactionCommitted, true);

  await pool.close();
});

/*** S15 — the cap under concurrent acquire. A creation in flight holds a slot, so callers
     beyond the cap queue; every event that frees capacity has to wake a queued caller. ***/

interface PoolMocks {
  connectCalls: number;
  /** Highest number of connections open or being opened at the same time. */
  peak: number;
  restore: () => void;
}

/** `connect(call)` decides each attempt's fate; opened/closed connections are counted for `peak`. */
function mockConnections(connect: (call: number) => Promise<void>, closeDelay = 0): PoolMocks {
  const originalConnect = DatabaseConnection.prototype.connect;
  const originalClose = DatabaseConnection.prototype.close;
  let open = 0;
  const mocks: PoolMocks = {
    connectCalls: 0,
    peak: 0,
    restore: () => {
      DatabaseConnection.prototype.connect = originalConnect;
      DatabaseConnection.prototype.close = originalClose;
    }
  };

  DatabaseConnection.prototype.connect = async function() {
    mocks.connectCalls++;
    open++;
    mocks.peak = Math.max(mocks.peak, open);

    try {
      await connect(mocks.connectCalls);
    } catch (error) {
      open--;
      throw error;
    }
  };

  DatabaseConnection.prototype.close = async function() {
    if (closeDelay > 0) {
      await sleep(closeDelay);
    }

    open--;
  };

  return mocks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fails fast instead of waiting out `connectionTimeout` when a caller is stranded. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timerId = setTimeout(() => reject(new Error(`${what} was not settled within ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timerId);
  }
}

/** Settles to the connection or to the error message, so a rejection is never unhandled. */
function settled(promise: Promise<DatabaseConnection>): Promise<DatabaseConnection | string> {
  return promise.then(conn => conn, (error: Error) => error.message);
}

Deno.test("ConnectionPool - concurrent acquires open exactly maxConnections; the rest are served FIFO by releases", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 3,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(() => sleep(10));

  try {
    const served: number[] = [];
    const held: DatabaseConnection[] = [];
    const acquires = Array.from({ length: 8 }, (_unused, index) =>
      pool.acquire().then(conn => {
        served.push(index);
        held.push(conn);
      }));

    // Queued synchronously: the three creations in flight already hold every slot.
    assertEquals(pool.getWaitQueueSize(), 5);

    await sleep(50);
    assertEquals(mocks.connectCalls, 3);
    assertEquals(pool.getPoolSize(), 3);
    assertEquals([...served].sort(), [0, 1, 2]);

    for (let next = 3; next < 8; next++) {
      pool.release(held.shift()!);
      await sleep(1);
      assertEquals(served.at(-1), next);
    }

    await within(Promise.all(acquires), 1000, "every acquire");
    assertEquals(mocks.connectCalls, 3);
    assertEquals(mocks.peak, 3);
    assertEquals(pool.getStatistics().totalCreated, 3);

    held.forEach(conn => pool.release(conn));
    assertEquals(pool.getIdleConnections(), 3);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - a caller queued behind a creation in flight is served by release", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 1,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(() => sleep(20));

  try {
    const first = pool.acquire();
    const second = pool.acquire();
    assertEquals(pool.getWaitQueueSize(), 1);

    const conn = await first;
    pool.release(conn);

    assertEquals(await within(second, 1000, "the queued caller"), conn);
    assertEquals(mocks.connectCalls, 1);
    assertEquals(pool.getActiveConnections(), 1);
    pool.release(conn);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - a failed creation hands its slot to the next queued caller", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 1,
    maxRetries: 1,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(async call => {
    await sleep(20);

    if (call === 1) {
      throw new Error("Connection failed");
    }
  });

  try {
    const first = settled(pool.acquire());
    const second = settled(pool.acquire());
    assertEquals(pool.getWaitQueueSize(), 1);

    assertEquals(await first, "Failed to create connection after 1 attempts: Error: Connection failed");

    const conn = await within(second, 1000, "the queued caller");
    assertEquals(typeof conn, "object");
    assertEquals(mocks.connectCalls, 2);
    assertEquals(mocks.peak, 1);
    assertEquals(pool.getPoolSize(), 1);
    pool.release(conn as DatabaseConnection);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - when every creation fails, each queued caller is rejected with the creation error", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 1,
    maxRetries: 1,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(async () => {
    await sleep(10);
    throw new Error("Connection failed");
  });

  try {
    const callers = [settled(pool.acquire()), settled(pool.acquire()), settled(pool.acquire())];
    assertEquals(pool.getWaitQueueSize(), 2);

    const outcomes = await within(Promise.all(callers), 1000, "every caller");
    assertEquals(outcomes, Array(3).fill("Failed to create connection after 1 attempts: Error: Connection failed"));
    assertEquals(mocks.peak, 1);
    assertEquals(pool.getWaitQueueSize(), 0);
    assertEquals(pool.getPoolSize(), 0);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - a creation that makes no attempt fails the caller instead of parking it", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 1,
    maxRetries: 0,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(() => Promise.resolve());

  try {
    const callers = [settled(pool.acquire()), settled(pool.acquire())];
    const outcomes = await within(Promise.all(callers), 1000, "every caller");

    assertEquals(outcomes, Array(2).fill("Failed to create connection: no attempt was made (maxRetries < 1)"));
    assertEquals(mocks.connectCalls, 0);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - idle cleanup that frees a slot serves a caller queued meanwhile", async () => {
  const pool = new ConnectionPool({
    cleanupInterval: 0,
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    idleTimeout: 10,
    maxConnections: 1,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(() => Promise.resolve(), 30);

  try {
    const stale = await pool.acquire();
    pool.release(stale);
    await sleep(30);

    // The stale connection holds the only slot until its close() finishes.
    const cleanup = pool.cleanupIdleConnections();
    const caller = pool.acquire();
    assertEquals(pool.getWaitQueueSize(), 1);

    await cleanup;
    const conn = await within(caller, 1000, "the queued caller");
    assertEquals(conn === stale, false);
    assertEquals(mocks.connectCalls, 2);
    assertEquals(mocks.peak, 1);
    pool.release(conn);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - a connection destroyed by validation frees its slot without exceeding the cap", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 1,
    minConnections: 0,
    validateOnAcquire: true
  });
  const mocks = mockConnections(() => Promise.resolve());
  const originalQuery = DatabaseConnection.prototype.query;
  DatabaseConnection.prototype.query = async function() {
    await sleep(20);
    throw new Error("server closed the connection unexpectedly");
  };

  try {
    const stale = await pool.acquire();
    pool.release(stale);

    const served: DatabaseConnection[] = [];
    const take = (): Promise<void> =>
      pool.acquire().then(conn => {
        served.push(conn);
        pool.release(conn);
      });
    const callers = [take(), take()];
    assertEquals(pool.getWaitQueueSize(), 1);

    await within(Promise.all(callers), 1000, "both callers");
    assertEquals(served.includes(stale), false);
    assertEquals(mocks.peak, 1);
    assertEquals(pool.getPoolSize(), 1);
  } finally {
    DatabaseConnection.prototype.query = originalQuery;
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - a timed-out caller is skipped, by release and by a freed slot", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 200,
    maxConnections: 1,
    maxRetries: 1,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(async call => {
    if (call === 1) {
      await sleep(300);
      throw new Error("Connection failed");
    }
  });

  try {
    // Freed slot: the first creation fails at 300ms; by then the caller queued at 0ms has timed out.
    const failing = settled(pool.acquire());
    const expired = settled(pool.acquire());
    await sleep(150);
    const live = settled(pool.acquire());

    assertEquals(await expired, "Connection pool timeout");
    assertEquals(await failing, "Failed to create connection after 1 attempts: Error: Connection failed");
    const conn = await within(live, 1000, "the live caller") as DatabaseConnection;
    assertEquals(typeof conn, "object");
    assertEquals(mocks.connectCalls, 2);

    // Release: same order of events, with the connection held instead of being created.
    const expiredAgain = settled(pool.acquire());
    await sleep(150);
    const liveAgain = settled(pool.acquire());
    assertEquals(await expiredAgain, "Connection pool timeout");

    pool.release(conn);
    assertEquals(await within(liveAgain, 1000, "the live caller"), conn);
    assertEquals(mocks.connectCalls, 2);
    pool.release(conn);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - acquire during initialize is served from the pool being opened, not a connection of its own", async () => {
  const pool = new ConnectionPool({
    cleanupInterval: 0,
    connectionString: "postgresql://test@localhost/test",
    connectionTimeout: 5000,
    maxConnections: 2,
    minConnections: 2,
    validateOnAcquire: false
  });
  const mocks = mockConnections(() => sleep(20));

  try {
    const initialized = pool.initialize();
    const caller = pool.acquire();

    await initialized;
    const conn = await within(caller, 1000, "the caller queued during initialize");
    assertEquals(mocks.connectCalls, 2);
    assertEquals(mocks.peak, 2);
    assertEquals(pool.getPoolSize(), 2);
    pool.release(conn);
  } finally {
    mocks.restore();
    await pool.close();
  }
});

Deno.test("ConnectionPool - an idle connection is reused before a new one is opened", async () => {
  const pool = new ConnectionPool({
    connectionString: "postgresql://test@localhost/test",
    maxConnections: 5,
    minConnections: 0,
    validateOnAcquire: false
  });
  const mocks = mockConnections(() => Promise.resolve());

  try {
    const first = await pool.acquire();
    pool.release(first);

    const again = await pool.acquire();
    assertEquals(again, first);
    assertEquals(mocks.connectCalls, 1);

    // With the idle connection taken, a second caller opens its own; neither queues.
    const other = await pool.acquire();
    assertEquals(other === first, false);
    assertEquals(pool.getWaitQueueSize(), 0);
    assertEquals(pool.getStatistics().totalCreated, 2);

    pool.release(again);
    pool.release(other);
    assertEquals(pool.getIdleConnections(), 2);
  } finally {
    mocks.restore();
    await pool.close();
  }
});
