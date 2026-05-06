/**
 * Tests for `fetchUserInfo` profile-claim normalization.
 * (gh/geldata#7344, ports geldata/gel#7344)
 *
 * Disc maps the OIDC standard claims plus the GitHub aliases to a
 * single `OAuthUserInfo` shape so callers don't have to special-case
 * each provider. These tests pin the mapping rules — provider-shaped
 * inputs in, normalized output out.
 */
import { assertEquals } from "@std/assert";
import { fetchUserInfo } from "./token-exchange.ts";
import type { OAuthProviderConfig } from "./types.ts";

function makeProvider(): OAuthProviderConfig {
  return {
    authorizeUrl: "https://example.com/authorize",
    clientId: "cid",
    clientSecret: "csecret",
    name: "test",
    scopes: ["openid", "email", "profile"],
    tokenUrl: "https://example.com/token",
    userInfoUrl: "https://example.com/userinfo",
  };
}

/**
 * Build a stub `fetch` that returns the supplied JSON body for any
 * URL. We monkey-patch `globalThis.fetch` for the duration of one
 * test, then restore — Deno's test runner doesn't isolate globals
 * automatically.
 */
function withMockFetch(payload: unknown, fn: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

Deno.test("fetchUserInfo normalizes Google's OIDC userinfo payload", async () => {
  await withMockFetch(
    {
      sub: "google-uid-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice Anderson",
      given_name: "Alice",
      family_name: "Anderson",
      picture: "https://lh3.googleusercontent.com/a/avatar",
      locale: "en-US",
    },
    async () => {
      const u = await fetchUserInfo(makeProvider(), "tok");
      assertEquals(u.id, "google-uid-1");
      assertEquals(u.email, "alice@example.com");
      assertEquals(u.emailVerified, true);
      assertEquals(u.name, "Alice Anderson");
      assertEquals(u.givenName, "Alice");
      assertEquals(u.familyName, "Anderson");
      assertEquals(u.avatarUrl, "https://lh3.googleusercontent.com/a/avatar");
      assertEquals(u.locale, "en-US");
    },
  );
});

Deno.test("fetchUserInfo normalizes GitHub /user payload (id + login + avatar_url)", async () => {
  await withMockFetch(
    {
      id: 12345,
      login: "alice",
      email: "alice@example.com",
      avatar_url: "https://avatars.githubusercontent.com/u/12345",
    },
    async () => {
      const u = await fetchUserInfo(makeProvider(), "tok");
      assertEquals(u.id, "12345");
      assertEquals(u.email, "alice@example.com");
      assertEquals(u.name, "alice"); // login → name fallback
      assertEquals(u.avatarUrl, "https://avatars.githubusercontent.com/u/12345");
      // GitHub doesn't supply email_verified, locale, given/family.
      assertEquals(u.emailVerified, undefined);
      assertEquals(u.locale, undefined);
    },
  );
});

Deno.test("fetchUserInfo accepts string-typed email_verified (Apple/SAML bridges)", async () => {
  await withMockFetch(
    {
      sub: "x",
      email: "x@y.z",
      email_verified: "true",
    },
    async () => {
      const u = await fetchUserInfo(makeProvider(), "tok");
      assertEquals(u.emailVerified, true);
    },
  );
});

Deno.test("fetchUserInfo coerces email_verified='false' string to false", async () => {
  await withMockFetch(
    {
      sub: "x",
      email_verified: "false",
    },
    async () => {
      const u = await fetchUserInfo(makeProvider(), "tok");
      assertEquals(u.emailVerified, false);
    },
  );
});

Deno.test("fetchUserInfo drops non-boolean-ish email_verified rather than coercing", async () => {
  await withMockFetch(
    {
      sub: "x",
      email_verified: 1, // non-conforming provider
    },
    async () => {
      const u = await fetchUserInfo(makeProvider(), "tok");
      // Absence rather than `false` — distinguishes "unknown" from
      // "actively unverified".
      assertEquals(u.emailVerified, undefined);
    },
  );
});

Deno.test("fetchUserInfo preserves the full upstream payload on .raw", async () => {
  // Use a quoted key so the literal flows through as `custom_provider_field`
  // without tripping deno-lint's camelCase rule on object keys.
  const payload = {
    "sub": "x",
    "email": "y@z",
    "custom_provider_field": "anything",
  };
  await withMockFetch(payload, async () => {
    const u = await fetchUserInfo(makeProvider(), "tok");
    assertEquals(u.raw["custom_provider_field"], "anything");
    assertEquals(u.raw["sub"], "x");
  });
});

Deno.test("fetchUserInfo: missing fields default to undefined (not empty string)", async () => {
  await withMockFetch({ sub: "x" }, async () => {
    const u = await fetchUserInfo(makeProvider(), "tok");
    assertEquals(u.id, "x");
    assertEquals(u.email, undefined);
    assertEquals(u.name, undefined);
    assertEquals(u.avatarUrl, undefined);
    assertEquals(u.givenName, undefined);
    assertEquals(u.familyName, undefined);
    assertEquals(u.locale, undefined);
    assertEquals(u.emailVerified, undefined);
  });
});
