/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL Integration Tests for OAuth Extension
 *
 * Tests the OAuth extension's database setup (table creation, data insertion,
 * teardown) against a real PostgreSQL instance.
 *
 * Requires a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable these tests.
 */

import { assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import {
  canRunPgTests,
  getTestDsn,
  resetTestDatabase
} from "../tests/pg-test-harness.ts";
import { OAuthExtension } from "./extension.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

/** A minimal OAuth config sufficient to construct an OAuthExtension. */
function makeOAuthExt(): OAuthExtension {
  return new OAuthExtension({
    providers: [
      {
        name: "github",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userInfoUrl: "https://api.github.com/user",
        scopes: ["read:user", "user:email"]
      }
    ]
  });
}

// ---------------------------------------------------------------------------
// Test 1: Create OAuth tables and verify they exist in information_schema
// ---------------------------------------------------------------------------

Deno.test({
  name: "OAuth PG - getDatabaseSetup() creates both OAuth tables",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = makeOAuthExt();
      const setup = ext.getDatabaseSetup();

      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      // Verify both tables exist via information_schema
      const result = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('disc_oauth_states', 'disc_oauth_identities')
        ORDER BY table_name
      `);

      assertEquals(result.rows.length, 2);
      assertEquals(
        String(result.rows[0]["table_name"]),
        "disc_oauth_identities"
      );
      assertEquals(String(result.rows[1]["table_name"]), "disc_oauth_states");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: Insert and read back a row from disc_oauth_states
// ---------------------------------------------------------------------------

Deno.test({
  name: "OAuth PG - insert and read back OAuth state row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = makeOAuthExt();
      const setup = ext.getDatabaseSetup();

      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      const testState = "test-state-abc123";
      const testProvider = "github";
      const testRedirectUri = "https://example.com/callback";
      const expiresAt = new Date(Date.now() + 600_000).toISOString();

      await pool.query(
        `INSERT INTO disc_oauth_states
           (state, provider, redirect_uri, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [testState, testProvider, testRedirectUri, expiresAt]
      );

      const result = await pool.query(
        "SELECT state, provider, redirect_uri FROM disc_oauth_states WHERE state = $1",
        [testState]
      );

      assertEquals(result.rows.length, 1);
      assertEquals(String(result.rows[0]["state"]), testState);
      assertEquals(String(result.rows[0]["provider"]), testProvider);
      assertEquals(String(result.rows[0]["redirect_uri"]), testRedirectUri);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3: Insert and read back a row from disc_oauth_identities
// ---------------------------------------------------------------------------

Deno.test({
  name: "OAuth PG - insert and read back OAuth identity row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = makeOAuthExt();
      const setup = ext.getDatabaseSetup();

      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      const userId = "00000000-0000-0000-0000-000000000001";
      const provider = "github";
      const providerUserId = "gh-user-42";
      const email = "user@example.com";
      const name = "Test User";

      await pool.query(
        `INSERT INTO disc_oauth_identities
           (user_id, provider, provider_user_id, email, name)
         VALUES ($1::uuid, $2, $3, $4, $5)`,
        [userId, provider, providerUserId, email, name]
      );

      const result = await pool.query(
        `SELECT user_id::text, provider, provider_user_id, email, name
         FROM disc_oauth_identities
         WHERE provider = $1 AND provider_user_id = $2`,
        [provider, providerUserId]
      );

      assertEquals(result.rows.length, 1);
      assertEquals(String(result.rows[0]["user_id"]), userId);
      assertEquals(String(result.rows[0]["provider"]), provider);
      assertEquals(
        String(result.rows[0]["provider_user_id"]),
        providerUserId
      );
      assertEquals(String(result.rows[0]["email"]), email);
      assertEquals(String(result.rows[0]["name"]), name);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: Teardown SQL drops both tables
// ---------------------------------------------------------------------------

Deno.test({
  name: "OAuth PG - teardownSql removes both OAuth tables",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = makeOAuthExt();
      const setup = ext.getDatabaseSetup();

      // Create tables
      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      // Verify they exist
      const before = await pool.query(`
        SELECT COUNT(*)::integer AS cnt
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('disc_oauth_states', 'disc_oauth_identities')
      `);
      assertEquals(Number(before.rows[0]["cnt"]), 2);

      // Run teardown
      if (setup.teardownSql) {
        for (const sql of setup.teardownSql) {
          await pool.query(sql);
        }
      }

      // Verify both tables are gone
      const after = await pool.query(`
        SELECT COUNT(*)::integer AS cnt
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('disc_oauth_states', 'disc_oauth_identities')
      `);
      assertEquals(Number(after.rows[0]["cnt"]), 0);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});
