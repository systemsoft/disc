/**
 * Wildcard-aware CORS origin matcher (#6655)
 *
 * Mirrors `ext-oauth/redirect-matcher.ts` but for `Origin` headers, which
 * are shaped `<scheme>://<host>[:port]` with no path. Wildcard rules are
 * intentionally narrow:
 *   - `*` is the leftmost label and the entire label
 *   - matches exactly one DNS label (`*.foo.com` does not match `a.b.foo.com`)
 *   - scheme and port must match exactly
 */

import { assertEquals } from "@std/assert";
import { matchCorsOrigin } from "./cors-matcher.ts";

// --- exact match (back-compat with prior allowlist behavior) ---

Deno.test("cors-matcher - exact-match allowed", () => {
  assertEquals(
    matchCorsOrigin("https://app.example.com", ["https://app.example.com"]),
    true,
  );
});

Deno.test("cors-matcher - exact-match different host rejected", () => {
  assertEquals(
    matchCorsOrigin("https://evil.example.com", ["https://app.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - exact-match different scheme rejected", () => {
  assertEquals(
    matchCorsOrigin("http://app.example.com", ["https://app.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - exact-match different port rejected", () => {
  assertEquals(
    matchCorsOrigin(
      "https://app.example.com:8443",
      ["https://app.example.com"],
    ),
    false,
  );
});

Deno.test("cors-matcher - case-insensitive host comparison", () => {
  assertEquals(
    matchCorsOrigin("https://APP.example.com", ["https://app.example.com"]),
    true,
  );
});

// --- wildcard subdomain ---

Deno.test("cors-matcher - wildcard matches one-label subdomain", () => {
  assertEquals(
    matchCorsOrigin("https://tenant1.example.com", ["https://*.example.com"]),
    true,
  );
});

Deno.test("cors-matcher - wildcard does NOT match two-label subdomain", () => {
  // `*.example.com` matches exactly one label deep — `a.b.example.com`
  // is two labels deep and must be rejected to keep the security
  // surface small (matches matchRedirectUri semantics).
  assertEquals(
    matchCorsOrigin("https://a.b.example.com", ["https://*.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - wildcard does NOT match bare base host", () => {
  // `*.example.com` requires a subdomain label — bare `example.com` rejected.
  assertEquals(
    matchCorsOrigin("https://example.com", ["https://*.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - wildcard with mismatched scheme rejected", () => {
  assertEquals(
    matchCorsOrigin("http://tenant.example.com", ["https://*.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - wildcard with mismatched base host rejected", () => {
  assertEquals(
    matchCorsOrigin("https://tenant.attacker.com", ["https://*.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - wildcard preserves port match", () => {
  assertEquals(
    matchCorsOrigin(
      "https://tenant.example.com:8443",
      ["https://*.example.com:8443"],
    ),
    true,
  );
  assertEquals(
    matchCorsOrigin(
      "https://tenant.example.com",
      ["https://*.example.com:8443"],
    ),
    false,
  );
});

// --- mixed allowlist (literal + wildcard) ---

Deno.test("cors-matcher - allowlist mixing exact and wildcard", () => {
  const allowlist = [
    "https://app.example.com",
    "https://*.staging.example.com",
  ];
  assertEquals(matchCorsOrigin("https://app.example.com", allowlist), true);
  assertEquals(
    matchCorsOrigin("https://t1.staging.example.com", allowlist),
    true,
  );
  assertEquals(matchCorsOrigin("https://other.example.com", allowlist), false);
});

// --- malformed input ---

Deno.test("cors-matcher - malformed origin rejected", () => {
  assertEquals(
    matchCorsOrigin("not a url", ["https://app.example.com"]),
    false,
  );
});

Deno.test("cors-matcher - empty allowlist rejects everything", () => {
  assertEquals(matchCorsOrigin("https://app.example.com", []), false);
});

Deno.test("cors-matcher - origin with userinfo rejected", () => {
  // Browsers don't send userinfo in Origin, but defense-in-depth.
  assertEquals(
    matchCorsOrigin(
      "https://user:pass@app.example.com",
      ["https://app.example.com"],
    ),
    false,
  );
});
