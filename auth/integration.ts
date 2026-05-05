/**
 * Auth Integration with Disc Server
 */

import { getLogger } from "../lib/logger.ts";
import { AuthProvider } from "./provider.ts";
import { AuthContext, AuthMiddleware, RequestHandler } from "./middleware.ts";
import { AuthConfig, LoginCredentials, RegisterData } from "./types.ts";
import type { CaptchaEndpoint } from "./captcha.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { RateLimiter } from "../server/rate-limiter.ts";

const log = getLogger("auth");

/**
 * Default per-IP rate limits for unauthenticated auth endpoints (P0-05).
 *
 * These defaults are deliberately tight: the endpoints are high-value targets
 * for brute-force (login) and spam (reset/verify). Legitimate users hit them
 * only a handful of times per session; bots hit them thousands of times.
 *
 * Override via AuthRoutesOptions.rateLimiter if tighter / looser limits are
 * needed, or pass null to opt out entirely.
 */
const DEFAULT_AUTH_RATE_LIMIT = {
  requestsPerMinute: 10,
  burstSize: 5,
};

export interface AuthRoutesOptions {
  /**
   * Rate limiter for login / register / password-reset endpoints.
   *
   * - Omit to use per-IP defaults (10/min, burst 5).
   * - Pass an existing RateLimiter to share counters with other endpoints.
   * - Pass `null` to disable rate limiting (not recommended in production).
   */
  rateLimiter?: RateLimiter | null;
}

/**
 * Extract a client IP for rate-limiting purposes. Prefers X-Forwarded-For
 * (common behind proxies/load balancers), falls back to X-Real-IP, then to
 * a stable "anonymous" bucket so the limiter still degrades gracefully when
 * no IP header is available.
 */
function extractClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // "client, proxy1, proxy2" — take the left-most entry
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "anonymous";
}

/**
 * Build a `RequestMeta` payload for a session-creating call. Returns a
 * concrete IP only when one was actually provided in headers (the
 * "anonymous" bucket extractClientIp uses for rate-limiting would
 * pollute the audit log if persisted as the session's IP).
 * (P2-21)
 */
function extractRequestMeta(
  request: Request,
): { ipAddress?: string; userAgent?: string } {
  const ip = extractClientIp(request);
  const ua = request.headers.get("user-agent") ?? undefined;
  return {
    ipAddress: ip === "anonymous" ? undefined : ip,
    userAgent: ua,
  };
}

export interface AuthIntegration {
  provider: AuthProvider;
  middleware: AuthMiddleware;
  routes: AuthRoutes;
}

export class AuthRoutes {
  private rateLimiter: RateLimiter | null;

  constructor(
    private provider: AuthProvider,
    private middleware: AuthMiddleware,
    options: AuthRoutesOptions = {},
  ) {
    // null → explicitly disabled; undefined → default limiter
    if (options.rateLimiter === null) {
      this.rateLimiter = null;
    } else {
      this.rateLimiter = options.rateLimiter ??
        new RateLimiter(DEFAULT_AUTH_RATE_LIMIT);
    }
  }

  /**
   * Reject requests that exceed the per-IP rate limit on sensitive auth
   * endpoints (P0-05). Returns a 429 response with Retry-After when blocked,
   * or null when the request is allowed to proceed.
   */
  private checkRateLimit(request: Request): Response | null {
    if (!this.rateLimiter) return null;
    const ip = extractClientIp(request);
    if (this.rateLimiter.allow(ip)) return null;
    return new Response(
      JSON.stringify({
        error: "Too many requests",
        code: "RATE_LIMIT_EXCEEDED",
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      },
    );
  }

  /**
   * Reject requests that are missing or fail captcha verification on
   * gated endpoints (gh/geldata#7341). Returns `null` when the
   * verifier doesn't gate this endpoint, the token verifies, or no
   * captcha is configured. Otherwise returns a 400/403 Response.
   *
   * Body-clone strategy: this method clones the request before
   * reading JSON so the original body remains consumable by the route
   * handler that follows. The handlers read `await request.json()`
   * directly, and a Request body can only be read once.
   */
  private async checkCaptcha(
    request: Request,
    endpoint: CaptchaEndpoint,
  ): Promise<Response | null> {
    const verifier = this.provider.captchaVerifier;
    if (!verifier.isGated(endpoint)) return null;

    let token: unknown;
    try {
      const body = await request.clone().json();
      token = body?.captchaToken;
    } catch {
      // Body wasn't JSON — treat as missing token.
      token = undefined;
    }

    if (typeof token !== "string" || token.length === 0) {
      return new Response(
        JSON.stringify({
          error: "Captcha required",
          code: "CAPTCHA_REQUIRED",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const meta = extractRequestMeta(request);
    const result = await verifier.verify(token, meta.ipAddress);
    if (!result.success) {
      log.warn("captcha verification failed", {
        endpoint,
        errorCodes: result.errorCodes,
      });
      return new Response(
        JSON.stringify({
          error: "Captcha verification failed",
          code: "CAPTCHA_FAILED",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return null;
  }

  /**
   * Release rate limiter resources (call from dispose paths).
   */
  dispose(): void {
    this.rateLimiter?.dispose();
  }

  /**
   * Handle user registration
   */
  register(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      const captchaCheck = await this.checkCaptcha(request, "register");
      if (captchaCheck) return captchaCheck;
      try {
        const body = await request.json();
        const data: RegisterData = {
          email: body.email,
          password: body.password,
          username: body.username,
          metadata: body.metadata,
          meta: extractRequestMeta(request),
        };

        const response = await this.provider.register(data);

        return new Response(JSON.stringify(response), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Handle user login
   */
  login(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      const captchaCheck = await this.checkCaptcha(request, "login");
      if (captchaCheck) return captchaCheck;
      try {
        const body = await request.json();
        const credentials: LoginCredentials = {
          email: body.email,
          username: body.username,
          password: body.password,
          meta: extractRequestMeta(request),
        };

        const response = await this.provider.login(credentials);

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Handle logout
   */
  logout(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, _context?: AuthContext) => {
        try {
          // P1-36: require sessionId — previously, calling /auth/logout
          // without one silently returned success and revoked nothing.
          // Accept from query string OR JSON body; reject if missing.
          const url = new URL(request.url);
          let sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            try {
              const body = await request.clone().json();
              if (body && typeof body.sessionId === "string") {
                sessionId = body.sessionId;
              }
            } catch {
              // body isn't JSON — ignore and fall through to the error below
            }
          }

          if (!sessionId) {
            return new Response(
              JSON.stringify({
                error: "sessionId is required",
                code: "MISSING_SESSION_ID",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          await this.provider.logout(sessionId);

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Handle token refresh
   */
  refresh(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      try {
        const body = await request.json();
        const refreshToken = body.refreshToken;

        if (!refreshToken) {
          return new Response(
            JSON.stringify({ error: "Refresh token required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const response = await this.provider.refresh(
          refreshToken,
          extractRequestMeta(request),
        );

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Get current user profile
   */
  profile(): RequestHandler {
    return this.middleware.requireAuth(
      async (_request: Request, context?: AuthContext) => {
        try {
          const user = await this.provider.getUser(context!.userId);

          if (!user) {
            return new Response(
              JSON.stringify({ error: "User not found" }),
              {
                status: 404,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Remove sensitive data
          const { passwordHash: _passwordHash, ...safeUser } = user;

          return new Response(JSON.stringify(safeUser), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Update password
   */
  updatePassword(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, context?: AuthContext) => {
        try {
          const body = await request.json();
          const { old_password, new_password } = body;

          if (!old_password || !new_password) {
            return new Response(
              JSON.stringify({
                error: "Both old and new passwords are required",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          await this.provider.updatePassword(
            context!.userId,
            old_password,
            new_password,
          );

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Request password reset
   */
  resetPasswordRequest(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      const captchaCheck = await this.checkCaptcha(request, "passwordReset");
      if (captchaCheck) return captchaCheck;
      try {
        const body = await request.json();
        const { email } = body;

        if (!email) {
          return new Response(
            JSON.stringify({ error: "Email is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        await this.provider.resetPasswordRequest(email);

        // In a real implementation, you'd send this token via email
        // For now, just return success (don't expose token in production!)
        return new Response(
          JSON.stringify({
            success: true,
            message: "Password reset email sent",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Reset password with token
   */
  resetPassword(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.json();
        const { reset_token, new_password } = body;

        if (!reset_token || !new_password) {
          return new Response(
            JSON.stringify({
              error: "Reset token and new password are required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        await this.provider.resetPassword(reset_token, new_password);

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  // ── WebAuthn routes (gh/geldata#6725) ──────────────────────────────

  /**
   * Begin a WebAuthn registration ceremony for the authenticated user.
   * Returns `PublicKeyCredentialCreationOptions` to hand to
   * `navigator.credentials.create({ publicKey })`.
   */
  beginWebAuthnRegistration(): RequestHandler {
    return this.middleware.requireAuth(
      async (_request: Request, context?: AuthContext) => {
        try {
          const opts = await this.provider.beginWebAuthnRegistration(
            context!.userId,
          );
          return new Response(JSON.stringify(opts), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Finish a WebAuthn registration ceremony. Body is the
   * `WebAuthnRegistrationFinish` object — the caller assembles it
   * from the `PublicKeyCredential` returned by the browser.
   */
  finishWebAuthnRegistration(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, _context?: AuthContext) => {
        try {
          const body = await request.json();
          const result = await this.provider.finishWebAuthnRegistration(body);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Begin a WebAuthn login ceremony. Public + rate-limited. Body may
   * include `email` to scope `allowCredentials`; omit for
   * username-less / discoverable-credential flows.
   */
  beginWebAuthnLogin(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.clone().json().catch(() => ({}));
        const opts = await this.provider.beginWebAuthnLogin(
          body.email ? String(body.email) : undefined,
        );
        return new Response(JSON.stringify(opts), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Finish a WebAuthn login ceremony. Public + rate-limited. Returns
   * `LoginResult` — full session unless the user has TOTP enrolled,
   * in which case an `MfaChallenge` is issued.
   */
  finishWebAuthnLogin(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.json();
        const result = await this.provider.finishWebAuthnLogin(
          body,
          extractRequestMeta(request),
        );
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /** List the authenticated user's registered passkeys. */
  listWebAuthnCredentials(): RequestHandler {
    return this.middleware.requireAuth(
      async (_request: Request, context?: AuthContext) => {
        try {
          const list = await this.provider.listWebAuthnCredentials(
            context!.userId,
          );
          return new Response(JSON.stringify({ credentials: list }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /** Remove a passkey. Body: `{ credentialId: "..." }`. */
  deleteWebAuthnCredential(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, context?: AuthContext) => {
        try {
          const body = await request.json();
          if (!body.credentialId) {
            return new Response(
              JSON.stringify({
                error: "credentialId is required",
                code: "MISSING_CREDENTIAL_ID",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          await this.provider.deleteWebAuthnCredential(
            context!.userId,
            String(body.credentialId),
          );
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  // ── Recovery-code routes (gh/geldata#8186) ─────────────────────────

  /**
   * (Re)generate recovery codes for the authenticated user. Returns
   * the plaintext array — this is the *only* time it's surfaced; show
   * it to the user once and warn them to save it. Calling this again
   * invalidates every previous code.
   */
  generateRecoveryCodes(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, context?: AuthContext) => {
        try {
          const body = await request.clone().json().catch(() => ({}));
          const count = typeof body.count === "number" ? body.count : undefined;
          const codes = await this.provider.generateRecoveryCodes(
            context!.userId,
            count,
          );
          const remaining = await this.provider.recoveryCodesRemaining(
            context!.userId,
          );
          return new Response(
            JSON.stringify({ codes, remaining }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Complete an MFA-gated login by submitting a recovery code instead
   * of a TOTP code. Public (the user can't have a session yet),
   * rate-limited the same as login. Body:
   *   { challengeToken: "...", code: "XXXXX-XXXXX" }
   */
  loginWithRecoveryCode(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.json();
        if (!body.challengeToken || !body.code) {
          return new Response(
            JSON.stringify({
              error: "challengeToken and code are required",
              code: "MISSING_CREDENTIALS",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const response = await this.provider.loginWithRecoveryCode(
          String(body.challengeToken),
          String(body.code),
          extractRequestMeta(request),
        );
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  // ── Magic-link routes (gh/geldata#8186) ────────────────────────────

  /**
   * Request a passwordless login token. Public route, rate-limited the
   * same as login. Body: `{ email: "..." }`. Response is always 200
   * even when the email doesn't exist — the plaintext token is in the
   * response body but is unusable in the no-such-user case (the row
   * was never persisted). This shape is intentional: it lets the
   * caller do the email-delivery and keeps the timing identical to
   * the happy path. Apps that want to email server-side should listen
   * for the `MagicLinkRequested` webhook instead.
   */
  requestMagicLink(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      const captchaCheck = await this.checkCaptcha(request, "magicLink");
      if (captchaCheck) return captchaCheck;
      try {
        const body = await request.json();
        if (!body.email) {
          return new Response(
            JSON.stringify({
              error: "email is required",
              code: "MISSING_EMAIL",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const token = await this.provider.requestMagicLink(
          String(body.email),
          extractRequestMeta(request),
        );
        // The HTTP response body intentionally returns the token — it's
        // the same pattern reset/verify use today, and lets local-dev
        // flows skip the webhook detour. Production deployments should
        // consume the `MagicLinkRequested` webhook and email out-of-band.
        return new Response(
          JSON.stringify({ success: true, magicLinkToken: token }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Redeem a magic-link token. Public route, rate-limited. Body:
   * `{ token: "..." }`. Returns either an `AuthResponse` (full session)
   * or an `MfaChallenge` when the user has TOTP enrolled — same shape
   * union as `login()`.
   */
  consumeMagicLink(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.json();
        if (!body.token) {
          return new Response(
            JSON.stringify({
              error: "token is required",
              code: "MISSING_TOKEN",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const result = await this.provider.consumeMagicLink(
          String(body.token),
          extractRequestMeta(request),
        );
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  // ── Magic-code routes (gh/geldata#7367) ────────────────────────────

  /**
   * Request a passwordless 6-digit login code. Public route,
   * rate-limited the same as login. Body: `{ email: "..." }`. Same
   * anti-enumeration shape as `requestMagicLink`: response is always
   * 200, code is in the body but unusable when the email doesn't
   * match a real user (the row was never persisted). Production
   * deployments should consume the `MagicCodeRequested` webhook and
   * email out-of-band; the SMTP listener does this automatically when
   * configured.
   */
  requestMagicCode(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      const captchaCheck = await this.checkCaptcha(request, "magicCode");
      if (captchaCheck) return captchaCheck;
      try {
        const body = await request.json();
        if (!body.email) {
          return new Response(
            JSON.stringify({
              error: "email is required",
              code: "MISSING_EMAIL",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const code = await this.provider.requestMagicCode(
          String(body.email),
          extractRequestMeta(request),
        );
        return new Response(
          JSON.stringify({ success: true, magicCode: code }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Verify a submitted magic code. Public route, rate-limited. Body:
   * `{ email, code }`. Returns either an `AuthResponse` or an
   * `MfaChallenge` (same union as `login()` and `consumeMagicLink`).
   * Lookup is scoped by email — the code alone is too small (1M
   * possibilities) to be safe as a global key.
   */
  verifyMagicCode(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.json();
        if (!body.email || !body.code) {
          return new Response(
            JSON.stringify({
              error: "email and code are required",
              code: "MISSING_CREDENTIALS",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const result = await this.provider.verifyMagicCode(
          String(body.email),
          String(body.code),
          extractRequestMeta(request),
        );
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  // ── MFA / TOTP routes (gh/geldata#8186) ────────────────────────────

  /**
   * Begin TOTP enrollment for the authenticated user. Returns the
   * base32 secret + an `otpauth://` URI suitable for rendering as a
   * QR code. The user must scan the QR with their authenticator app
   * and confirm via `POST /auth/mfa/totp/confirm`.
   */
  enrollTOTP(): RequestHandler {
    return this.middleware.requireAuth(
      async (_request: Request, context?: AuthContext) => {
        try {
          const enrollment = await this.provider.enrollTOTP(context!.userId);
          return new Response(JSON.stringify(enrollment), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Confirm a pending TOTP enrollment. Body: `{ code: "123456" }`.
   * On success the user's TOTP is active — subsequent logins must
   * include the second-factor step.
   */
  confirmTOTP(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, context?: AuthContext) => {
        try {
          const body = await request.json();
          if (!body.code) {
            return new Response(
              JSON.stringify({ error: "code is required", code: "MISSING_CODE" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          await this.provider.confirmTOTP(context!.userId, String(body.code));
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Disable TOTP for the authenticated user. The route is auth-gated
   * but operators who want a stronger gate (re-prompt for password)
   * should layer that in their own handler.
   */
  disableTOTP(): RequestHandler {
    return this.middleware.requireAuth(
      async (_request: Request, context?: AuthContext) => {
        try {
          await this.provider.disableTOTP(context!.userId);
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Complete an MFA-gated login. Public route (the user can't log in
   * yet — that's the whole point). Body:
   *   { challengeToken: "...", code: "123456" }
   * Rate-limited the same as login.
   */
  loginWithTOTP(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const body = await request.json();
        if (!body.challengeToken || !body.code) {
          return new Response(
            JSON.stringify({
              error: "challengeToken and code are required",
              code: "MISSING_CREDENTIALS",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const response = await this.provider.loginWithTOTP(
          String(body.challengeToken),
          String(body.code),
          extractRequestMeta(request),
        );
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Mint an anonymous (guest) identity. (gh/geldata#8750)
   *
   * Returns the same `AuthResponse` shape as `register()` / `login()` so
   * clients can store the token in the same place. Rate-limited the same
   * as login to keep abusers from creating thousands of guest rows.
   */
  loginAnonymous(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      const limited = this.checkRateLimit(request);
      if (limited) return limited;
      try {
        const response = await this.provider.loginAnonymous(
          extractRequestMeta(request),
        );
        return new Response(JSON.stringify(response), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  /**
   * Promote the currently-authenticated anonymous identity into a full
   * user. Body must include `email` + `password` (and may include
   * `username` / `metadata`). The user id is preserved so downstream
   * rows that reference it stay attached. (gh/geldata#8750)
   */
  upgradeAnonymous(): RequestHandler {
    return this.middleware.requireAuth(
      async (request: Request, context?: AuthContext) => {
        const limited = this.checkRateLimit(request);
        if (limited) return limited;
        try {
          const body = await request.json();
          const data: RegisterData = {
            email: body.email,
            password: body.password,
            username: body.username,
            metadata: body.metadata,
            meta: extractRequestMeta(request),
          };
          if (!data.email || !data.password) {
            return new Response(
              JSON.stringify({
                error: "email and password are required",
                code: "MISSING_CREDENTIALS",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          const response = await this.provider.upgradeAnonymous(
            context!.userId,
            data,
          );
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return this.handleError(error);
        }
      },
    );
  }

  /**
   * Verify email
   */
  verifyEmail(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      try {
        const url = new URL(request.url);
        const token = url.searchParams.get("token");

        if (!token) {
          return new Response(
            JSON.stringify({ error: "Verification token is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        await this.provider.verifyEmail(token);

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  private handleError(error: unknown): Response {
    log.error("Auth route error", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Check for AuthError shape using type narrowing
    if (
      error !== null &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name: unknown }).name === "AuthError"
    ) {
      const authErr = error as unknown as {
        code: string;
        message: string;
        status_code: number;
      };
      return new Response(
        JSON.stringify({
          error: authErr.message,
          code: authErr.code,
        }),
        {
          status: authErr.status_code,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Initialize auth integration
 */
export async function initializeAuth(
  config: AuthConfig,
  db: DatabaseConnection,
): Promise<AuthIntegration> {
  const provider = new AuthProvider(config, db);
  await provider.initialize();

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware);

  return {
    provider,
    middleware,
    routes,
  };
}
