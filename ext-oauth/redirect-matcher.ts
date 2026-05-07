/**
 * Wildcard-aware redirect-URI matcher for OAuth allowlists.
 * (gh/geldata#7468)
 *
 * Each allowlist entry is either:
 *  - a literal URI (matched exact-string after URL canonicalization), or
 *  - a wildcard pattern with a single `*` in the host position, matching
 *    exactly one DNS label.
 *
 * Wildcard rules (intentionally narrow to keep the security model easy
 * to reason about):
 *  - The `*` must be the leftmost host label and must be the *whole* label
 *    (not a partial match like `app-*.foo.com`).
 *  - It matches exactly one label — `*.foo.com` does not match
 *    `a.b.foo.com` (which would be two labels deep).
 *  - Scheme, port, and path must match exactly. No `*` in those positions.
 *  - Trailing-slash differences are normalised (`/cb` and `/cb/` are
 *    treated as different paths — strict, since OAuth redirect URIs are
 *    sensitive and the principle of least surprise wins over forgiveness).
 */

export function matchRedirectUri(
  supplied: string,
  allowlist: ReadonlyArray<string>,
): boolean {
  let parsedSupplied: URL;
  try {
    parsedSupplied = new URL(supplied);
  } catch {
    return false;
  }
  // Reject userinfo (username/password in the authority) outright —
  // attacker-controlled credentials should never round-trip via OAuth.
  if (parsedSupplied.username || parsedSupplied.password) return false;

  for (const pattern of allowlist) {
    if (matchesPattern(parsedSupplied, pattern)) return true;
  }
  return false;
}

function matchesPattern(supplied: URL, pattern: string): boolean {
  // Wildcard fast path: the pattern looks like `<scheme>://*.<rest>/<path>`
  if (pattern.includes("://*.")) {
    return matchesWildcardPattern(supplied, pattern);
  }
  // Literal: parse the pattern and compare component-by-component so
  // case-insensitive scheme/host comparison works.
  let parsedPattern: URL;
  try {
    parsedPattern = new URL(pattern);
  } catch {
    return false;
  }
  return (
    supplied.protocol === parsedPattern.protocol
    && supplied.host.toLowerCase() === parsedPattern.host.toLowerCase()
    && supplied.pathname === parsedPattern.pathname
  );
}

function matchesWildcardPattern(supplied: URL, pattern: string): boolean {
  // Split into "<scheme>://" + "*.<base>" + "<path>". Anchoring on `://*.`
  // keeps us safe from inputs like `*.foo.com` (no scheme) or
  // `https://*foo.com` (wildcard not in label position).
  const schemeIdx = pattern.indexOf("://*.");
  if (schemeIdx === -1) return false;
  const scheme = pattern.slice(0, schemeIdx); // "https"
  const afterStar = pattern.slice(schemeIdx + "://*.".length); // "foo.com/cb"
  const slashIdx = afterStar.indexOf("/");
  const baseHost = (slashIdx === -1 ? afterStar : afterStar.slice(0, slashIdx)).toLowerCase();
  const patternPath = slashIdx === -1 ? "/" : afterStar.slice(slashIdx);

  if (supplied.protocol !== `${scheme}:`) return false;
  if (supplied.pathname !== patternPath) return false;

  const suppliedHost = supplied.host.toLowerCase();
  // Pattern host == "*." + baseHost; must match `<one-label>.<baseHost>`.
  // Reject if the supplied host *is* baseHost (the wildcard requires a
  // subdomain) or if the prefix contains a dot (multi-label).
  const suffix = `.${baseHost}`;
  if (!suppliedHost.endsWith(suffix)) return false;
  const prefix = suppliedHost.slice(0, suppliedHost.length - suffix.length);
  if (prefix.length === 0) return false; // bare baseHost not allowed
  if (prefix.includes(".")) return false; // only one label deep
  return true;
}
