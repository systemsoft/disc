/**
 * OAuth state management with cryptographic nonce + PKCE code verifier.
 *
 * Current implementation stores state in-memory. A restart invalidates
 * every in-flight OAuth handshake — acceptable for single-node dev use
 * but not for load-balanced or restart-heavy deployments. (P1-41: the
 * production-grade replacement is a DB-backed store keyed by `state`
 * with the same API; this module is intentionally swappable via DI.)
 */

import { encodeBase64Url } from "@std/encoding/base64url";
import type { OAuthState } from "./types.ts";

export class OAuthStateManager {
  private states: Map<string, OAuthState> = new Map();
  private defaultExpiryMs: number;

  constructor(expiryMs: number = 600_000) {
    this.defaultExpiryMs = expiryMs;
  }

  async createState(
    provider: string,
    redirectUri: string,
    metadata?: Record<string, unknown>
  ): Promise<OAuthState> {
    const state = crypto.randomUUID();
    const now = Date.now();

    // P1-41: generate a PKCE code_verifier + S256 code_challenge. 32
    // random bytes → 43-char URL-safe string (well inside RFC 7636's
    // 43-128 range). The challenge is SHA-256 of the verifier ASCII.
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = encodeBase64Url(verifierBytes);
    const challengeDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier)
    );
    const codeChallenge = encodeBase64Url(new Uint8Array(challengeDigest));

    const oauthState: OAuthState = {
      createdAt: now,
      expiresAt: now + this.defaultExpiryMs,
      provider,
      redirectUri,
      state,
      codeVerifier,
      codeChallenge,
      metadata
    };

    this.states.set(state, oauthState);
    return oauthState;
  }

  validateState(state: string): OAuthState | null {
    const stored = this.states.get(state);
    if (!stored)
      return null;

    // Remove used state (one-time use)
    this.states.delete(state);

    // Check expiry
    if (Date.now() > stored.expiresAt)
      return null;

    return stored;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (now > state.expiresAt) {
        this.states.delete(key);
      }
    }
  }

  get size(): number {
    return this.states.size;
  }
}
