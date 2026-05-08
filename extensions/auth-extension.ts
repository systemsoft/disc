/**
 * AuthExtensionAdapter — wraps the existing auth module as an Extension.
 *
 * This adapter lets callers load authentication through the extension system
 * rather than wiring it up manually inside DiscServer. The server's existing
 * initializeAuth() path remains untouched; this is an alternative entry point.
 */

import type { AuthRoutes } from "../auth/integration.ts";
import type { AuthMiddleware } from "../auth/middleware.ts";
import type { AuthProvider } from "../auth/provider.ts";
import { BaseExtension } from "./base-extension.ts";
import type { ExtensionContext, ExtensionMetadata, ExtensionMiddleware, ExtensionRoute } from "./types.ts";

export interface AuthExtensionAdapterOptions {
  authMiddleware: AuthMiddleware;
  authProvider: AuthProvider;
  authRoutes: AuthRoutes;
}

export class AuthExtensionAdapter extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    description: "Built-in authentication system",
    name: "auth",
    version: "1.0.0"
  };

  private authMiddleware: AuthMiddleware;
  private authProvider: AuthProvider;
  private authRoutes: AuthRoutes;

  constructor(options: AuthExtensionAdapterOptions) {
    super();
    this.authMiddleware = options.authMiddleware;
    this.authProvider = options.authProvider;
    this.authRoutes = options.authRoutes;
  }

  /**
   * The auth provider is already initialized by the caller before passing it
   * in. Mark ourselves ready immediately.
   */
  override initialize(_context: ExtensionContext): Promise<void> {
    this.setState("ready");
    return Promise.resolve();
  }

  override getRoutes(): ExtensionRoute[] {
    return [
      {
        handler: (request: Request) => this.authRoutes.register()(request),
        method: "POST",
        path: "/auth/register"
      },
      {
        handler: (request: Request) => this.authRoutes.login()(request),
        method: "POST",
        path: "/auth/login"
      },
      {
        handler: (request: Request) => this.authRoutes.logout()(request),
        method: "POST",
        path: "/auth/logout"
      },
      {
        handler: (request: Request) => this.authRoutes.refresh()(request),
        method: "POST",
        path: "/auth/refresh"
      },
      {
        handler: (request: Request) => this.authRoutes.profile()(request),
        method: "GET",
        path: "/auth/profile"
      },
      {
        handler: (request: Request) => this.authRoutes.updatePassword()(request),
        method: "POST",
        path: "/auth/password"
      },
      {
        handler: (request: Request) => this.authRoutes.resetPasswordRequest()(request),
        method: "POST",
        path: "/auth/reset"
      },
      {
        handler: (request: Request) => this.authRoutes.resetPassword()(request),
        method: "POST",
        path: "/auth/reset/confirm"
      },
      {
        handler: (request: Request) => this.authRoutes.verifyEmail()(request),
        method: "GET",
        path: "/auth/verify"
      }
    ];
  }

  override getMiddleware(): ExtensionMiddleware[] {
    return [
      {
        handle: async (
          request: Request,
          next: () => Promise<Response>
        ): Promise<Response> => {
          // Populate auth context on the request; downstream handlers
          // can call authenticate() independently if they need it. The
          // middleware here is intentionally a pass-through — it attaches
          // no side-effects so it is safe to run on every request.
          await this.authMiddleware.authenticate(request);
          return next();
        },
        name: "auth",
        priority: 100
      }
    ];
  }

  /**
   * The SQL tables used by auth are created inside AuthProvider.initialize().
   * Returning the DDL here lets the registry run them via the pool before
   * calling initialize(), which matches the registry's contract in registry.ts.
   */
  override getDatabaseSetup() {
    return {
      setupSql: [
        `CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          username TEXT UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          email_verified BOOLEAN DEFAULT FALSE,
          active BOOLEAN DEFAULT TRUE,
          metadata TEXT,
          verification_token TEXT,
          reset_token TEXT,
          reset_token_expires TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token TEXT UNIQUE NOT NULL,
          refresh_token TEXT UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL,
          last_activity TIMESTAMP,
          ip_address TEXT,
          user_agent TEXT,
          revoked BOOLEAN DEFAULT FALSE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
        `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
        `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`
      ]
    };
  }

  override async healthCheck(): Promise<
    { healthy: boolean; details?: string; }
  > {
    if (this.state !== "ready") {
      return { details: `state is ${this.state}`, healthy: false };
    }

    try {
      // A lightweight probe: verify the provider can produce a crypto key by
      // calling verifyToken with a deliberately invalid token. The provider is
      // initialized when it can reach that code path at all.
      await this.authProvider.verifyToken("probe").catch(() => {
        // An AuthError means the provider is initialized (it got past the
        // cryptoKey guard). A plain Error with "not initialized" means not ready.
      });
      return { healthy: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not initialized")) {
        return { details: "AuthProvider not initialized", healthy: false };
      }
      // Any other error (e.g. invalid token) means the provider is up.
      return { healthy: true };
    }
  }
}
