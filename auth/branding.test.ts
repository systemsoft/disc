/**
 * Tests for `auth/branding.ts` — config-time validation of
 * `AuthConfig.branding` and `AuthConfig.magicLinkUrlTemplate` plus
 * the runtime URL builder. (gh/geldata#7938 / #8028 / #6731 / #6732)
 */
import { assertEquals, assertThrows } from "@std/assert";
import { buildMagicLinkUrl, validateBranding, validateMagicLinkUrlTemplate } from "./branding.ts";

// ── validateBranding: appName ─────────────────────────────────────────

Deno.test("validateBranding accepts undefined (opt-out)", () => {
  validateBranding(undefined);
});

Deno.test("validateBranding accepts empty object", () => {
  validateBranding({});
});

Deno.test("validateBranding accepts a typical appName", () => {
  validateBranding({ appName: "Acme Corp" });
});

Deno.test("validateBranding rejects empty-string appName", () => {
  assertThrows(
    () => validateBranding({ appName: "" }),
    Error,
    "non-empty string",
  );
});

Deno.test("validateBranding rejects appName > 80 chars", () => {
  const tooLong = "x".repeat(81);
  assertThrows(
    () => validateBranding({ appName: tooLong }),
    Error,
    "exceeds 80 chars",
  );
});

Deno.test("validateBranding rejects CR/LF in appName (header-splice attack)", () => {
  assertThrows(
    () => validateBranding({ appName: "Acme\r\nBcc: attacker@evil" }),
    Error,
    "control characters",
  );
});

Deno.test("validateBranding rejects bare \\r in appName", () => {
  assertThrows(
    () => validateBranding({ appName: "Acme\rspliced" }),
    Error,
    "control characters",
  );
});

Deno.test("validateBranding rejects bare \\n in appName", () => {
  assertThrows(
    () => validateBranding({ appName: "Acme\nspliced" }),
    Error,
    "control characters",
  );
});

Deno.test("validateBranding rejects NUL in appName", () => {
  assertThrows(
    () => validateBranding({ appName: "Acme\x00null" }),
    Error,
    "control characters",
  );
});

Deno.test("validateBranding allows tab in appName", () => {
  // Tab is whitespace, not a header-splice byte.
  validateBranding({ appName: "Acme\tCorp" });
});

// ── validateBranding: logoUrl / darkLogoUrl ───────────────────────────

Deno.test("validateBranding accepts https logoUrl", () => {
  validateBranding({ logoUrl: "https://cdn.example.com/logo.png" });
});

Deno.test("validateBranding accepts http://localhost logoUrl (dev)", () => {
  validateBranding({ logoUrl: "http://localhost:3000/logo.png" });
  validateBranding({ logoUrl: "http://127.0.0.1/logo.png" });
});

Deno.test("validateBranding rejects http://example.com logoUrl", () => {
  assertThrows(
    () => validateBranding({ logoUrl: "http://example.com/logo.png" }),
    Error,
    "https://",
  );
});

Deno.test("validateBranding rejects javascript: logoUrl (XSS)", () => {
  assertThrows(
    () => validateBranding({ logoUrl: "javascript:alert(1)" }),
    Error,
    "https://",
  );
});

Deno.test("validateBranding rejects data: logoUrl", () => {
  assertThrows(
    () => validateBranding({ logoUrl: "data:image/png;base64,abc" }),
    Error,
    "https://",
  );
});

Deno.test("validateBranding rejects file: logoUrl", () => {
  assertThrows(
    () => validateBranding({ logoUrl: "file:///etc/passwd" }),
    Error,
    "https://",
  );
});

Deno.test("validateBranding rejects unparseable logoUrl", () => {
  assertThrows(
    () => validateBranding({ logoUrl: "not a url" }),
    Error,
  );
});

Deno.test("validateBranding applies same scheme rules to darkLogoUrl", () => {
  assertThrows(
    () => validateBranding({ darkLogoUrl: "javascript:void(0)" }),
    Error,
    "https://",
  );
});

Deno.test("validateBranding rejects logoUrl > 2048 chars", () => {
  const huge = "https://x.example.com/" + "a".repeat(3000);
  assertThrows(
    () => validateBranding({ logoUrl: huge }),
    Error,
    "exceeds 2048 chars",
  );
});

// ── validateBranding: brandColor ──────────────────────────────────────

Deno.test("validateBranding accepts 6-digit hex brandColor", () => {
  validateBranding({ brandColor: "#00aaff" });
});

Deno.test("validateBranding accepts 3-digit hex brandColor", () => {
  validateBranding({ brandColor: "#0af" });
});

Deno.test("validateBranding rejects rgb() brandColor", () => {
  assertThrows(
    () => validateBranding({ brandColor: "rgb(0, 170, 255)" }),
    Error,
    "hex color",
  );
});

Deno.test("validateBranding rejects named brandColor", () => {
  assertThrows(
    () => validateBranding({ brandColor: "blue" }),
    Error,
    "hex color",
  );
});

Deno.test("validateBranding rejects hex without leading #", () => {
  assertThrows(
    () => validateBranding({ brandColor: "00aaff" }),
    Error,
    "hex color",
  );
});

Deno.test("validateBranding rejects 4-digit hex brandColor", () => {
  // 4-digit hex is HTML5 alpha-channel; we don't support transparency
  // for inline-CSS safety, so it's refused.
  assertThrows(
    () => validateBranding({ brandColor: "#abcd" }),
    Error,
    "hex color",
  );
});

// ── validateBranding: brandColor (OKLCH) ──────────────────────────────

Deno.test("validateBranding accepts oklch with percentage L", () => {
  validateBranding({ brandColor: "oklch(70% 0.15 200)" });
});

Deno.test("validateBranding accepts oklch with unitless L", () => {
  validateBranding({ brandColor: "oklch(0.7 0.15 200)" });
});

Deno.test("validateBranding accepts oklch with alpha (number)", () => {
  validateBranding({ brandColor: "oklch(70% 0.15 200 / 0.5)" });
});

Deno.test("validateBranding accepts oklch with alpha (percentage)", () => {
  validateBranding({ brandColor: "oklch(70% 0.15 200 / 50%)" });
});

Deno.test("validateBranding accepts oklch with mixed whitespace", () => {
  validateBranding({ brandColor: "oklch(  70%   0.15  200  )" });
});

Deno.test("validateBranding accepts uppercase OKLCH", () => {
  validateBranding({ brandColor: "OKLCH(70% 0.15 200)" });
});

Deno.test("validateBranding accepts oklch at boundaries", () => {
  validateBranding({ brandColor: "oklch(0% 0 0)" });
  validateBranding({ brandColor: "oklch(100% 0.5 360)" });
  validateBranding({ brandColor: "oklch(50% 0.1 180 / 0)" });
  validateBranding({ brandColor: "oklch(50% 0.1 180 / 1)" });
});

Deno.test("validateBranding rejects oklch with comma-separated channels", () => {
  // Modern CSS L4 syntax is space-separated; the comma form is the
  // legacy CSS syntax and is not accepted.
  assertThrows(
    () => validateBranding({ brandColor: "oklch(70%, 0.15, 200)" }),
    Error,
    "oklch",
  );
});

Deno.test("validateBranding rejects oklch with L > 100%", () => {
  assertThrows(
    () => validateBranding({ brandColor: "oklch(110% 0.15 200)" }),
    Error,
    "lightness",
  );
});

Deno.test("validateBranding rejects oklch with unitless L > 1", () => {
  assertThrows(
    () => validateBranding({ brandColor: "oklch(1.5 0.15 200)" }),
    Error,
    "lightness",
  );
});

Deno.test("validateBranding rejects oklch with chroma > 0.5", () => {
  // The CSS spec allows arbitrary positive chroma but values > 0.4
  // are out-of-gamut for any practical display. Cap at 0.5 for sanity.
  assertThrows(
    () => validateBranding({ brandColor: "oklch(70% 1.5 200)" }),
    Error,
    "chroma",
  );
});

Deno.test("validateBranding rejects oklch with hue > 360", () => {
  // CSS would mod-360 a value like 400, but rejecting surfaces typos
  // faster than silently mod-ing them.
  assertThrows(
    () => validateBranding({ brandColor: "oklch(70% 0.15 400)" }),
    Error,
    "hue",
  );
});

Deno.test("validateBranding rejects oklch with negative chroma", () => {
  // Negative numbers can't match the regex (no leading `-` allowed),
  // so this falls through to the generic "must be hex or oklch" error.
  assertThrows(
    () => validateBranding({ brandColor: "oklch(70% -0.1 200)" }),
    Error,
    "oklch",
  );
});

Deno.test("validateBranding rejects oklch with alpha > 1", () => {
  assertThrows(
    () => validateBranding({ brandColor: "oklch(70% 0.15 200 / 1.5)" }),
    Error,
    "alpha",
  );
});

Deno.test("validateBranding rejects malformed oklch shape", () => {
  assertThrows(
    () => validateBranding({ brandColor: "oklch(70% 0.15)" }),
    Error,
    "oklch",
  );
});

// ── validateMagicLinkUrlTemplate ──────────────────────────────────────

Deno.test("validateMagicLinkUrlTemplate accepts undefined", () => {
  validateMagicLinkUrlTemplate(undefined);
});

Deno.test("validateMagicLinkUrlTemplate accepts query-style template", () => {
  validateMagicLinkUrlTemplate("https://app.example.com/auth/magic?token={token}");
});

Deno.test("validateMagicLinkUrlTemplate accepts path-style template", () => {
  validateMagicLinkUrlTemplate("https://app.example.com/login/{token}");
});

Deno.test("validateMagicLinkUrlTemplate accepts http://localhost template", () => {
  validateMagicLinkUrlTemplate("http://localhost:3000/login?t={token}");
});

Deno.test("validateMagicLinkUrlTemplate rejects template missing {token}", () => {
  assertThrows(
    () => validateMagicLinkUrlTemplate("https://app.example.com/login"),
    Error,
    "{token}",
  );
});

Deno.test("validateMagicLinkUrlTemplate rejects template with two {token}", () => {
  assertThrows(
    () =>
      validateMagicLinkUrlTemplate(
        "https://app.example.com/{token}?also={token}",
      ),
    Error,
    "exactly one",
  );
});

Deno.test("validateMagicLinkUrlTemplate rejects http:// for non-localhost host", () => {
  assertThrows(
    () => validateMagicLinkUrlTemplate("http://example.com/auth/magic?t={token}"),
    Error,
    "https://",
  );
});

Deno.test("validateMagicLinkUrlTemplate rejects javascript: scheme", () => {
  assertThrows(
    () => validateMagicLinkUrlTemplate("javascript:alert({token})"),
    Error,
  );
});

Deno.test("validateMagicLinkUrlTemplate rejects empty string", () => {
  assertThrows(
    () => validateMagicLinkUrlTemplate(""),
    Error,
    "non-empty",
  );
});

Deno.test("validateMagicLinkUrlTemplate rejects CRLF in template", () => {
  assertThrows(
    () =>
      validateMagicLinkUrlTemplate(
        "https://example.com/?t={token}\r\nX-Bcc: x",
      ),
    Error,
    "control characters",
  );
});

// ── buildMagicLinkUrl ─────────────────────────────────────────────────

Deno.test("buildMagicLinkUrl falls back to ${baseUrl}/auth/magic when no template", () => {
  const url = buildMagicLinkUrl("abc123", { baseUrl: "https://app.example.com" });
  assertEquals(url, "https://app.example.com/auth/magic?token=abc123");
});

Deno.test("buildMagicLinkUrl strips trailing slash from baseUrl", () => {
  const url = buildMagicLinkUrl("abc", { baseUrl: "https://app.example.com/" });
  assertEquals(url, "https://app.example.com/auth/magic?token=abc");
});

Deno.test("buildMagicLinkUrl substitutes {token} in template", () => {
  const url = buildMagicLinkUrl("abc123", {
    baseUrl: "https://app.example.com",
    template: "https://other.example.com/login/{token}",
  });
  assertEquals(url, "https://other.example.com/login/abc123");
});

Deno.test("buildMagicLinkUrl URL-encodes tokens with special chars", () => {
  const url = buildMagicLinkUrl("a/b+c=d", {
    baseUrl: "https://app.example.com",
    template: "https://other.example.com/login?t={token}",
  });
  assertEquals(url, "https://other.example.com/login?t=a%2Fb%2Bc%3Dd");
});

Deno.test("buildMagicLinkUrl URL-encodes tokens in fallback shape too", () => {
  const url = buildMagicLinkUrl("a b/c", { baseUrl: "https://x.example.com" });
  assertEquals(url, "https://x.example.com/auth/magic?token=a%20b%2Fc");
});
