/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for P0-05: auth endpoints must be rate-limited.
 *
 * Brute-force (login), enumeration (reset), and spam (register) attacks
 * against unauthenticated endpoints were previously unlimited. These tests
 * lock in per-IP rate limiting and its opt-out behavior.
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthMiddleware } from "./middleware.ts";
import { AuthRoutes } from "./integration.ts";
import { NoopCaptchaVerifier } from "./captcha.ts";
import { RateLimiter } from "../server/rate-limiter.ts";
import type { AuthProvider } from "./provider.ts";

/*** Minimal stub — the rate-limit check runs before any provider call, so we don’t need a working
     provider for these tests. The `captchaVerifier` field is required by AuthRoutes’ `checkCaptcha`
     helper; the noop is transparent (`isGated() === false`) so the rate-limit path remains the only
     thing under test here. ***/
const stubProvider = {
  captchaVerifier: new NoopCaptchaVerifier(),
  login() {
    return Promise.resolve({ session: {}, token: "", user: {} } as any);
  },
  register() {
    return Promise.resolve({ session: {}, token: "", user: {} } as any);
  },
  resetPassword() {
    return Promise.resolve();
  },
  resetPasswordRequest() {
    return Promise.resolve("plaintext-token");
  }
} as unknown as AuthProvider;

const stubMiddleware = {} as AuthMiddleware;

/*** RUNTIME ------------------------------------------ ***/

Deno.test("AuthRoutes - login is rate-limited after burst is exhausted (P0-05)", async () => {
  const limiter = new RateLimiter({ requestsPerMinute: 60, burstSize: 3 });
  const routes = new AuthRoutes(stubProvider, stubMiddleware, { rateLimiter: limiter });
  const handler = routes.login();

  const mkRequest = () =>
    new Request("http://localhost/auth/login", {
      body: JSON.stringify({ email: "a@b.com", password: "x" }),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.5"
      },
      method: "POST"
    });

  /*** Burst allows 3 immediate requests ***/
  const r1 = await handler(mkRequest());
  const r2 = await handler(mkRequest());
  const r3 = await handler(mkRequest());
  /*** r1/r2/r3 may return 200 or an auth error from the stub — the only thing that matters is that
       they’re NOT 429. ***/
  for (const r of [r1, r2, r3]) {
    assertEquals(r.status === 429, false, `First 3 in burst should NOT be rate-limited, got ${r.status}`);
    await r.body?.cancel();
  }

  const r4 = await handler(mkRequest());
  assertEquals(r4.status, 429);
  assertEquals(r4.headers.get("Retry-After"), "60");
  await r4.body?.cancel();

  routes.dispose();
});

Deno.test("AuthRoutes - rate limit keyed by IP (different IPs independent)", async () => {
  const limiter = new RateLimiter({ burstSize: 1, requestsPerMinute: 60 });
  /*** trustProxy=true: this test simulates the realistic deployment where a reverse proxy sets
       X-Forwarded-For. Without trustProxy, the secure default ignores client-supplied XFF
       (gh/geldata#5030) and all requests collapse into the shared "anonymous"
       rate-limit bucket. ***/
  const routes = new AuthRoutes(stubProvider, stubMiddleware, { rateLimiter: limiter, trustProxy: true });
  const handler = routes.login();

  const mk = (ip: string) =>
    new Request("http://localhost/auth/login", {
      body: JSON.stringify({ email: "a@b.com", password: "x" }),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip
      },
      method: "POST"
    });

  const r1 = await handler(mk("10.0.0.1"));
  assertEquals(r1.status !== 429, true); /*** allowed ***/
  await r1.body?.cancel();

  const r2 = await handler(mk("10.0.0.1"));
  assertEquals(r2.status, 429); /*** same IP blocked ***/
  await r2.body?.cancel();

  const r3 = await handler(mk("10.0.0.2"));
  assertEquals(r3.status !== 429, true); /*** different IP not blocked ***/
  await r3.body?.cancel();

  routes.dispose();
});

Deno.test("AuthRoutes - rate limiter is opt-out via null", async () => {
  const routes = new AuthRoutes(stubProvider, stubMiddleware, {
    rateLimiter: null /*** explicitly disabled ***/
  });

  const handler = routes.login();

  const mk = () =>
    new Request("http://localhost/auth/login", {
      body: JSON.stringify({ email: "a@b.com", password: "x" }),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9"
      },
      method: "POST"
    });

  /*** 50 rapid requests should all bypass rate limiting when opted out ***/
  for (let i = 0; i < 50; i++) {
    const r = await handler(mk());
    assertEquals(r.status === 429, false, `request ${i} should not be rate-limited when opted out`);
    await r.body?.cancel();
  }

  routes.dispose();
});
