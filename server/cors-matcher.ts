/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Wildcard-aware CORS origin matcher (#6655)
 *
 * Origin headers are `<scheme>://<host>[:port]` with no path. Each
 * allowlist entry is either a literal origin or a single-label
 * wildcard (`https://*.example.com`).
 *
 * Wildcard rules — kept narrow on purpose, mirroring the OAuth
 * redirect-URI matcher (`ext-oauth/redirect-matcher.ts`):
 *   - `*` is the leftmost host label and the *whole* label
 *   - matches exactly one DNS label (`*.foo.com` does NOT match
 *     `a.b.foo.com`)
 *   - scheme and port must match exactly
 */

export function matchCorsOrigin(
  supplied: string,
  allowlist: ReadonlyArray<string>
): boolean {
  let parsedSupplied: URL;
  try {
    parsedSupplied = new URL(supplied);
  } catch {
    return false;
  }
  // Browsers don't send userinfo in Origin, but reject defensively.
  if (parsedSupplied.username || parsedSupplied.password) {
    return false;
  }
  // Origin headers must have an empty path. If the input has a non-empty
  // pathname, treat it as malformed.
  if (parsedSupplied.pathname !== "" && parsedSupplied.pathname !== "/") {
    return false;
  }

  for (const pattern of allowlist) {
    if (matchesPattern(parsedSupplied, pattern)) {
      return true;
    }
  }
  return false;
}

function matchesPattern(supplied: URL, pattern: string): boolean {
  if (pattern.includes("://*.")) {
    return matchesWildcardPattern(supplied, pattern);
  }
  let parsedPattern: URL;
  try {
    parsedPattern = new URL(pattern);
  } catch {
    return false;
  }
  return (
    supplied.protocol === parsedPattern.protocol &&
    supplied.host.toLowerCase() === parsedPattern.host.toLowerCase()
  );
}

function matchesWildcardPattern(supplied: URL, pattern: string): boolean {
  // Anchor on `://*.` to reject non-canonical inputs like `*.foo.com`
  // (no scheme) or `https://*foo.com` (wildcard not in label position).
  const schemeIdx = pattern.indexOf("://*.");
  if (schemeIdx === -1) {
    return false;
  }
  const scheme = pattern.slice(0, schemeIdx); // "https"
  const afterStar = pattern.slice(schemeIdx + "://*.".length); // "example.com" or "example.com:8443"
  // Origin patterns have no path component — reject if one is present.
  if (afterStar.includes("/")) {
    return false;
  }
  const baseHost = afterStar.toLowerCase(); // includes port if any

  if (supplied.protocol !== `${scheme}:`) {
    return false;
  }

  const suppliedHost = supplied.host.toLowerCase(); // includes port if any
  // Pattern host == "*." + baseHost; must match `<one-label>.<baseHost>`.
  const suffix = `.${baseHost}`;
  if (!suppliedHost.endsWith(suffix)) {
    return false;
  }
  const prefix = suppliedHost.slice(0, suppliedHost.length - suffix.length);
  if (prefix.length === 0) {
    return false; // bare baseHost not allowed
  }
  if (prefix.includes(".")) {
    return false; // only one label deep
  }
  return true;
}
