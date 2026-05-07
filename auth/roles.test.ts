/**
 * Tests for RBAC role registry + assignment + JWT plumbing.
 * (gh/geldata#8177)
 */

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { AuthError, AuthErrorCode ,
  requireAuthResponse,
} from "./types.ts";

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

// ── Role registry ─────────────────────────────────────────────────────

Deno.test("createRole / listRoles / deleteRole — basic round-trip", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin", "Full access");
    await provider.createRole("viewer", "Read-only");

    const roles = await provider.listRoles();
    assertEquals(roles.length, 2);
    // Sorted alphabetically by listRoles
    assertEquals(roles[0].name, "admin");
    assertEquals(roles[0].description, "Full access");
    assertEquals(roles[1].name, "viewer");

    await provider.deleteRole("viewer");
    const after = await provider.listRoles();
    assertEquals(after.length, 1);
    assertEquals(after[0].name, "admin");
  } finally {
    await db.close();
  }
});

Deno.test("createRole — idempotent on duplicate name", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin", "v1");
    await provider.createRole("admin", "v2");
    const roles = await provider.listRoles();
    assertEquals(roles.length, 1);
    assertEquals(roles[0].description, "v2");
  } finally {
    await db.close();
  }
});

// ── Assignment ────────────────────────────────────────────────────────

Deno.test("assignRole — grants the role to the user", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    await provider.assignRole(auth.user.id, "admin");

    assertEquals(await provider.userHasRole(auth.user.id, "admin"), true);
    assertEquals(await provider.getUserRoles(auth.user.id), ["admin"]);
  } finally {
    await db.close();
  }
});

Deno.test("assignRole — idempotent on repeat", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    await provider.assignRole(auth.user.id, "admin");
    await provider.assignRole(auth.user.id, "admin");
    assertEquals((await provider.getUserRoles(auth.user.id)).length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("assignRole — rejects unknown role", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const err = await assertRejects(
      () => provider.assignRole(auth.user.id, "ghost"),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_OPERATION);
  } finally {
    await db.close();
  }
});

Deno.test("assignRole — rejects unknown user", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    const err = await assertRejects(
      () =>
        provider.assignRole(
          "00000000-0000-0000-0000-000000000000",
          "admin",
        ),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.USER_NOT_FOUND);
  } finally {
    await db.close();
  }
});

Deno.test("revokeRole — removes the assignment", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    await provider.assignRole(auth.user.id, "admin");
    await provider.revokeRole(auth.user.id, "admin");
    assertEquals(await provider.userHasRole(auth.user.id, "admin"), false);
  } finally {
    await db.close();
  }
});

Deno.test("revokeRole — no-op when role wasn't held", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    // Should not throw
    await provider.revokeRole(auth.user.id, "admin");
    assertEquals(await provider.userHasRole(auth.user.id, "admin"), false);
  } finally {
    await db.close();
  }
});

// ── JWT integration ──────────────────────────────────────────────────

Deno.test("login — JWT carries the user's roles", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    await provider.createRole("viewer");
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    await provider.assignRole(auth.user.id, "admin");
    await provider.assignRole(auth.user.id, "viewer");

    const login = requireAuthResponse(await provider.login({
      email: "u@example.com",
      password: "password123",
    }));
    const payload = await provider.verifyToken(login.token);
    assert(payload.roles, "roles must be present in token payload");
    assertEquals(payload.roles!.sort(), ["admin", "viewer"]);
  } finally {
    await db.close();
  }
});

Deno.test("login — JWT omits roles claim when user has none", async () => {
  const { provider, db } = await makeProvider();
  try {
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const login = requireAuthResponse(await provider.login({
      email: "u@example.com",
      password: "password123",
    }));
    const payload = await provider.verifyToken(login.token);
    // Either undefined or an empty array — both signal "no roles"
    if (payload.roles !== undefined) {
      assertEquals(payload.roles.length, 0);
    }
    assertEquals(auth.user.id, payload.sub);
  } finally {
    await db.close();
  }
});

Deno.test("token snapshot — roles assigned after login do not affect existing token", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.createRole("admin");
    const auth = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const login = requireAuthResponse(await provider.login({
      email: "u@example.com",
      password: "password123",
    }));
    // Assign role AFTER token issued
    await provider.assignRole(auth.user.id, "admin");
    const payload = await provider.verifyToken(login.token);
    // The old token must NOT carry the new role — that's the documented
    // snapshot semantics.
    if (payload.roles !== undefined) {
      assertEquals(payload.roles.includes("admin"), false);
    }
    // But a fresh login picks it up.
    const refreshed = requireAuthResponse(await provider.login({
      email: "u@example.com",
      password: "password123",
    }));
    const refreshedPayload = await provider.verifyToken(refreshed.token);
    assert(refreshedPayload.roles?.includes("admin"));
  } finally {
    await db.close();
  }
});
