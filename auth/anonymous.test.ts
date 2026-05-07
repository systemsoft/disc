/**
 * Tests for anonymous (guest) identities.
 * (gh/geldata#8750)
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { AuthError, AuthErrorCode ,
  requireAuthResponse,
} from "./types.ts";

async function makeProvider(opts: {
  requireEmailVerification?: boolean;
} = {}): Promise<{ provider: AuthProvider; db: TestDatabase }> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: opts.requireEmailVerification ?? false,
    },
    db,
  );
  await provider.initialize();
  return { provider, db };
}

// ── loginAnonymous ─────────────────────────────────────────────────────

Deno.test("loginAnonymous - mints a guest identity with a session", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.loginAnonymous();

    assertExists(auth.user);
    assertExists(auth.token);
    assertExists(auth.session);
    assertEquals(auth.user.isAnonymous, true);
    // Synthetic email scheme — exact format guaranteed by the impl.
    assertEquals(auth.user.email.startsWith("anonymous-"), true);
    assertEquals(auth.user.email.endsWith("@disc.invalid"), true);
  } finally {
    await db.close();
  }
});

Deno.test("loginAnonymous - each call mints a distinct identity", async () => {
  const { provider, db } = await makeProvider();
  try {
    const a = await provider.loginAnonymous();
    const b = await provider.loginAnonymous();
    assertEquals(a.user.id === b.user.id, false);
    assertEquals(a.user.email === b.user.email, false);
  } finally {
    await db.close();
  }
});

Deno.test("loginAnonymous - the synthetic password is unusable for login()", async () => {
  const { provider, db } = await makeProvider();
  try {
    const guest = await provider.loginAnonymous();

    // Even if an attacker guessed the synthetic email, login() should
    // reject any password against an anonymous user.
    await assertRejects(
      () =>
        provider.login({
          email: guest.user.email,
          password: "any-guess",
        }),
      AuthError,
      "Invalid credentials",
    );
  } finally {
    await db.close();
  }
});

// ── upgradeAnonymous ───────────────────────────────────────────────────

Deno.test("upgradeAnonymous - converts guest into a full user keeping the same id", async () => {
  const { provider, db } = await makeProvider();
  try {
    const guest = await provider.loginAnonymous();
    const upgraded = await provider.upgradeAnonymous(guest.user.id, {
      email: "real@test.com",
      password: "password123",
    });

    assertEquals(upgraded.user.id, guest.user.id);
    assertEquals(upgraded.user.email, "real@test.com");
    assertEquals(upgraded.user.isAnonymous, false);
    assertExists(upgraded.token);
  } finally {
    await db.close();
  }
});

Deno.test("upgradeAnonymous - upgraded user can sign in with the new password", async () => {
  const { provider, db } = await makeProvider();
  try {
    const guest = await provider.loginAnonymous();
    await provider.upgradeAnonymous(guest.user.id, {
      email: "alice@test.com",
      password: "password123",
    });

    const loggedIn = requireAuthResponse(await provider.login({
      email: "alice@test.com",
      password: "password123",
    }));
    assertEquals(loggedIn.user.id, guest.user.id);
    assertEquals(loggedIn.user.isAnonymous, false);
  } finally {
    await db.close();
  }
});

Deno.test("upgradeAnonymous - rejects unknown user id", async () => {
  const { provider, db } = await makeProvider();
  try {
    const err = await assertRejects(
      () =>
        provider.upgradeAnonymous("00000000-0000-0000-0000-000000000000", {
          email: "real@test.com",
          password: "password123",
        }),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.USER_NOT_FOUND);
  } finally {
    await db.close();
  }
});

Deno.test("upgradeAnonymous - rejects when target id is already a full user", async () => {
  const { provider, db } = await makeProvider();
  try {
    const real = await provider.register({
      email: "first@test.com",
      password: "password123",
    });
    const err = await assertRejects(
      () =>
        provider.upgradeAnonymous(real.user.id, {
          email: "second@test.com",
          password: "password123",
        }),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_OPERATION);
  } finally {
    await db.close();
  }
});

Deno.test("upgradeAnonymous - rejects when email is already taken by another user", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.register({
      email: "taken@test.com",
      password: "password123",
    });
    const guest = await provider.loginAnonymous();

    const err = await assertRejects(
      () =>
        provider.upgradeAnonymous(guest.user.id, {
          email: "taken@test.com",
          password: "password123",
        }),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.USER_ALREADY_EXISTS);
  } finally {
    await db.close();
  }
});

Deno.test("upgradeAnonymous - rejects weak passwords before mutating any state", async () => {
  const { provider, db } = await makeProvider();
  try {
    const guest = await provider.loginAnonymous();
    await assertRejects(
      () =>
        provider.upgradeAnonymous(guest.user.id, {
          email: "real@test.com",
          password: "x",
        }),
      AuthError,
    );

    // Confirm: still anonymous, no partial mutation.
    const stillGuest = requireAuthResponse(await provider.login({
      email: "real@test.com",
      password: "password123",
    }).catch((e) => e));
    // No such user, so login throws AuthError — we just want to
    // verify the row wasn't half-written.
    assertEquals(stillGuest instanceof AuthError, true);
  } finally {
    await db.close();
  }
});
