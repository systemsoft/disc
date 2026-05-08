/**
 * Reverse-proxy header handling (#5030)
 *
 * Tests for `getClientIp` and `getRequestScheme` — the helpers that
 * decide whether to honor `X-Forwarded-*` headers based on the
 * `trustProxy` config.
 */

import { assertEquals } from "@std/assert";
import { getClientIp, getRequestScheme } from "./proxy.ts";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://disc.local/x", { headers });
}

const localhostInfo: Deno.ServeHandlerInfo = {
  // deno-lint-ignore no-explicit-any
  remoteAddr: { transport: "tcp", hostname: "10.0.0.5", port: 12345 } as any,
  // deno-lint-ignore no-explicit-any
  completed: Promise.resolve() as any
};

// =========================================================================
// getClientIp
// =========================================================================

Deno.test("getClientIp - trustProxy=false ignores X-Forwarded-For (security default)", () => {
  const req = makeRequest({ "x-forwarded-for": "203.0.113.7" });
  // Without trustProxy, an attacker shouldn't be able to spoof their IP
  // for rate-limiting purposes by setting the header themselves.
  assertEquals(getClientIp(req, localhostInfo, false), "10.0.0.5");
});

Deno.test("getClientIp - trustProxy=true honors X-Forwarded-For (left-most)", () => {
  const req = makeRequest({
    "x-forwarded-for": "203.0.113.7, 198.51.100.1, 10.0.0.5"
  });
  assertEquals(getClientIp(req, localhostInfo, true), "203.0.113.7");
});

Deno.test("getClientIp - trustProxy=true falls back to X-Real-IP when XFF absent", () => {
  const req = makeRequest({ "x-real-ip": "203.0.113.7" });
  assertEquals(getClientIp(req, localhostInfo, true), "203.0.113.7");
});

Deno.test("getClientIp - trustProxy=true with no headers returns socket addr", () => {
  const req = makeRequest();
  assertEquals(getClientIp(req, localhostInfo, true), "10.0.0.5");
});

Deno.test("getClientIp - trustProxy=true ignores empty XFF", () => {
  const req = makeRequest({ "x-forwarded-for": "" });
  assertEquals(getClientIp(req, localhostInfo, true), "10.0.0.5");
});

Deno.test("getClientIp - missing remoteAddr returns null", () => {
  const req = makeRequest();
  // deno-lint-ignore no-explicit-any
  const info = { remoteAddr: undefined } as any;
  assertEquals(getClientIp(req, info, false), null);
});

// =========================================================================
// getRequestScheme
// =========================================================================

Deno.test("getRequestScheme - hasTls=true always returns https", () => {
  // Local TLS termination — request was definitely HTTPS.
  // X-Forwarded-Proto is irrelevant here (could be a malicious downgrade).
  const req = makeRequest({ "x-forwarded-proto": "http" });
  assertEquals(getRequestScheme(req, true, true), "https");
});

Deno.test("getRequestScheme - hasTls=false, trustProxy=false returns http", () => {
  const req = makeRequest({ "x-forwarded-proto": "https" });
  // Untrusted header — ignore it, the request reached us as plain HTTP.
  assertEquals(getRequestScheme(req, false, false), "http");
});

Deno.test("getRequestScheme - hasTls=false, trustProxy=true honors X-Forwarded-Proto: https", () => {
  const req = makeRequest({ "x-forwarded-proto": "https" });
  assertEquals(getRequestScheme(req, false, true), "https");
});

Deno.test("getRequestScheme - hasTls=false, trustProxy=true honors X-Forwarded-Proto: http", () => {
  const req = makeRequest({ "x-forwarded-proto": "http" });
  assertEquals(getRequestScheme(req, false, true), "http");
});

Deno.test("getRequestScheme - hasTls=false, trustProxy=true with no header returns http", () => {
  const req = makeRequest();
  assertEquals(getRequestScheme(req, false, true), "http");
});

Deno.test("getRequestScheme - X-Forwarded-Proto is case-insensitive", () => {
  const req = makeRequest({ "x-forwarded-proto": "HTTPS" });
  assertEquals(getRequestScheme(req, false, true), "https");
});

Deno.test("getRequestScheme - X-Forwarded-Proto with multiple hops takes leftmost", () => {
  // Some proxies chain: "https, http". The original client's scheme is leftmost.
  const req = makeRequest({ "x-forwarded-proto": "https, http" });
  assertEquals(getRequestScheme(req, false, true), "https");
});
