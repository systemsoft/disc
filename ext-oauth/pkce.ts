/**
 * PKCE (RFC 7636) helpers.
 *
 * RFC 7636 §4.1 specifies the **unpadded** base64url form for both
 * `code_verifier` and `code_challenge`. Some clients still emit the
 * padded form (`=` characters trailing the encoding), and strict
 * byte-equal comparison rejects those even when the underlying bytes
 * match. The fix is to normalise inbound PKCE params to unpadded
 * base64url before comparison or before forwarding them to upstream
 * providers. (gh/geldata#7596)
 *
 * Aliasing (gh/geldata#7026): RFC 7636 names the parameters
 * `code_challenge`, `code_challenge_method`, and `code_verifier`. Disc
 * uses these RFC names exclusively at every hop (see
 * `state-manager.ts`, `extension.ts`, `token-exchange.ts`); no legacy
 * short forms (`challenge`, `verifier`) are accepted. `pickPkceParam`
 * is here so any future client-supplied PKCE entry point can route
 * through one normaliser.
 */

/**
 * Strip RFC 7636-disallowed trailing `=` padding from a PKCE param.
 * Returns the value unchanged when no trailing padding is present.
 * Only the trailing run of `=` is removed — internal `=` (which
 * shouldn't appear in well-formed base64url anyway) is left alone so
 * malformed input still fails downstream rather than silently sliding
 * through.
 */
export function normalizePkceParam(value: string): string {
  // String#replace with a regex anchored at end-of-input is the
  // smallest expression that says "trailing =". TextDecoder/encoder
  // round-trips would be heavier and lose the type guarantee.
  return value.replace(/=+$/, "");
}

/**
 * Pull a PKCE param from a URLSearchParams / Record using the RFC name
 * first, falling back to a configured legacy alias if present. Any
 * trailing `=` padding is stripped via `normalizePkceParam`. Returns
 * `null` when neither name is present.
 *
 * Today the only call sites use the RFC names exclusively; this is the
 * shim other code can adopt without spreading param-name knowledge.
 */
export function pickPkceParam(
  source: URLSearchParams | Record<string, string | undefined>,
  rfcName: string,
  legacyAlias?: string
): string | null {
  const get = (name: string): string | undefined => {
    if (source instanceof URLSearchParams) {
      return source.get(name) ?? undefined;
    }
    return source[name];
  };

  const rfc = get(rfcName);
  if (typeof rfc === "string" && rfc.length > 0) {
    return normalizePkceParam(rfc);
  }
  if (legacyAlias) {
    const legacy = get(legacyAlias);
    if (typeof legacy === "string" && legacy.length > 0) {
      return normalizePkceParam(legacy);
    }
  }
  return null;
}
