/**
 * AuthManager — Handles authentication lifecycle for the Disc SDK
 */

import type {
  AuthManagerOptions,
  AuthResponse,
  AuthTokens,
  AuthUser,
  LoginCredentials,
  RegisterData,
} from "./types.ts";
import { DiscAuthError } from "./errors.ts";
import type { DiscClient } from "./client.ts";

const DEFAULT_REFRESH_BUFFER = 60; // seconds before expiry to refresh

/**
 * Decode the payload segment of a JWT without verifying the signature.
 * Returns the parsed claims object, or null if the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    // Base64url → base64: replace URL-safe chars and add padding
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + (4 - (base64.length % 4)) % 4,
      "=",
    );
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the `exp` claim (Unix seconds) from a JWT payload.
 * Returns null if missing or malformed.
 */
function getTokenExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (payload === null) {
    return null;
  }
  const exp = payload["exp"];
  if (typeof exp !== "number") {
    return null;
  }
  return exp;
}

export class AuthManager {
  private readonly client: DiscClient;
  private readonly autoRefresh: boolean;
  private readonly refreshBuffer: number;

  private currentUser: AuthUser | null = null;
  private tokens: AuthTokens | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: DiscClient, options?: AuthManagerOptions) {
    this.client = client;
    this.autoRefresh = options?.autoRefresh ?? true;
    this.refreshBuffer = options?.refreshBuffer ?? DEFAULT_REFRESH_BUFFER;
  }

  /**
   * Register a new user account.
   * Stores tokens, sets auth header on the client, and schedules auto-refresh.
   */
  async register(data: RegisterData): Promise<AuthResponse> {
    const response = await this.client.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });

    const authResponse = await response.json() as AuthResponse;
    this.storeSession(authResponse);
    return authResponse;
  }

  /**
   * Login with email/username and password.
   * Stores tokens, sets auth header on the client, and schedules auto-refresh.
   */
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const response = await this.client.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });

    const authResponse = await response.json() as AuthResponse;
    this.storeSession(authResponse);
    return authResponse;
  }

  /**
   * Logout the current user.
   * POSTs to /auth/logout, then clears all local session state.
   */
  async logout(): Promise<void> {
    try {
      await this.client.fetch("/auth/logout", { method: "POST" });
    } finally {
      this.clearSession();
    }
  }

  /**
   * In-flight refresh promise used to serialize concurrent refresh
   * attempts (P1-32). Without this, two callers racing `refreshTokens()`
   * would each POST /auth/refresh; the second call consumes a refresh
   * token that was already used by the first, forcing a re-login.
   */
  private refreshInFlight: Promise<AuthTokens> | null = null;

  /**
   * Refresh the access token using the stored refresh token.
   *
   * Serialized: if a refresh is already in flight, concurrent callers
   * await the same promise rather than issuing duplicate requests.
   *
   * Throws DiscAuthError if no refresh token is available.
   */
  refreshTokens(): Promise<AuthTokens> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const run = async (): Promise<AuthTokens> => {
      if (!this.tokens?.refreshToken) {
        throw new DiscAuthError("No refresh token available");
      }

      const response = await this.client.fetch("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: this.tokens.refreshToken }),
      });

      const newTokens = await response.json() as AuthTokens;
      this.tokens = newTokens;
      this.client.setAuthToken(newTokens.token);
      if (this.autoRefresh) {
        this.scheduleRefresh(newTokens.token);
      }
      return newTokens;
    };

    this.refreshInFlight = run().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /**
   * Fetch the current authenticated user's profile from the server.
   * Throws DiscAuthError if not authenticated.
   */
  async getProfile(): Promise<AuthUser> {
    if (!this.isAuthenticated()) {
      throw new DiscAuthError("Not authenticated");
    }

    const response = await this.client.fetch("/auth/profile");
    const user = await response.json() as AuthUser;
    this.currentUser = user;
    return user;
  }

  /**
   * Update the current user's password.
   * Throws DiscAuthError if not authenticated.
   */
  async updatePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new DiscAuthError("Not authenticated");
    }

    await this.client.fetch("/auth/password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    });
  }

  /**
   * Returns true if the client currently holds a valid auth token.
   */
  isAuthenticated(): boolean {
    return this.client.getAuthToken() !== undefined;
  }

  /**
   * Returns the cached user from the last successful login or register call.
   * Does not make a server request. Returns null if not logged in.
   */
  getUser(): AuthUser | null {
    return this.currentUser;
  }

  /**
   * Cancel any pending auto-refresh timer and free resources.
   */
  dispose(): void {
    this.clearRefreshTimer();
  }

  // --- Private helpers ---

  private storeSession(authResponse: AuthResponse): void {
    const tokens: AuthTokens = {
      token: authResponse.token,
      refreshToken: authResponse.refreshToken,
    };
    this.tokens = tokens;
    this.currentUser = authResponse.user;
    this.client.setAuthToken(tokens.token);

    if (this.autoRefresh) {
      this.scheduleRefresh(tokens.token);
    }
  }

  private clearSession(): void {
    this.clearRefreshTimer();
    this.tokens = null;
    this.currentUser = null;
    this.client.clearAuthToken();
  }

  private scheduleRefresh(token: string): void {
    this.clearRefreshTimer();

    const exp = getTokenExpiry(token);
    if (exp === null) {
      // Token has no expiry claim — nothing to schedule
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const delaySeconds = exp - nowSeconds - this.refreshBuffer;

    if (delaySeconds <= 0) {
      // Token is already near or past expiry; refresh immediately
      this.refreshTimer = setTimeout(() => {
        this.refreshTokens().catch(() => {
          // Silently swallow refresh failures — callers will get auth errors
          // on their next request, which is the appropriate signal
        });
      }, 0);
      return;
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTokens().catch(() => {
        // Same as above: swallow background refresh failures
      });
    }, delaySeconds * 1000);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
