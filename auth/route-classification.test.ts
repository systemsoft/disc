/**
 * Pins router-level auth classification (gh/geldata#7525).
 *
 * The dispatcher in `server/http.ts:handle_auth_route` calls
 * `classifyAuthRoute(route)` and fails closed on `"unknown"`. These
 * tests pin (a) the bootstrap vs authenticated split, (b) every route
 * the dispatcher knows about being classified, and (c) the public
 * allowlist not accidentally including a route that mutates account
 * state.
 */

import { assert, assertEquals } from "@std/assert";
import { AUTH_AUTHENTICATED_ROUTES, AUTH_PUBLIC_ROUTES, classifyAuthRoute } from "./integration.ts";

Deno.test("classifyAuthRoute — bootstrap routes resolve to public", () => {
  for (
    const route of [
      "register",
      "login",
      "anonymous",
      "refresh",
      "reset",
      "reset/confirm",
      "verify",
      "magic-link/request",
      "magic-link/consume",
      "mfa/totp/login",
      "webauthn/login/begin",
      "webauthn/login/finish",
    ]
  ) {
    assertEquals(classifyAuthRoute(route), "public", `${route} should be public`);
  }
});

Deno.test("classifyAuthRoute — privileged routes require auth", () => {
  for (
    const route of [
      "logout",
      "profile",
      "password",
      "upgrade",
      "mfa/totp/enroll",
      "mfa/totp/disable",
      "mfa/recovery-codes/generate",
      "webauthn/register/begin",
      "webauthn/credentials",
      "webauthn/credentials/delete",
    ]
  ) {
    assertEquals(
      classifyAuthRoute(route),
      "authenticated",
      `${route} should require auth`,
    );
  }
});

Deno.test("classifyAuthRoute — unknown routes fail closed", () => {
  assertEquals(classifyAuthRoute("admin/wipe"), "unknown");
  assertEquals(classifyAuthRoute(""), "unknown");
  assertEquals(classifyAuthRoute("login/extra"), "unknown");
});

Deno.test("classifyAuthRoute — every dispatched route is classified", async () => {
  // Read the dispatcher and extract every route literal in the switch.
  // A route reachable in the switch but absent from both sets would be
  // a silent shipping bug — pin catches it.
  const httpSrc = await Deno.readTextFile(
    new URL("../server/http.ts", import.meta.url),
  );
  const switchStart = httpSrc.indexOf("switch (route) {");
  assert(switchStart > 0, "could not locate auth-route switch");
  const switchEnd = httpSrc.indexOf("\n    }", switchStart);
  const switchBody = httpSrc.slice(switchStart, switchEnd);
  const caseRe = /case\s+"([^"]+)":/g;
  const routes: string[] = [];
  for (const m of switchBody.matchAll(caseRe)) routes.push(m[1]);
  assert(routes.length > 10, "expected multiple routes");
  for (const r of routes) {
    assertEquals(
      classifyAuthRoute(r),
      AUTH_PUBLIC_ROUTES.has(r) ? "public" : "authenticated",
      `route "${r}" appears in dispatcher switch but is not classified`,
    );
  }
});

Deno.test("classifyAuthRoute — public allowlist excludes mutation surfaces", () => {
  // Belt-and-suspenders: the names below are sensitive enough that
  // they must never end up in the public bootstrap set, even by typo.
  for (
    const sensitive of [
      "logout",
      "password",
      "profile",
      "upgrade",
      "mfa/totp/enroll",
      "mfa/totp/disable",
      "webauthn/register/begin",
      "webauthn/credentials/delete",
    ]
  ) {
    assert(
      !AUTH_PUBLIC_ROUTES.has(sensitive),
      `${sensitive} should not be in AUTH_PUBLIC_ROUTES`,
    );
    assert(
      AUTH_AUTHENTICATED_ROUTES.has(sensitive),
      `${sensitive} should be in AUTH_AUTHENTICATED_ROUTES`,
    );
  }
});
