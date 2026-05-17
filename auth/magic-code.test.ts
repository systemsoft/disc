/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for passwordless magic-code login.
 * (gh/geldata#7367)
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthError, AuthErrorCode } from "./types.ts";
import { AuthProvider } from "./provider.ts";
import { generateTOTP } from "./totp.ts";
import { TestDatabase } from "./test-database.ts";

/*** RUNTIME ------------------------------------------ ***/

/*** Request ***/

Deno.test("requestMagicCode — returns a 6-digit zero-padded code for a real user", async () => {
  const { db, provider } = await makeProvider();

  try {
    await provider.register({ email: "u@example.com", password: "password123" });
    const code = await provider.requestMagicCode("u@example.com");
    assertEquals(code.length, 6);
    assert(/^\d{6}$/.test(code), `expected 6 digits, got ${code}`);
  } finally {
    await db.close();
  }
});

Deno.test("requestMagicCode — anti-enumeration: unknown email still returns a code (unusable)", async () => {
  const { db, provider } = await makeProvider();
  try {
    const code = await provider.requestMagicCode("nobody@example.com");
    assertEquals(code.length, 6);
    assert(/^\d{6}$/.test(code));

    const err = await assertRejects(() => provider.verifyMagicCode("nobody@example.com", code), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("requestMagicCode — anonymous identities don’t get a magic code", async () => {
  const { db, provider } = await makeProvider();

  try {
    const guest = await provider.loginAnonymous();
    const code = await provider.requestMagicCode(guest.user.email);
    const err = await assertRejects(() => provider.verifyMagicCode(guest.user.email, code), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

/*** Verify ***/

Deno.test("verifyMagicCode — completes login and returns AuthResponse", async () => {
  const { db, provider } = await makeProvider();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const code = await provider.requestMagicCode("u@example.com");
    const result = await provider.verifyMagicCode("u@example.com", code);
    assert(!("mfaRequired" in result));

    if (!("mfaRequired" in result)) {
      assertEquals(result.user.id, reg.user.id);
      assert(result.token);
    }
  } finally {
    await db.close();
  }
});

Deno.test("verifyMagicCode — wrong code throws INVALID_TOKEN and increments attempts", async () => {
  const { db, provider } = await makeProvider();

  try {
    await provider.register({ email: "u@example.com", password: "password123" });
    await provider.requestMagicCode("u@example.com");

    const err = await assertRejects(() => provider.verifyMagicCode("u@example.com", "000000"), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);

    const row = await db.query(`SELECT attempts FROM magic_code_tokens WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`);
    assertEquals(row.rows.length, 1);
    assertEquals(Number(row.rows[0].attempts), 1);
  } finally {
    await db.close();
  }
});

Deno.test("verifyMagicCode — 5 wrong attempts locks the row; correct code afterwards is rejected", async () => {
  const { db, provider } = await makeProvider();

  try {
    await provider.register({ email: "u@example.com", password: "password123" });
    const realCode = await provider.requestMagicCode("u@example.com");

    /*** Five wrong attempts. After the fifth the row is consumed. ***/
    for (let i = 0; i < 5; i++) {
      /*** Avoid the unlikely event that "000000" actually matches. ***/
      const guess = realCode === "000001" ? "000002" : "000001";
      await assertRejects(() => provider.verifyMagicCode("u@example.com", guess), AuthError);
    }

    /*** Now the real code should be rejected too — row is consumed. ***/
    const err = await assertRejects(() => provider.verifyMagicCode("u@example.com", realCode), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("verifyMagicCode — expired code throws TOKEN_EXPIRED", async () => {
  const { db, provider } = await makeProvider();

  try {
    await provider.register({ email: "u@example.com", password: "password123" });
    const code = await provider.requestMagicCode("u@example.com");

    /*** Hand-roll the row into the past. ***/
    await db.execute("UPDATE magic_code_tokens SET expires_at = ? WHERE consumed_at IS NULL", [new Date(Date.now() - 60_000).toISOString()]);

    const err = await assertRejects(() => provider.verifyMagicCode("u@example.com", code), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.TOKEN_EXPIRED);
  } finally {
    await db.close();
  }
});

Deno.test("verifyMagicCode — already-consumed code throws INVALID_TOKEN", async () => {
  const { db, provider } = await makeProvider();

  try {
    await provider.register({ email: "u@example.com", password: "password123" });
    const code = await provider.requestMagicCode("u@example.com");
    await provider.verifyMagicCode("u@example.com", code);

    const err = await assertRejects(() => provider.verifyMagicCode("u@example.com", code), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("verifyMagicCode — when user has TOTP, returns MfaChallenge and burns the code", async () => {
  const { db, provider } = await makeProvider();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const enrollment = await provider.enrollTOTP(reg.user.id);
    const totp = await generateTOTP(enrollment.secret);
    await provider.confirmTOTP(reg.user.id, totp);

    const code = await provider.requestMagicCode("u@example.com");
    const result = await provider.verifyMagicCode("u@example.com", code);
    assert("mfaRequired" in result);

    if ("mfaRequired" in result) {
      assertEquals(result.mfaRequired, true);
      assertEquals(result.factors, ["totp"]);
    }

    /*** Code must have been consumed even though we got a challenge — re-verifying must fail. ***/
    const err = await assertRejects(() => provider.verifyMagicCode("u@example.com", code), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

/*** Code generator distribution ***/

Deno.test("generateNumericCode — leading-digit distribution is roughly uniform across 10K samples", async () => {
  const { db, provider } = await makeProvider();

  try {
    /*** Reach into the generator via a public seam: requesting codes for a non-existent user still
         produces plaintext via the same path. ***/
    const buckets = new Array<number>(10).fill(0);
    const samples = 10_000;

    for (let i = 0; i < samples; i++) {
      const code = await provider.requestMagicCode("nobody@example.com");
      buckets[Number(code[0])] += 1;
    }

    const expected = samples / 10; /*** 1000 per bucket ***/
    const tolerance = expected * 0.2; /*** ±20% ***/

    for (let d = 0; d < 10; d++) {
      assert(Math.abs(buckets[d] - expected) < tolerance, `digit ${d} appeared ${buckets[d]} times; expected ~${expected} ± ${tolerance}`);
    }
  } finally {
    await db.close();
  }
});

/*** HELPER ------------------------------------------- ***/

async function makeProvider(): Promise<{ provider: AuthProvider; db: TestDatabase; }> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider({ jwtSecret: "test-secret-key-32-bytes-minimum-len", requireEmailVerification: false }, db);
  await provider.initialize();

  return { db, provider };
}
