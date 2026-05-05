/**
 * Tests for passwordless magic-link login.
 * (gh/geldata#8186)
 */

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { AuthError, AuthErrorCode } from "./types.ts";
import { generateTOTP } from "./totp.ts";

async function makeProvider(): Promise<{
  provider: AuthProvider;
  db: TestDatabase;
}> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false,
    },
    db,
  );
  await provider.initialize();
  return { provider, db };
}

// ── Request ──────────────────────────────────────────────────────────

Deno.test("requestMagicLink — returns a plaintext token for a real user", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const token = await provider.requestMagicLink("u@example.com");
    assert(token.length > 0);
  } finally {
    await db.close();
  }
});

Deno.test("requestMagicLink — anti-enumeration: unknown email still returns a token (unusable)", async () => {
  const { provider, db } = await makeProvider();
  try {
    const token = await provider.requestMagicLink("nobody@example.com");
    // Token is returned for response-shape parity but isn't persisted.
    assert(token.length > 0);

    // Trying to redeem it must fail just like a totally invented token.
    const err = await assertRejects(
      () => provider.consumeMagicLink(token),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("requestMagicLink — anonymous identities don't get a magic link", async () => {
  const { provider, db } = await makeProvider();
  try {
    const guest = await provider.loginAnonymous();
    const token = await provider.requestMagicLink(guest.user.email);
    // Same anti-enumeration shape — token returned but not persisted.
    const err = await assertRejects(
      () => provider.consumeMagicLink(token),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("requestMagicLink — inactive user gets the same anti-enumeration treatment", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    // Mark user inactive directly via test DB (no public API for this in tests)
    await db.execute("UPDATE users SET active = ? WHERE id = ?", [
      false,
      auth.user.id,
    ]);
    const token = await provider.requestMagicLink("u@example.com");
    const err = await assertRejects(
      () => provider.consumeMagicLink(token),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

// ── Consume ──────────────────────────────────────────────────────────

Deno.test("consumeMagicLink — completes login and returns AuthResponse", async () => {
  const { provider, db } = await makeProvider();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const token = await provider.requestMagicLink("u@example.com");
    const result = await provider.consumeMagicLink(token);
    assert(!("mfaRequired" in result));
    if (!("mfaRequired" in result)) {
      assertEquals(result.user.id, reg.user.id);
      assert(result.token);
    }
  } finally {
    await db.close();
  }
});

Deno.test("consumeMagicLink — single-use: a consumed link cannot be replayed", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const token = await provider.requestMagicLink("u@example.com");
    await provider.consumeMagicLink(token);

    const err = await assertRejects(
      () => provider.consumeMagicLink(token),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("consumeMagicLink — rejects unknown token", async () => {
  const { provider, db } = await makeProvider();
  try {
    const err = await assertRejects(
      () => provider.consumeMagicLink("ghost-magic-token-xxx"),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

// ── Interaction with TOTP MFA ────────────────────────────────────────

Deno.test("consumeMagicLink — when user has TOTP, returns MfaChallenge instead of session", async () => {
  const { provider, db } = await makeProvider();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    // Enroll + confirm TOTP so subsequent logins gate on it.
    const enrollment = await provider.enrollTOTP(reg.user.id);
    const code = await generateTOTP(enrollment.secret);
    await provider.confirmTOTP(reg.user.id, code);

    const token = await provider.requestMagicLink("u@example.com");
    const result = await provider.consumeMagicLink(token);
    assert("mfaRequired" in result);
    if ("mfaRequired" in result) {
      assertEquals(result.mfaRequired, true);
      assertEquals(result.factors, ["totp"]);
    }

    // Token already consumed even though we got a challenge — must not
    // be replayable.
    const err = await assertRejects(
      () => provider.consumeMagicLink(token),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});
