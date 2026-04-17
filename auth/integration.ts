/**
 * Auth Integration with Disc Server
 */

import { getLogger } from "../lib/logger.ts";
import { AuthProvider } from "./provider.ts";
import { AuthContext, AuthMiddleware, RequestHandler } from "./middleware.ts";
import { AuthConfig, LoginCredentials, RegisterData } from "./types.ts";
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
      try {
        const body = await request.json();
        const data: RegisterData = {
          email: body.email,
          password: body.password,
          username: body.username,
          metadata: body.metadata,
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
      try {
        const body = await request.json();
        const credentials: LoginCredentials = {
          email: body.email,
          username: body.username,
          password: body.password,
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

        const response = await this.provider.refresh(refreshToken);

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
