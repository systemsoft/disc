/**
 * Tests for recovery codes (MFA bypass).
 * (gh/geldata#8186 Phase C)
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

async function setupTOTP(provider: AuthProvider): Promise<{
  userId: string;
  secret: string;
}> {
  const auth = await provider.register({
    email: "u@example.com",
    password: "password123",
  });
  const enrollment = await provider.enrollTOTP(auth.user.id);
  const code = await generateTOTP(enrollment.secret);
  await provider.confirmTOTP(auth.user.id, code);
  return { userId: auth.user.id, secret: enrollment.secret };
}

// ── Generate ─────────────────────────────────────────────────────────

Deno.test("generateRecoveryCodes — returns the requested count", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const codes = await provider.generateRecoveryCodes(auth.user.id, 5);
    assertEquals(codes.length, 5);
    for (const c of codes) {
      // XXXXX-XXXXX shape
      assert(/^[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}$/.test(c), c);
    }
  } finally {
    await db.close();
  }
});

Deno.test("generateRecoveryCodes — defaults to 8 codes", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const codes = await provider.generateRecoveryCodes(auth.user.id);
    assertEquals(codes.length, 8);
  } finally {
    await db.close();
  }
});

Deno.test("generateRecoveryCodes — regenerating invalidates the previous batch", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const first = await provider.generateRecoveryCodes(auth.user.id, 4);
    await provider.generateRecoveryCodes(auth.user.id, 4);

    // Old codes must no longer redeem.
    for (const code of first) {
      assertEquals(
        await provider.consumeRecoveryCode(auth.user.id, code),
        false,
      );
    }
    // recoveryCodesRemaining = 4 (the new batch, all unused)
    assertEquals(await provider.recoveryCodesRemaining(auth.user.id), 4);
  } finally {
    await db.close();
  }
});

Deno.test("generateRecoveryCodes — rejects unknown user", async () => {
  const { provider, db } = await makeProvider();
  try {
    const err = await assertRejects(
      () =>
        provider.generateRecoveryCodes(
          "00000000-0000-0000-0000-000000000000",
        ),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.USER_NOT_FOUND);
  } finally {
    await db.close();
  }
});

Deno.test("generateRecoveryCodes — rejects out-of-range count", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    await assertRejects(
      () => provider.generateRecoveryCodes(auth.user.id, 0),
      AuthError,
    );
    await assertRejects(
      () => provider.generateRecoveryCodes(auth.user.id, 100),
      AuthError,
    );
  } finally {
    await db.close();
  }
});

// ── Consume ──────────────────────────────────────────────────────────

Deno.test("consumeRecoveryCode — burns a valid code, rejects on replay", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const codes = await provider.generateRecoveryCodes(auth.user.id, 3);

    assertEquals(await provider.consumeRecoveryCode(auth.user.id, codes[0]), true);
    // Already burned
    assertEquals(await provider.consumeRecoveryCode(auth.user.id, codes[0]), false);
    assertEquals(await provider.recoveryCodesRemaining(auth.user.id), 2);
  } finally {
    await db.close();
  }
});

Deno.test("consumeRecoveryCode — accepts unformatted input (no dashes, mixed case)", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const [c] = await provider.generateRecoveryCodes(auth.user.id, 1);
    const munged = c.replace("-", "").toLowerCase();
    assertEquals(await provider.consumeRecoveryCode(auth.user.id, munged), true);
  } finally {
    await db.close();
  }
});

Deno.test("consumeRecoveryCode — rejects code from a different user", async () => {
  const { provider, db } = await makeProvider();
  try {
    const a = await provider.register({
      email: "a@example.com",
      password: "password123",
    });
    const b = await provider.register({
      email: "b@example.com",
      password: "password123",
    });
    const [aCode] = await provider.generateRecoveryCodes(a.user.id, 1);
    // User B trying to use A's code — must not work even though the
    // underlying hash exists.
    assertEquals(await provider.consumeRecoveryCode(b.user.id, aCode), false);
    // And A's code is still good (unused).
    assertEquals(await provider.consumeRecoveryCode(a.user.id, aCode), true);
  } finally {
    await db.close();
  }
});

Deno.test("consumeRecoveryCode — rejects garbage", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    assertEquals(
      await provider.consumeRecoveryCode(auth.user.id, "AAAAA-AAAAA"),
      false,
    );
    assertEquals(
      await provider.consumeRecoveryCode(auth.user.id, "definitely not a code"),
      false,
    );
  } finally {
    await db.close();
  }
});

// ── Login integration ────────────────────────────────────────────────

Deno.test("loginWithRecoveryCode — completes login when TOTP is enrolled", async () => {
  const { provider, db } = await makeProvider();
  try {
    const { userId } = await setupTOTP(provider);
    const codes = await provider.generateRecoveryCodes(userId, 3);

    const challenge = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    assert("mfaRequired" in challenge);
    if (!("mfaRequired" in challenge)) return;

    const auth = await provider.loginWithRecoveryCode(
      challenge.challengeToken,
      codes[0],
    );
    assert(auth.token);
    assertEquals(auth.user.id, userId);
    // Recovery code is burned after login.
    assertEquals(await provider.recoveryCodesRemaining(userId), 2);
  } finally {
    await db.close();
  }
});

Deno.test("loginWithRecoveryCode — wrong code rejects, challenge stays valid for retry", async () => {
  const { provider, db } = await makeProvider();
  try {
    const { userId } = await setupTOTP(provider);
    const codes = await provider.generateRecoveryCodes(userId, 1);

    const challenge = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    if (!("mfaRequired" in challenge)) return;

    const err = await assertRejects(
      () =>
        provider.loginWithRecoveryCode(
          challenge.challengeToken,
          "AAAAA-AAAAA",
        ),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_CREDENTIALS);

    // Real code on the same challenge still works.
    const auth = await provider.loginWithRecoveryCode(
      challenge.challengeToken,
      codes[0],
    );
    assertEquals(auth.user.id, userId);
  } finally {
    await db.close();
  }
});

Deno.test("loginWithRecoveryCode — single-use challenge: cannot replay after success", async () => {
  const { provider, db } = await makeProvider();
  try {
    const { userId } = await setupTOTP(provider);
    const codes = await provider.generateRecoveryCodes(userId, 2);

    const challenge = await provider.login({
      email: "u@example.com",
      password: "password123",
    });
    if (!("mfaRequired" in challenge)) return;

    await provider.loginWithRecoveryCode(challenge.challengeToken, codes[0]);

    const err = await assertRejects(
      () =>
        provider.loginWithRecoveryCode(challenge.challengeToken, codes[1]),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("loginWithRecoveryCode — rejects unknown challenge token", async () => {
  const { provider, db } = await makeProvider();
  try {
    const { userId } = await setupTOTP(provider);
    const codes = await provider.generateRecoveryCodes(userId, 1);
    const err = await assertRejects(
      () => provider.loginWithRecoveryCode("ghost-challenge-xxx", codes[0]),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});
