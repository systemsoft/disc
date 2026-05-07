/**
 * Tests for the /auth/anonymous and /auth/upgrade HTTP routes.
 * (gh/geldata#8750)
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "./provider.ts";
import { AuthMiddleware } from "./middleware.ts";
import { AuthRoutes } from "./integration.ts";
import { TestDatabase } from "./test-database.ts";

async function makeRoutes(): Promise<{
  provider: AuthProvider;
  routes: AuthRoutes;
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
  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware, { rateLimiter: null });
  return { provider, routes, db };
}

Deno.test("POST /auth/anonymous - mints a guest identity", async () => {
  const { routes, db } = await makeRoutes();
  try {
    const handler = routes.loginAnonymous();
    const req = new Request("http://localhost/auth/anonymous", {
      method: "POST",
    });
    const res = await handler(req);
    assertEquals(res.status, 201);
    const body = await res.json();
    assert(body.user);
    assertEquals(body.user.isAnonymous, true);
    assert(body.token, "anonymous response includes a token");
    assert(body.session, "anonymous response includes a session");
  } finally {
    await db.close();
  }
});

Deno.test("POST /auth/upgrade - rejects unauthenticated request", async () => {
  const { routes, db } = await makeRoutes();
  try {
    const handler = routes.upgradeAnonymous();
    const req = new Request("http://localhost/auth/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "real@example.com",
        password: "password123",
      }),
    });
    const res = await handler(req);
    // requireAuth returns 401 when no Bearer token is present.
    assertEquals(res.status, 401);
  } finally {
    await db.close();
  }
});

Deno.test("POST /auth/upgrade - missing fields returns 400", async () => {
  const { provider, routes, db } = await makeRoutes();
  try {
    const guest = await provider.loginAnonymous();
    const handler = routes.upgradeAnonymous();
    const req = new Request("http://localhost/auth/upgrade", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${guest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "only@example.com" }),
    });
    const res = await handler(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.code, "MISSING_CREDENTIALS");
  } finally {
    await db.close();
  }
});

Deno.test("POST /auth/upgrade - upgrades a guest into a full user", async () => {
  const { provider, routes, db } = await makeRoutes();
  try {
    const guest = await provider.loginAnonymous();
    const handler = routes.upgradeAnonymous();
    const req = new Request("http://localhost/auth/upgrade", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${guest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "promoted@example.com",
        password: "password123",
      }),
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.user.id, guest.user.id);
    assertEquals(body.user.email, "promoted@example.com");
    assertEquals(body.user.isAnonymous, false);
  } finally {
    await db.close();
  }
});
