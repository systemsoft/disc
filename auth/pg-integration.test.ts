/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Auth PostgreSQL Integration Tests
 *
 * Tests the full auth flow against a real PostgreSQL instance.
 * Skipped when no PG is available (same pattern as other PG tests).
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertExists, assertRejects } from "@std/assert";

/*** IMPORT ------------------------------------------- ***/

import { Client } from "@db/postgres";

/*** UTILITY ------------------------------------------ ***/

import { AuthError, requireAuthResponse } from "./types.ts";
import { AuthProvider } from "./provider.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { PgDatabaseAdapter } from "./pg-database-adapter.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      /*** Verify tables exist ***/
      const usersResult = await conn.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'users'");
      assertEquals(usersResult.rowCount, 1);

      const sessionsResult = await conn.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions'");
      assertEquals(sessionsResult.rowCount, 1);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: initialize() creates users and sessions tables",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      const response = await provider.register({
        email: "pgtest@example.com",
        password: "securepassword123",
        username: "pguser"
      });

      assertExists(response.token);
      assertExists(response.user);
      assertEquals(response.user.email, "pgtest@example.com");
      assertEquals(response.user.username, "pguser");

      /*** Verify in database ***/
      const usersResult = await conn.query("SELECT email, username FROM users WHERE email = $1", ["pgtest@example.com"]);
      assertEquals(usersResult.rowCount, 1);
      assertEquals(usersResult.rows[0].email, "pgtest@example.com");

      const sessionsResult = await conn.query("SELECT user_id FROM sessions WHERE user_id = $1", [response.user.id]);
      assertEquals(sessionsResult.rowCount, 1);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: register user populates tables",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      /*** Register ***/
      await provider.register({ email: "login-test@example.com", password: "mypassword123" });

      /*** Login ***/
      const loginResponse = requireAuthResponse(await provider.login({ email: "login-test@example.com", password: "mypassword123" }));

      assertExists(loginResponse.token);
      assertEquals(loginResponse.user.email, "login-test@example.com");
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: login with registered credentials",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      const registerResponse = await provider.register({ email: "jwt-test@example.com", password: "password123" });

      /*** Verify token ***/
      const payload = await provider.verifyToken(registerResponse.token);
      assertEquals(payload.email, "jwt-test@example.com");
      assertExists(payload.sub);
      assertExists(payload.exp);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: JWT token verification",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      const registerResponse = await provider.register({ email: "refresh-test@example.com", password: "password123" });
      assertExists(registerResponse.refreshToken);

      /*** Refresh ***/
      const refreshResponse = await provider.refresh(registerResponse.refreshToken!);

      assertExists(refreshResponse.token);
      assertExists(refreshResponse.refreshToken);
      assertEquals(refreshResponse.user.email, "refresh-test@example.com");

      /*** Old refresh token should be invalid (session revoked) ***/
      await assertRejects(() => provider.refresh(registerResponse.refreshToken!), AuthError);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  name: "PG Auth: token refresh flow",
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      const registerResponse = await provider.register({ email: "logout-test@example.com", password: "password123" });

      /*** Logout ***/
      await provider.logout(registerResponse.session.id);

      /*** Verify session is revoked in DB ***/
      const result = await conn.query("SELECT revoked FROM sessions WHERE id = $1", [registerResponse.session.id]);
      assertEquals(result.rowCount, 1);
      assertEquals(result.rows[0].revoked, true);

      /*** Token should fail verification (session revoked) ***/
      await assertRejects(() => provider.verifyToken(registerResponse.token), AuthError);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: logout invalidates session",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      /*** Register ***/
      await provider.register({ email: "reset-test@example.com", password: "oldpassword123" });

      /*** Request reset ***/
      const resetToken = await provider.resetPasswordRequest("reset-test@example.com");
      assertExists(resetToken);

      /*** Reset password ***/
      await provider.resetPassword(resetToken, "newpassword456");

      /*** Login with new password ***/
      const loginResponse = requireAuthResponse(await provider.login({ email: "reset-test@example.com", password: "newpassword456" }));
      assertExists(loginResponse.token);

      /*** Old password should fail ***/
      await assertRejects(() => provider.login({ email: "reset-test@example.com", password: "oldpassword123" }), AuthError);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: password reset flow",
  sanitizeOps: false,
  sanitizeResources: false
});

/*** gh/geldata#7103 — auth-extension cascade deletes. The Gel issue flagged "missing deletion
     policies in auth ext"; the analogue in Disc is the raw-SQL FK declarations on auth tables. Most
     tables already carried `ON DELETE CASCADE` (sessions, webauthn_credentials, recovery_codes,
     magic_link_tokens, magic_code_tokens, mfa_totp, mfa_challenges, user_roles); the gap was
     `webauthn_challenges` whose `user_id` column had no FK at all, leaving in-flight register
     challenges as orphans when their user was deleted.

     This test asserts the cascade now fires: a register-challenge bound to a user disappears when
     the user is deleted. (Login challenges with `user_id IS NULL` are unaffected — PG ignores null
     on the reference side.) ***/
Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      const registered = requireAuthResponse(await provider.register({ email: "cascade-test@example.com", password: "password123" }));
      const userId = registered.user.id;

      /*** Insert a register-challenge bound to the user. Mirrors what
           `auth/webauthn.ts:beginRegister` writes during a real ceremony. ***/
      await conn.query(
        `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
         VALUES ($1, $2, 'register', $3, NOW() + INTERVAL '5 minutes')`,
        ["c1", "challenge-bytes", userId]
      );

      /*** Sanity: the row landed. ***/
      const before = await conn.query("SELECT 1 FROM webauthn_challenges WHERE id = $1", ["c1"]);
      assertEquals(before.rowCount, 1);

      /*** Deleting the user must cascade the challenge. ***/
      await conn.query("DELETE FROM users WHERE id = $1", [userId]);

      const after = await conn.query("SELECT 1 FROM webauthn_challenges WHERE id = $1", ["c1"]);
      assertEquals(after.rowCount, 0);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: webauthn_challenges cascades on user delete (Bundle MM — gh/geldata#7103)",
  sanitizeOps: false,
  sanitizeResources: false
});

/*** HELPER ------------------------------------------- ***/

/** Drop auth tables for clean state */
async function cleanupAuthTables(dsn: string): Promise<void> {
  const url = new URL(dsn);

  const client = new Client({
    database: url.pathname.slice(1) || "disc_test",
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc"
  });

  try {
    await client.connect();
    await client.queryArray("DROP TABLE IF EXISTS sessions CASCADE");
    await client.queryArray("DROP TABLE IF EXISTS users CASCADE");
  } finally {
    await client.end();
  }
}

/*** Email identity — the case-insensitive unique index. The unit tests in
     `email-normalization.test.ts` run against the in-memory fake, which can
     only prove the provider asks the right questions. These prove PostgreSQL
     itself refuses the duplicate, which is the actual guarantee: a bug or a
     future code path that bypasses `register()` still cannot create a second
     account for one address. ***/

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" },
        adapter
      );
      await provider.initialize();

      const indexes = await conn.query(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'users'
            AND indexname IN ('users_email_lower_key', 'users_username_lower_key')
          ORDER BY indexname`
      );
      assertEquals(
        indexes.rows.map(r => r.indexname),
        ["users_email_lower_key", "users_username_lower_key"]
      );
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: initialize() creates the case-insensitive identity indexes",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" },
        adapter
      );
      await provider.initialize();
      await provider.register({
        email: "ada@example.com",
        password: "correct-horse-battery"
      });

      /*** Straight past the provider: even a raw INSERT cannot land a
           case-variant of an address that already exists. ***/
      await assertRejects(
        () =>
          conn.execute(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
            ["raw-1", "Ada@Example.com", "x"]
          ),
        Error
      );

      /*** A genuinely different address is still fine. ***/
      await conn.execute(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
        ["raw-2", "a.da@example.com", "x"]
      );

      const count = await conn.query("SELECT COUNT(*)::int AS cnt FROM users");
      assertEquals(count.rows[0].cnt, 2);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: the database rejects a case-variant duplicate email",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" },
        adapter
      );
      await provider.initialize();

      /*** Registering with one casing and logging in with another has to work
           end-to-end against real PostgreSQL, or the index would simply lock
           people out instead of unifying their account. ***/
      await provider.register({
        email: "Ada.Lovelace@Example.com",
        password: "correct-horse-battery"
      });

      const login = requireAuthResponse(
        await provider.login({
          email: "  ada.lovelace@example.com  ",
          password: "correct-horse-battery"
        })
      );
      assertExists(login.token);

      /*** The casing the user typed survives for display and delivery. ***/
      const stored = await conn.query("SELECT email FROM users");
      assertEquals(stored.rows[0].email, "Ada.Lovelace@Example.com");
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: login folds case and whitespace while stored casing survives",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider(
        { jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" },
        adapter
      );
      await provider.initialize();
      await provider.register({
        email: "ada@example.com",
        password: "correct-horse-battery",
        username: "AdaLovelace"
      });

      /*** Past the provider entirely: PostgreSQL itself refuses a
           case-variant of a username somebody already holds. ***/
      await assertRejects(
        () =>
          conn.execute(
            "INSERT INTO users (id, email, username, password_hash) VALUES ($1, $2, $3, $4)",
            ["raw-1", "billie@example.com", "adalovelace", "x"]
          ),
        Error
      );

      /*** Nullable column: many accounts may hold no username at once, since
           a unique index treats NULLs as distinct. ***/
      await conn.execute(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
        ["raw-2", "cher@example.com", "x"]
      );
      await conn.execute(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
        ["raw-3", "dana@example.com", "x"]
      );

      const login = requireAuthResponse(
        await provider.login({
          password: "correct-horse-battery",
          username: "  adalovelace  "
        })
      );
      assertExists(login.token);

      const stored = await conn.query(
        "SELECT username FROM users WHERE id != 'raw-2' AND id != 'raw-3'"
      );
      assertEquals(stored.rows[0].username, "AdaLovelace");
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: usernames are case-insensitive but still nullable",
  sanitizeOps: false,
  sanitizeResources: false
});

Deno.test({
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanupAuthTables(dsn);

    const conn = new DatabaseConnection(dsn);
    await conn.connect();
    const adapter = new PgDatabaseAdapter(conn);

    try {
      const provider = new AuthProvider({ jwtSecret: "pg-test-secret-must-be-at-least-32-bytes-long" }, adapter);
      await provider.initialize();

      const doomed = await provider.register({ email: "doomed@example.com", password: "securepassword123" });
      const kept = await provider.register({ email: "kept@example.com", password: "securepassword123" });
      await provider.createRole("pg-delete-user-role");
      await provider.assignRole(doomed.user.id, "pg-delete-user-role");
      await provider.enrollTOTP(doomed.user.id);

      await provider.deleteUser(doomed.user.id);

      for (const [table, column] of [["users", "id"], ["sessions", "user_id"], ["user_roles", "user_id"], ["mfa_totp", "user_id"]]) {
        const remaining = await conn.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [doomed.user.id]);
        assertEquals(remaining.rowCount, 0, `${table} rows should be gone`);
      }

      await assertRejects(() => provider.verifyToken(doomed.token), AuthError);

      /*** The other user is untouched. ***/
      assertEquals((await provider.verifyToken(kept.token)).sub, kept.user.id);

      /*** Deleting again is a 404, not a 500. ***/
      const error = await assertRejects(() => provider.deleteUser(doomed.user.id), AuthError);
      assertEquals(error.status_code, 404);
    } finally {
      await conn.close();
      await cleanupAuthTables(dsn);
    }
  },
  ignore: !canRunPgTests(),
  name: "PG Auth: deleteUser removes the user and their sessions, roles, and MFA",
  sanitizeOps: false,
  sanitizeResources: false
});
