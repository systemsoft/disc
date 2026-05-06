/**
 * Sanitization + validation for `AuthConfig.branding` and URL-template
 * fields.
 *
 * These values flow into rendered HTML emails and the built-in admin
 * UI, so they're attacker-adjacent: a malicious `appName` containing
 * CR/LF could splice email headers; a `logoUrl` with a `javascript:`
 * scheme would XSS any client that renders the email as HTML; an
 * unanchored URL template could redirect users to a phishing page.
 *
 * Every checker here fails loud at config-load time rather than
 * silently stripping — operators see the exact field and the exact
 * reason the value was refused, before the server starts accepting
 * traffic. (gh/geldata#7938 / #8028 / #8026)
 */
import type { AuthBrandingConfig } from "./types.ts";

/** Caps tuned to comfortably exceed any real-world input. */
const MAX_APP_NAME_LEN = 80;
const MAX_URL_LEN = 2048;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TOKEN_PLACEHOLDER = "{token}";

/**
 * Reject any string carrying a CR/LF/NUL — these are the bytes that
 * splice email headers (`Subject: …\r\nBcc: attacker@…`) when the
 * value lands in a `Subject:` line or similar header.
 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Strip ASCII C0 controls except TAB (\t = 9). DEL (127) and the
    // C1 controls (128–159) are also banned: rendered HTML clients
    // can interpret them ambiguously.
    if (code !== 9 && (code < 32 || (code >= 127 && code <= 159))) {
      return true;
    }
  }
  return false;
}

/**
 * Allow only `https://` schemes in production. `http://` is permitted
 * exclusively when the host is a loopback literal (`localhost`,
 * `127.0.0.1`, `[::1]`) so local dev still works without extra config.
 * Everything else (`data:`, `javascript:`, `file:`, …) is refused.
 */
function isSafeUrlScheme(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  return false;
}

/**
 * Validate `branding` in place. Throws on the first offending field
 * with a message that names the field and why it was refused. Pass
 * `undefined` to opt out — no defaults are filled in here; the
 * email-template layer treats unset fields as "use the generic
 * defaults".
 */
export function validateBranding(branding: AuthBrandingConfig | undefined): void {
  if (!branding) return;

  if (branding.appName !== undefined) {
    const v = branding.appName;
    if (typeof v !== "string") {
      throw new Error("AuthProvider: branding.appName must be a string");
    }
    if (v.length === 0) {
      throw new Error(
        "AuthProvider: branding.appName must be a non-empty string when set",
      );
    }
    if (v.length > MAX_APP_NAME_LEN) {
      throw new Error(
        `AuthProvider: branding.appName exceeds ${MAX_APP_NAME_LEN} chars (got ${v.length}) — refuse rather than truncate so subject lines don't end mid-word`,
      );
    }
    if (hasControlChars(v)) {
      throw new Error(
        "AuthProvider: branding.appName contains control characters (CR/LF/NUL) — these splice email headers and are not safe to render",
      );
    }
  }

  for (const key of ["logoUrl", "darkLogoUrl"] as const) {
    const v = branding[key];
    if (v === undefined) continue;
    if (typeof v !== "string") {
      throw new Error(`AuthProvider: branding.${key} must be a string`);
    }
    if (v.length === 0) {
      throw new Error(
        `AuthProvider: branding.${key} must be a non-empty string when set`,
      );
    }
    if (v.length > MAX_URL_LEN) {
      throw new Error(
        `AuthProvider: branding.${key} exceeds ${MAX_URL_LEN} chars`,
      );
    }
    if (hasControlChars(v)) {
      throw new Error(
        `AuthProvider: branding.${key} contains control characters — would break HTML rendering`,
      );
    }
    if (!isSafeUrlScheme(v)) {
      throw new Error(
        `AuthProvider: branding.${key} must be https:// (http:// is allowed only for localhost) — refuses data:/javascript:/file: schemes`,
      );
    }
  }

  if (branding.brandColor !== undefined) {
    const v = branding.brandColor;
    if (typeof v !== "string" || !HEX_COLOR_RE.test(v)) {
      throw new Error(
        `AuthProvider: branding.brandColor must be a 3- or 6-digit hex color (e.g. "#0af" or "#00aaff"); got ${JSON.stringify(v)}`,
      );
    }
  }
}

/**
 * Validate a magic-link URL template. The template must:
 *   - parse as an absolute URL,
 *   - use `https://` (or `http://localhost` for dev),
 *   - contain the literal placeholder `{token}` exactly once.
 *
 * Single-occurrence is enforced because the renderer does a literal
 * substring replacement; multi-occurrence would silently produce a
 * URL with the token repeated, which is rarely the operator's
 * intent and is harder to spot than a config-time refusal.
 */
export function validateMagicLinkUrlTemplate(template: string | undefined): void {
  if (template === undefined) return;
  if (typeof template !== "string" || template.length === 0) {
    throw new Error(
      "AuthProvider: magicLinkUrlTemplate must be a non-empty string when set",
    );
  }
  if (template.length > MAX_URL_LEN) {
    throw new Error(
      `AuthProvider: magicLinkUrlTemplate exceeds ${MAX_URL_LEN} chars`,
    );
  }
  if (hasControlChars(template)) {
    throw new Error(
      "AuthProvider: magicLinkUrlTemplate contains control characters (CR/LF/NUL)",
    );
  }
  // `{token}` must appear exactly once. A URL ctor parse with the
  // placeholder substituted to a stub also catches obviously broken
  // templates (missing scheme, no host, etc.).
  const occurrences = template.split(TOKEN_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `AuthProvider: magicLinkUrlTemplate must contain exactly one '${TOKEN_PLACEHOLDER}' placeholder (got ${occurrences})`,
    );
  }
  const probe = template.replace(TOKEN_PLACEHOLDER, "TOKEN");
  if (!isSafeUrlScheme(probe)) {
    throw new Error(
      "AuthProvider: magicLinkUrlTemplate must be https:// (http:// is allowed only for localhost)",
    );
  }
}

/**
 * Build the magic-link URL for a given plaintext token. When a
 * `template` is supplied, substitutes `{token}` with the URL-encoded
 * token. Otherwise falls back to `${baseUrl}/auth/magic?token=<token>`
 * — the historical default that older callers depend on.
 */
export function buildMagicLinkUrl(
  token: string,
  opts: { baseUrl: string; template?: string },
): string {
  const encoded = encodeURIComponent(token);
  if (opts.template) {
    return opts.template.replace(TOKEN_PLACEHOLDER, encoded);
  }
  const trimmed = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl;
  return `${trimmed}/auth/magic?token=${encoded}`;
}
