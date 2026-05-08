/**
 * Authentication Middleware for HTTP Requests
 */

import { AuthProvider } from "./provider.ts";
import { TokenPayload } from "./types.ts";

export interface AuthContext extends TokenPayload {
  userId: string;
}

export interface CORSOptions {
  origins?: string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export type RequestHandler = (
  request: Request,
  context?: AuthContext
) => Response | Promise<Response>;

export class AuthMiddleware {
  constructor(private provider: AuthProvider) {}

  /**
   * Extract and verify authentication from request
   */
  async authenticate(request: Request): Promise<AuthContext | null> {
    const token = this.extractToken(request);

    if (!token) {
      return null;
    }

    try {
      const payload = await this.provider.verifyToken(token);
      return {
        ...payload,
        userId: payload.sub
      };
    } catch {
      return null;
    }
  }

  /**
   * Require authentication for a route
   */
  requireAuth(handler: RequestHandler): RequestHandler {
    return async (request: Request) => {
      const context = await this.authenticate(request);

      if (!context) {
        return new Response(
          JSON.stringify({ error: "Authentication required" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      return handler(request, context);
    };
  }

  /**
   * Optional authentication - adds context if authenticated
   */
  optionalAuth(handler: RequestHandler): RequestHandler {
    return async (request: Request) => {
      const context = await this.authenticate(request);
      return handler(request, context ?? undefined);
    };
  }

  /**
   * Add security headers to response
   */
  withSecurityHeaders(handler: RequestHandler): RequestHandler {
    return async (request: Request, context?: AuthContext) => {
      const response = await handler(request, context);

      // Add security headers
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("X-Frame-Options", "DENY");
      response.headers.set("X-XSS-Protection", "1; mode=block");
      response.headers.set(
        "Referrer-Policy",
        "strict-origin-when-cross-origin"
      );
      response.headers.set(
        "Content-Security-Policy",
        // P1-34: removed script-src 'unsafe-inline'. Inline scripts must use
        // a nonce or be moved into external files. Style inline is retained
        // until the admin UI ships nonce-based CSS.
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';"
      );

      return response;
    };
  }

  /**
   * Handle CORS.
   *
   * Secure-by-default: callers must opt in to CORS by specifying `origins`
   * explicitly. The `"*"` + `credentials: true` combination is refused (the
   * browser rejects it anyway; callers almost never want it and it's a
   * common footgun). (P0-06)
   */
  withCORS(handler: RequestHandler, options: CORSOptions = {}): RequestHandler {
    const {
      origins = [], // default deny — caller must opt in
      methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      headers = ["Content-Type", "Authorization"],
      credentials = false, // default no-credentials — safer cross-origin default
      maxAge = 86400
    } = options;

    if (credentials && origins.includes("*")) {
      throw new Error(
        "CORS misconfiguration: credentials=true is incompatible with origins:['*']. " +
          "Specify explicit allowed origins when sharing credentials."
      );
    }

    const isAllowed = (origin: string | null): origin is string => !!origin && (origins.includes("*") || origins.includes(origin));

    return async (request: Request, context?: AuthContext) => {
      const origin = request.headers.get("Origin");

      // Handle preflight requests
      if (request.method === "OPTIONS") {
        const response = new Response(null, { status: 204 });

        if (isAllowed(origin)) {
          response.headers.set("Access-Control-Allow-Origin", origin);
          response.headers.set(
            "Access-Control-Allow-Methods",
            methods.join(", ")
          );
          response.headers.set(
            "Access-Control-Allow-Headers",
            headers.join(", ")
          );
          if (credentials) {
            response.headers.set("Access-Control-Allow-Credentials", "true");
          }
          response.headers.set("Access-Control-Max-Age", maxAge.toString());
        }

        return response;
      }

      // Handle actual request
      const response = await handler(request, context);

      if (isAllowed(origin)) {
        response.headers.set("Access-Control-Allow-Origin", origin);
        if (credentials) {
          response.headers.set("Access-Control-Allow-Credentials", "true");
        }
      }

      return response;
    };
  }

  /**
   * Extract token from request.
   *
   * Accepts the token from:
   *   - `Authorization: Bearer …` header (recommended)
   *   - `auth_token` HttpOnly cookie (session-based clients)
   *
   * Tokens MUST NOT be accepted via URL query string — they leak into
   * browser history, HTTP access logs, Referer headers, and third-party
   * analytics. If a caller needs to pass a token in the URL they should
   * migrate to the Authorization header instead (P0-04).
   */
  private extractToken(request: Request): string | null {
    // Check Authorization header
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }

    // Check cookie
    const cookies = this.parseCookies(request.headers.get("Cookie") || "");
    if (cookies.auth_token) {
      return cookies.auth_token;
    }

    return null;
  }

  /**
   * Parse cookies from header
   */
  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};

    cookieHeader.split(";").forEach(cookie => {
      const [key, value] = cookie.trim().split("=");
      if (key && value) {
        cookies[key] = decodeURIComponent(value);
      }
    });

    return cookies;
  }
}

/**
 * Create auth middleware with default configuration
 */
export function createAuthMiddleware(provider: AuthProvider): AuthMiddleware {
  return new AuthMiddleware(provider);
}
