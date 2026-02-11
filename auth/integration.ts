/**
 * Auth Integration with Disc Server
 */

import { AuthProvider } from "./provider.ts";
import { AuthMiddleware, AuthContext } from "./middleware.ts";
import { AuthConfig, AuthResponse, LoginCredentials, RegisterData } from "./types.ts";
import { DatabaseConnection } from "../lib/database.ts";

export interface AuthIntegration {
  provider: AuthProvider;
  middleware: AuthMiddleware;
  routes: AuthRoutes;
}

export class AuthRoutes {
  constructor(
    private provider: AuthProvider,
    private middleware: AuthMiddleware
  ) {}

  /**
   * Handle user registration
   */
  register(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
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
  logout(): (request: Request) => Promise<Response> {
    return this.middleware.requireAuth(async (request: Request, context?: AuthContext) => {
      try {
        // Get session ID from request body or extract from token
        const url = new URL(request.url);
        const sessionId = url.searchParams.get("session_id");

        if (sessionId) {
          await this.provider.logout(sessionId);
        } else {
          // Logout current session - we'd need session tracking for this
          // For now, just return success
        }

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    });
  }

  /**
   * Handle token refresh
   */
  refresh(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      try {
        const body = await request.json();
        const refreshToken = body.refresh_token;

        if (!refreshToken) {
          return new Response(
            JSON.stringify({ error: "Refresh token required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
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
  profile(): (request: Request) => Promise<Response> {
    return this.middleware.requireAuth(async (request: Request, context?: AuthContext) => {
      try {
        const user = await this.provider.get_user(context!.user_id);

        if (!user) {
          return new Response(
            JSON.stringify({ error: "User not found" }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Remove sensitive data
        const { password_hash, ...safeUser } = user;

        return new Response(JSON.stringify(safeUser), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    });
  }

  /**
   * Update password
   */
  updatePassword(): (request: Request) => Promise<Response> {
    return this.middleware.requireAuth(async (request: Request, context?: AuthContext) => {
      try {
        const body = await request.json();
        const { old_password, new_password } = body;

        if (!old_password || !new_password) {
          return new Response(
            JSON.stringify({ error: "Both old and new passwords are required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        await this.provider.update_password(
          context!.user_id,
          old_password,
          new_password
        );

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    });
  }

  /**
   * Request password reset
   */
  resetPasswordRequest(): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      try {
        const body = await request.json();
        const { email } = body;

        if (!email) {
          return new Response(
            JSON.stringify({ error: "Email is required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const resetToken = await this.provider.reset_password_request(email);

        // In a real implementation, you'd send this token via email
        // For now, just return success (don't expose token in production!)
        return new Response(
          JSON.stringify({
            success: true,
            message: "Password reset email sent"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
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
      try {
        const body = await request.json();
        const { reset_token, new_password } = body;

        if (!reset_token || !new_password) {
          return new Response(
            JSON.stringify({ error: "Reset token and new password are required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        await this.provider.reset_password(reset_token, new_password);

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
            }
          );
        }

        await this.provider.verify_email(token);

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  private handleError(error: any): Response {
    console.error("Auth route error:", error);

    if (error.name === "AuthError") {
      return new Response(
        JSON.stringify({
          error: error.message,
          code: error.code
        }),
        {
          status: error.status_code,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Initialize auth integration
 */
export async function initializeAuth(
  config: AuthConfig,
  db: DatabaseConnection
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
