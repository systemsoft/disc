/**
 * OAuth state management with cryptographic nonce
 */

import type { OAuthState } from "./types.ts";

export class OAuthStateManager {
  private states: Map<string, OAuthState> = new Map();
  private defaultExpiryMs: number;

  constructor(expiryMs: number = 600_000) {
    this.defaultExpiryMs = expiryMs;
  }

  createState(provider: string, redirectUri: string): OAuthState {
    const state = crypto.randomUUID();
    const now = Date.now();

    const oauthState: OAuthState = {
      createdAt: now,
      expiresAt: now + this.defaultExpiryMs,
      provider,
      redirectUri,
      state,
    };

    this.states.set(state, oauthState);
    return oauthState;
  }

  validateState(state: string): OAuthState | null {
    const stored = this.states.get(state);
    if (!stored) return null;

    // Remove used state (one-time use)
    this.states.delete(state);

    // Check expiry
    if (Date.now() > stored.expiresAt) return null;

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
