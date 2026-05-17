/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Connection Pool Hardening (Stage 5)
 *
 * Covers:
 * - Updated default config values (minConnections=2, validateOnAcquire=true)
 * - Leak detection warning after timeout
 * - Exponential backoff timing verification
 * - isHealthy() returns correct state
 */

import { assertEquals, assertExists } from "@std/assert";
import { ConnectionPool } from "./connection-pool.ts";
import { DatabaseConnection } from "./database.ts";

// Helper to mock DatabaseConnection.prototype methods and restore them
function mockConnect(): () => void {
  const original = DatabaseConnection.prototype.connect;
  DatabaseConnection.prototype.connect = function() {
    return Promise.resolve();
  };
  return () => {
    DatabaseConnection.prototype.connect = original;
  };
}

// --- Default config tests ---

Deno.test(
  "ConnectionPool hardening - default minConnections is 2",
  async () => {
    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test"
    });

    assertEquals(pool.getMinConnections(), 2);
    await pool.close();
  }
);

Deno.test(
  "ConnectionPool hardening - default validateOnAcquire is true",
  async () => {
    // Create pool with defaults, then acquire. Validation should be called.
    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 1,
      maxConnections: 5
    });

    const restoreConnect = mockConnect();
    let validateCalled = false;

    const originalQuery = DatabaseConnection.prototype.query;
    DatabaseConnection.prototype.query = function(sql: string) {
      if (sql === "SELECT 1") {
        validateCalled = true;
        return Promise.resolve({ rows: [{ "?column?": 1 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    };

    try {
      await pool.initialize();
      const conn = await pool.acquire();
      // validateOnAcquire defaults to true, so validation query should fire
      // when re-acquiring an idle connection
      assertEquals(validateCalled, true);
      pool.release(conn);
    } finally {
      DatabaseConnection.prototype.query = originalQuery;
      restoreConnect();
      await pool.close();
    }
  }
);

// --- Leak detection tests ---

Deno.test(
  "ConnectionPool hardening - leak detection warns after timeout",
  async () => {
    const warnings: string[] = [];

    // Import logger and intercept warn calls
    const { logger } = await import("../postgres/logger.ts");
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (msg: string, ..._args: unknown[]) => {
      warnings.push(msg);
    };

    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 5,
      leakWarningTimeout: 50, // 50ms for fast test
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();
      const conn = await pool.acquire();
      assertExists(conn);

      // Wait for leak warning to fire
      await new Promise(resolve => setTimeout(resolve, 120));

      const leakWarning = warnings.find(w => w.includes("Potential connection leak detected"));
      assertExists(
        leakWarning,
        "Expected a leak warning to be logged"
      );

      pool.release(conn);
    } finally {
      logger.warn = originalWarn;
      restoreConnect();
      await pool.close();
    }
  }
);

Deno.test(
  "ConnectionPool hardening - leak detection does not warn if released in time",
  async () => {
    const warnings: string[] = [];

    const { logger } = await import("../postgres/logger.ts");
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (msg: string, ..._args: unknown[]) => {
      warnings.push(msg);
    };

    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 5,
      leakWarningTimeout: 200,
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();
      const conn = await pool.acquire();
      assertExists(conn);

      // Release quickly, well before the 200ms timeout
      pool.release(conn);

      // Wait past the timeout to make sure no warning fires
      await new Promise(resolve => setTimeout(resolve, 300));

      const leakWarning = warnings.find(w => w.includes("Potential connection leak detected"));
      assertEquals(
        leakWarning,
        undefined,
        "No leak warning should be logged when connection is released in time"
      );
    } finally {
      logger.warn = originalWarn;
      restoreConnect();
      await pool.close();
    }
  }
);

Deno.test(
  "ConnectionPool hardening - leak detection disabled when timeout is 0",
  async () => {
    const warnings: string[] = [];

    const { logger } = await import("../postgres/logger.ts");
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (msg: string, ..._args: unknown[]) => {
      warnings.push(msg);
    };

    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 5,
      leakWarningTimeout: 0, // disabled
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();
      const conn = await pool.acquire();

      // Wait a bit - no warning should fire because detection is disabled
      await new Promise(resolve => setTimeout(resolve, 100));

      const leakWarning = warnings.find(w => w.includes("Potential connection leak detected"));
      assertEquals(
        leakWarning,
        undefined,
        "No leak warning should fire when leakWarningTimeout is 0"
      );

      pool.release(conn);
    } finally {
      logger.warn = originalWarn;
      restoreConnect();
      await pool.close();
    }
  }
);

// --- Exponential backoff tests ---

Deno.test(
  "ConnectionPool hardening - exponential backoff timing",
  async () => {
    const delays: number[] = [];
    let attemptCount = 0;

    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 5,
      maxRetries: 4,
      retryDelay: 50, // 50ms base delay for fast test
      validateOnAcquire: false
    });

    // Mock connect to always fail and record timing
    const originalConnect = DatabaseConnection.prototype.connect;
    let lastAttemptTime = Date.now();

    DatabaseConnection.prototype.connect = function() {
      const now = Date.now();
      if (attemptCount > 0) {
        delays.push(now - lastAttemptTime);
      }
      lastAttemptTime = now;
      attemptCount++;
      return Promise.reject(new Error("Connection failed"));
    };

    try {
      try {
        await pool.acquire();
      } catch {
        // Expected to fail after all retries
      }

      assertEquals(attemptCount, 4, "Should attempt 4 times");
      assertEquals(delays.length, 3, "Should have 3 delay measurements");

      // Expected delays with baseDelay=50:
      // attempt 1->2: 50 * 2^0 = 50ms
      // attempt 2->3: 50 * 2^1 = 100ms
      // attempt 3->4: 50 * 2^2 = 200ms
      // Allow 30ms tolerance for timer imprecision
      const tolerance = 30;

      assertEquals(
        delays[0] >= 50 - tolerance,
        true,
        `First delay ${delays[0]}ms should be ~50ms`
      );
      assertEquals(
        delays[1] >= 100 - tolerance,
        true,
        `Second delay ${delays[1]}ms should be ~100ms`
      );
      assertEquals(
        delays[2] >= 200 - tolerance,
        true,
        `Third delay ${delays[2]}ms should be ~200ms`
      );

      // Verify exponential growth: each delay should be roughly 2x the previous
      assertEquals(
        delays[1] > delays[0],
        true,
        "Second delay should be longer than first"
      );
      assertEquals(
        delays[2] > delays[1],
        true,
        "Third delay should be longer than second"
      );
    } finally {
      DatabaseConnection.prototype.connect = originalConnect;
      await pool.close();
    }
  }
);

// --- isHealthy() tests ---

Deno.test(
  "ConnectionPool hardening - isHealthy returns true for healthy pool",
  async () => {
    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 5,
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();
      assertEquals(pool.isHealthy(), true);
    } finally {
      restoreConnect();
      await pool.close();
    }
  }
);

Deno.test(
  "ConnectionPool hardening - isHealthy returns false for closed pool",
  async () => {
    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 5,
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();
      assertEquals(pool.isHealthy(), true);

      await pool.close();
      assertEquals(pool.isHealthy(), false);
      assertEquals(pool.isClosed(), true);
    } finally {
      restoreConnect();
    }
  }
);

Deno.test(
  "ConnectionPool hardening - isHealthy returns true when connections available",
  async () => {
    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 2,
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();

      // Acquire one connection, pool still has capacity
      const conn = await pool.acquire();
      assertEquals(pool.isHealthy(), true);

      pool.release(conn);
    } finally {
      restoreConnect();
      await pool.close();
    }
  }
);

Deno.test(
  "ConnectionPool hardening - isHealthy returns false when saturated with waiters",
  async () => {
    const pool = new ConnectionPool({
      connectionString: "postgresql://test@localhost/test",
      minConnections: 0,
      maxConnections: 1,
      maxWaitQueueSize: 10,
      connectionTimeout: 500,
      validateOnAcquire: false
    });

    const restoreConnect = mockConnect();

    try {
      await pool.initialize();

      // Fill all connections
      const conn1 = await pool.acquire();
      assertEquals(pool.isHealthy(), true);

      // Start a waiter (don't await - it will queue)
      const waiterPromise = pool.acquire();

      // Give the event loop a tick so the waiter enters the queue
      await new Promise(resolve => setTimeout(resolve, 10));

      // Pool is at max connections with a waiter - should be unhealthy
      assertEquals(pool.isHealthy(), false);

      // Release to unblock the waiter
      pool.release(conn1);
      const conn2 = await waiterPromise;
      pool.release(conn2);
    } finally {
      restoreConnect();
      await pool.close();
    }
  }
);
