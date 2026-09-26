/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `AuthProvider.deleteUser` — removes an auth user and every row keyed
 * to them (sessions, roles, MFA, magic-link/code tokens, recovery
 * codes). Runs against the in-memory TestDatabase, which does not
 * enforce `ON DELETE CASCADE`, so these tests also pin that the
 * deletion is explicit rather than reliant on the backend’s FKs.
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthError, AuthErrorCode } from "./types.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("deleteUser — removes the user and every row keyed to them", async () => {
  const { db, provider } = await makeProvider();

  try {
    const doomed = await provider.register({ email: "doomed@example.com", password: "TestPass123!" });
    const userId = doomed.user.id;

    await provider.createRole("editor");
    await provider.assignRole(userId, "editor");
    await provider.enrollTOTP(userId);
    await provider.generateRecoveryCodes(userId, 2);
    await provider.requestMagicLink("doomed@example.com");
    await provider.requestMagicCode("doomed@example.com");

    for (const table of USER_TABLES)
      assertEquals((await countRows(db, table, userId)) > 0, true, `fixture should have a ${table} row`);

    await provider.deleteUser(userId);

    assertEquals((await db.query("SELECT id FROM users WHERE id = ?", [userId])).rows.length, 0);

    for (const table of USER_TABLES)
      assertEquals(await countRows(db, table, userId), 0, `${table} rows should be gone`);
  } finally {
    await db.close();
  }
});

Deno.test("deleteUser — leaves other users untouched", async () => {
  const { db, provider } = await makeProvider();

  try {
    const doomed = await provider.register({ email: "doomed@example.com", password: "TestPass123!" });
    const kept = await provider.register({ email: "kept@example.com", password: "TestPass123!" });

    await provider.deleteUser(doomed.user.id);

    assertEquals((await db.query("SELECT id FROM users WHERE id = ?", [kept.user.id])).rows.length, 1);
    assertEquals(await countRows(db, "sessions", kept.user.id), 1);
    /*** The surviving user’s session still verifies. ***/
    assertEquals((await provider.verifyToken(kept.token)).sub, kept.user.id);
  } finally {
    await db.close();
  }
});

Deno.test("deleteUser — the deleted user’s token no longer verifies", async () => {
  const { db, provider } = await makeProvider();

  try {
    const doomed = await provider.register({ email: "doomed@example.com", password: "TestPass123!" });

    await provider.deleteUser(doomed.user.id);

    const error = await assertRejects(() => provider.verifyToken(doomed.token), AuthError);
    assertEquals(error.code, AuthErrorCode.SESSION_EXPIRED);
  } finally {
    await db.close();
  }
});

Deno.test("deleteUser — unknown user throws USER_NOT_FOUND with status 404", async () => {
  const { db, provider } = await makeProvider();

  try {
    const error = await assertRejects(() => provider.deleteUser("no-such-user"), AuthError);
    assertEquals(error.code, AuthErrorCode.USER_NOT_FOUND);
    assertEquals(error.status_code, 404);
  } finally {
    await db.close();
  }
});

/*** HELPER ------------------------------------------- ***/

/*** Tables the fixture above populates for the doomed user. ***/
const USER_TABLES = [
  "magic_code_tokens",
  "magic_link_tokens",
  "mfa_totp",
  "recovery_codes",
  "sessions",
  "user_roles"
];

async function countRows(db: TestDatabase, table: string, userId: string): Promise<number> {
  return (await db.query(`SELECT user_id FROM ${table} WHERE user_id = ?`, [userId])).rows.length;
}

async function makeProvider(): Promise<{ db: TestDatabase; provider: AuthProvider; }> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider({ bcryptRounds: 4, jwtSecret: "test-secret-key-32-bytes-minimum-len", requireEmailVerification: false }, db);
  await provider.initialize();

  return { db, provider };
}
