/**
 * Reverse-proxy header handling (#5030)
 *
 * When Disc runs behind nginx / Traefik / Caddy / a cloud LB, the proxy
 * usually terminates TLS and forwards plaintext over a private network.
 * Disc must know the *original* client's IP and scheme for rate
 * limiting, audit logs, and any URL it generates that should reflect
 * the user-facing scheme.
 *
 * Trusting `X-Forwarded-*` headers unconditionally is a security bug:
 * an attacker hitting Disc directly can spoof their IP for
 * rate-limit evasion, or downgrade a security check by claiming
 * `X-Forwarded-Proto: https`. The `trustProxy` config gates this — set
 * it `true` only when Disc is provably behind a proxy that strips and
 * resets these headers from clients.
 */

/**
 * Extract the client IP. When `trustProxy` is enabled, prefers
 * `X-Forwarded-For` (left-most entry, the original client) and falls
 * back to `X-Real-IP`. Otherwise returns the TCP socket peer.
 *
 * Returns `null` when neither a trusted header nor a socket address is
 * available (caller decides whether to bucket as "anonymous", reject,
 * or log).
 */
export function getClientIp(
  request: Request,
  info: Deno.ServeHandlerInfo,
  trustProxy: boolean
): string | null {
  if (trustProxy) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0].trim();
      if (first)
        return first;
    }
    const realIp = request.headers.get("x-real-ip");
    if (realIp) {
      const trimmed = realIp.trim();
      if (trimmed)
        return trimmed;
    }
  }

  const remote = info.remoteAddr;
  if (remote && "hostname" in remote && remote.hostname) {
    return remote.hostname;
  }
  return null;
}

/**
 * Resolve the user-facing request scheme. Local TLS termination
 * always wins (a request that reached us over HTTPS *is* HTTPS,
 * regardless of any header). When TLS isn't terminated locally and
 * `trustProxy` is on, honor `X-Forwarded-Proto`. Otherwise default
 * to `http`.
 */
export function getRequestScheme(
  request: Request,
  hasTls: boolean,
  trustProxy: boolean
): "http" | "https" {
  if (hasTls)
    return "https";
  if (!trustProxy)
    return "http";

  const proto = request.headers.get("x-forwarded-proto");
  if (!proto)
    return "http";

  // Multiple hops: "https, http" — take the leftmost entry (the client's
  // scheme as seen by the first proxy).
  const first = proto.split(",")[0].trim().toLowerCase();
  return first === "https" ? "https" : "http";
}
