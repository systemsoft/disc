/**
 * Integration tests for TOTP MFA enrollment + login flow.
 * (gh/geldata#8186)
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
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
      jwtIssuer: "TestApp",
      requireEmailVerification: false,
    },
    db,
  );
  await provider.initialize();
  return { provider, db };
}

async function registerAndCode(
  provider: AuthProvider,
): Promise<{ userId: string; secret: string; firstCode: string }> {
  const auth = await provider.register({
    email: "u@example.com",
    password: "password123",
  });
  const enrollment = await provider.enrollTOTP(auth.user.id);
  const firstCode = await generateTOTP(enrollment.secret);
  await provider.confirmTOTP(auth.user.id, firstCode);
  return {
    userId: auth.user.id,
    secret: enrollment.secret,
    firstCode,
  };
}

// ── Enrollment ────────────────────────────────────────────────────────

Deno.test("enrollTOTP — returns secret + otpauth URI", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const enrollment = await provider.enrollTOTP(auth.user.id);
    assert(enrollment.secret.length > 0);
    assert(enrollment.otpauthUri.startsWith("otpauth://totp/"));
    assert(enrollment.otpauthUri.includes("issuer=TestApp"));
    assert(enrollment.otpauthUri.includes(enrollment.secret));
  } finally {
    await db.close();
  }
});

Deno.test("enrollTOTP — re-enrollment rotates the secret", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const a = await provider.enrollTOTP(auth.user.id);
    const b = await provider.enrollTOTP(auth.user.id);
    assert(a.secret !== b.secret);
  } finally {
    await db.close();
  }
});

Deno.test("confirmTOTP — accepts a valid code, rejects garbage", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const enrollment = await provider.enrollTOTP(auth.user.id);

    const err = await assertRejects(
      () => provider.confirmTOTP(auth.user.id, "000000"),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_CREDENTIALS);

    // Now confirm with a real code.
    const code = await generateTOTP(enrollment.secret);
    await provider.confirmTOTP(auth.user.id, code);
  } finally {
    await db.close();
  }
});

Deno.test("confirmTOTP — fails when not enrolled", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const err = await assertRejects(
      () => provider.confirmTOTP(auth.user.id, "123456"),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_OPERATION);
  } finally {
    await db.close();
  }
});

// ── Login flow with MFA ──────────────────────────────────────────────

Deno.test("login — when TOTP confirmed, returns MfaChallenge instead of session", async () => {
  const { provider, db } = await makeProvider();
  try {
    await registerAndCode(provider);
    const result = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    assert("mfaRequired" in result, "expected MFA challenge");
    if ("mfaRequired" in result) {
      assertEquals(result.mfaRequired, true);
      assert(result.challengeToken.length > 0);
      assertEquals(result.factors, ["totp"]);
    }
  } finally {
    await db.close();
  }
});

Deno.test("login — when TOTP enrolled but not confirmed, password alone still logs in", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    // Enroll but DO NOT confirm — pending enrollments must not gate login.
    await provider.enrollTOTP(auth.user.id);

    const result = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    assert(!("mfaRequired" in result));
    if (!("mfaRequired" in result)) {
      assert(result.token);
    }
  } finally {
    await db.close();
  }
});

Deno.test("loginWithTOTP — completes login with a valid code", async () => {
  const { provider, db } = await makeProvider();
  try {
    const enrolled = await registerAndCode(provider);
    const challenge = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    assert("mfaRequired" in challenge);
    if (!("mfaRequired" in challenge)) return;

    const code = await generateTOTP(enrolled.secret);
    const auth = await provider.loginWithTOTP(challenge.challengeToken, code);
    assert(auth.token);
    assertEquals(auth.user.id, enrolled.userId);
  } finally {
    await db.close();
  }
});

Deno.test("loginWithTOTP — rejects wrong code (challenge stays valid for retry)", async () => {
  const { provider, db } = await makeProvider();
  try {
    await registerAndCode(provider);
    const challenge = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    if (!("mfaRequired" in challenge)) return;

    const err = await assertRejects(
      () => provider.loginWithTOTP(challenge.challengeToken, "000000"),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_CREDENTIALS);
  } finally {
    await db.close();
  }
});

Deno.test("loginWithTOTP — rejects unknown challenge token", async () => {
  const { provider, db } = await makeProvider();
  try {
    await registerAndCode(provider);
    const err = await assertRejects(
      () => provider.loginWithTOTP("ghost-challenge-xxx", "123456"),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("loginWithTOTP — single-use: a consumed challenge cannot be replayed", async () => {
  const { provider, db } = await makeProvider();
  try {
    const enrolled = await registerAndCode(provider);
    const challenge = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    if (!("mfaRequired" in challenge)) return;

    const code = await generateTOTP(enrolled.secret);
    await provider.loginWithTOTP(challenge.challengeToken, code);

    const err = await assertRejects(
      () => provider.loginWithTOTP(challenge.challengeToken, code),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

// ── disable ──────────────────────────────────────────────────────────

Deno.test("disableTOTP — login no longer requires the second factor", async () => {
  const { provider, db } = await makeProvider();
  try {
    const enrolled = await registerAndCode(provider);

    // Sanity: still gates today
    const gated = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    assert("mfaRequired" in gated);

    await provider.disableTOTP(enrolled.userId);

    const open = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    assert(!("mfaRequired" in open));
  } finally {
    await db.close();
  }
});
