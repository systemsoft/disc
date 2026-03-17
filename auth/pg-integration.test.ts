/**
 * Auth PostgreSQL Integration Tests
 *
 * Tests the full auth flow against a real PostgreSQL instance.
 * Skipped when no PG is available (same pattern as other PG tests).
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { PgDatabaseAdapter } from "./pg-database-adapter.ts";
import { AuthProvider } from "./provider.ts";
import { AuthError } from "./types.ts";

/** Drop auth tables for clean state */
async function cleanupAuthTables(dsn: string): Promise<void> {
  const url = new URL(dsn);
  const client = new Client({
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  });

  try {
    await client.connect();
    await client.queryArray("DROP TABLE IF EXISTS sessions CASCADE");
    await client.queryArray("DROP TABLE IF EXISTS users CASCADE");
  } finally {
    await client.end();
  }
}

Deno.test({
  name: "PG Auth: initialize() creates users and sessions tables",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      // Verify tables exist
      const usersResult = await conn.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'users'",
      );
      assertEquals(usersResult.rowCount, 1);

      const sessionsResult = await conn.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions'",
      );
      assertEquals(sessionsResult.rowCount, 1);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});

Deno.test({
  name: "PG Auth: register user populates tables",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      const response = await provider.register({
        email: "pgtest@example.com",
        password: "securepassword123",
        username: "pguser",
      });

      assertExists(response.token);
      assertExists(response.user);
      assertEquals(response.user.email, "pgtest@example.com");
      assertEquals(response.user.username, "pguser");

      // Verify in database
      const usersResult = await conn.query(
        "SELECT email, username FROM users WHERE email = $1",
        ["pgtest@example.com"],
      );
      assertEquals(usersResult.rowCount, 1);
      assertEquals(usersResult.rows[0].email, "pgtest@example.com");

      const sessionsResult = await conn.query(
        "SELECT user_id FROM sessions WHERE user_id = $1",
        [response.user.id],
      );
      assertEquals(sessionsResult.rowCount, 1);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});

Deno.test({
  name: "PG Auth: login with registered credentials",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      // Register
      await provider.register({
        email: "login-test@example.com",
        password: "mypassword123",
      });

      // Login
      const loginResponse = await provider.login({
        email: "login-test@example.com",
        password: "mypassword123",
      });

      assertExists(loginResponse.token);
      assertEquals(loginResponse.user.email, "login-test@example.com");
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});

Deno.test({
  name: "PG Auth: JWT token verification",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      const registerResponse = await provider.register({
        email: "jwt-test@example.com",
        password: "password123",
      });

      // Verify token
      const payload = await provider.verify_token(registerResponse.token);
      assertEquals(payload.email, "jwt-test@example.com");
      assertExists(payload.sub);
      assertExists(payload.exp);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});

Deno.test({
  name: "PG Auth: token refresh flow",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      const registerResponse = await provider.register({
        email: "refresh-test@example.com",
        password: "password123",
      });

      assertExists(registerResponse.refresh_token);

      // Refresh
      const refreshResponse = await provider.refresh(
        registerResponse.refresh_token!,
      );

      assertExists(refreshResponse.token);
      assertExists(refreshResponse.refresh_token);
      assertEquals(refreshResponse.user.email, "refresh-test@example.com");

      // Old refresh token should be invalid (session revoked)
      await assertRejects(
        () => provider.refresh(registerResponse.refresh_token!),
        AuthError,
      );
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});

Deno.test({
  name: "PG Auth: logout invalidates session",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      const registerResponse = await provider.register({
        email: "logout-test@example.com",
        password: "password123",
      });

      // Logout
      await provider.logout(registerResponse.session.id);

      // Verify session is revoked in DB
      const result = await conn.query(
        "SELECT revoked FROM sessions WHERE id = $1",
        [registerResponse.session.id],
      );
      assertEquals(result.rowCount, 1);
      assertEquals(result.rows[0].revoked, true);

      // Token should fail verification (session revoked)
      await assertRejects(
        () => provider.verify_token(registerResponse.token),
        AuthError,
      );
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});

Deno.test({
  name: "PG Auth: password reset flow",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwt_secret: "pg-test-secret" },
        adapter,
      );
      await provider.initialize();

      // Register
      await provider.register({
        email: "reset-test@example.com",
        password: "oldpassword123",
      });

      // Request reset
      const resetToken = await provider.reset_password_request(
        "reset-test@example.com",
      );
      assertExists(resetToken);

      // Reset password
      await provider.reset_password(resetToken, "newpassword456");

      // Login with new password
      const loginResponse = await provider.login({
        email: "reset-test@example.com",
        password: "newpassword456",
      });
      assertExists(loginResponse.token);

      // Old password should fail
      await assertRejects(
        () =>
          provider.login({
            email: "reset-test@example.com",
            password: "oldpassword123",
          }),
        AuthError,
      );
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
});
