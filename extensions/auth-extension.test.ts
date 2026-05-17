/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file
/**
 * Tests for AuthExtensionAdapter
 */

import { assertEquals } from "@std/assert";
import type { AuthContext, RequestHandler } from "../auth/middleware.ts";
import type {
  AuthResponse,
  LoginCredentials,
  RegisterData,
  TokenPayload,
  User
} from "../auth/types.ts";
import { AuthExtensionAdapter } from "./auth-extension.ts";
import type { AuthExtensionAdapterOptions } from "./auth-extension.ts";
import type { ExtensionContext } from "./types.ts";

// ── Test helpers ──────────────────────────────────────────────────────

function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false
    },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as unknown as ExtensionContext["logger"]
  };
}

// Minimal stub for AuthProvider — no real database needed.
const mockAuthProvider = {
  getUser: (_userId: string): Promise<User | null> => Promise.resolve(null),
  login: (_credentials: LoginCredentials): Promise<AuthResponse> => Promise.reject(new Error("mock")),
  logout: (_sessionId: string): Promise<void> => Promise.resolve(),
  refresh: (_refreshToken: string): Promise<AuthResponse> => Promise.reject(new Error("mock")),
  register: (_data: RegisterData): Promise<AuthResponse> => Promise.reject(new Error("mock")),
  resetPassword: (_resetToken: string, _newPassword: string): Promise<void> => Promise.resolve(),
  resetPasswordRequest: (_email: string): Promise<string> => Promise.resolve("token"),
  revokeAllSessions: (_userId: string): Promise<void> => Promise.resolve(),
  updatePassword: (
    _userId: string,
    _oldPassword: string,
    _newPassword: string
  ): Promise<void> => Promise.resolve(),
  verifyEmail: (_verificationToken: string): Promise<void> => Promise.resolve(),
  verifyToken: (_token: string): Promise<TokenPayload> => Promise.reject(new Error("Auth provider not initialized"))
};

// Minimal stub for AuthMiddleware.
const mockAuthMiddleware = {
  authenticate: (_request: Request): Promise<AuthContext | null> => Promise.resolve(null),
  optionalAuth: (handler: RequestHandler) => handler,
  requireAuth: (handler: RequestHandler) => handler,
  withCORS: (handler: RequestHandler) => handler,
  withSecurityHeaders: (handler: RequestHandler) => handler
};

// Minimal stub for AuthRoutes — each method returns a handler that returns 200.
function makeOkHandler() {
  return (_req: Request) =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
}

const mockAuthRoutes = {
  login: makeOkHandler,
  logout: makeOkHandler,
  profile: makeOkHandler,
  refresh: makeOkHandler,
  register: makeOkHandler,
  resetPassword: makeOkHandler,
  resetPasswordRequest: makeOkHandler,
  updatePassword: makeOkHandler,
  verifyEmail: makeOkHandler
};

function makeAdapter(): AuthExtensionAdapter {
  const options: AuthExtensionAdapterOptions = {
    authMiddleware: mockAuthMiddleware as unknown as ConstructorParameters<
      typeof AuthExtensionAdapter
    >[0]["authMiddleware"],
    authProvider: mockAuthProvider as unknown as ConstructorParameters<
      typeof AuthExtensionAdapter
    >[0]["authProvider"],
    authRoutes: mockAuthRoutes as unknown as ConstructorParameters<
      typeof AuthExtensionAdapter
    >[0]["authRoutes"]
  };
  return new AuthExtensionAdapter(options);
}

// ── Metadata ──────────────────────────────────────────────────────────

Deno.test("AuthExtensionAdapter - metadata name is auth", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.metadata.name, "auth");
});

Deno.test("AuthExtensionAdapter - metadata version is 1.0.0", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.metadata.version, "1.0.0");
});

Deno.test("AuthExtensionAdapter - metadata description is set", () => {
  const adapter = makeAdapter();
  assertEquals(typeof adapter.metadata.description, "string");
  assertEquals((adapter.metadata.description ?? "").length > 0, true);
});

// ── Routes ────────────────────────────────────────────────────────────

Deno.test("AuthExtensionAdapter - getRoutes returns exactly 9 routes", () => {
  const adapter = makeAdapter();
  const routes = adapter.getRoutes();
  assertEquals(routes.length, 9);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/register", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/register"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/login", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/login"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/logout", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/logout"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/refresh", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/refresh"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/profile", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/profile"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/password", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/password"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/reset", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/reset"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/reset/confirm", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/reset/confirm"), true);
});

Deno.test("AuthExtensionAdapter - getRoutes includes /auth/verify", () => {
  const adapter = makeAdapter();
  const paths = adapter.getRoutes().map(r => r.path);
  assertEquals(paths.includes("/auth/verify"), true);
});

// ── Lifecycle ─────────────────────────────────────────────────────────

Deno.test("AuthExtensionAdapter - state starts as uninitialized", () => {
  const adapter = makeAdapter();
  assertEquals(adapter.state, "uninitialized");
});

Deno.test("AuthExtensionAdapter - initialize sets state to ready", async () => {
  const adapter = makeAdapter();
  await adapter.initialize(makeContext());
  assertEquals(adapter.state, "ready");
});

Deno.test("AuthExtensionAdapter - shutdown sets state to shutdown", async () => {
  const adapter = makeAdapter();
  await adapter.initialize(makeContext());
  await adapter.shutdown();
  assertEquals(adapter.state, "shutdown");
});

// ── Middleware ────────────────────────────────────────────────────────

Deno.test("AuthExtensionAdapter - getMiddleware returns one middleware entry", () => {
  const adapter = makeAdapter();
  const middleware = adapter.getMiddleware();
  assertEquals(middleware.length, 1);
  assertEquals(middleware[0].name, "auth");
});

// ── Database setup ────────────────────────────────────────────────────

Deno.test("AuthExtensionAdapter - getDatabaseSetup includes users table DDL", () => {
  const adapter = makeAdapter();
  const setup = adapter.getDatabaseSetup();
  const combined = setup.setupSql.join("\n");
  assertEquals(combined.includes("CREATE TABLE IF NOT EXISTS users"), true);
});

Deno.test("AuthExtensionAdapter - getDatabaseSetup includes sessions table DDL", () => {
  const adapter = makeAdapter();
  const setup = adapter.getDatabaseSetup();
  const combined = setup.setupSql.join("\n");
  assertEquals(combined.includes("CREATE TABLE IF NOT EXISTS sessions"), true);
});

// ── Health check ──────────────────────────────────────────────────────

Deno.test("AuthExtensionAdapter - healthCheck returns unhealthy before initialize", async () => {
  const adapter = makeAdapter();
  const result = await adapter.healthCheck();
  assertEquals(result.healthy, false);
});

Deno.test("AuthExtensionAdapter - healthCheck returns healthy after initialize when provider is up", async () => {
  // Provide a mock that throws an AuthError-like error (not "not initialized"),
  // which means the provider is initialized and operational.
  const initializedProvider = {
    ...mockAuthProvider,
    verifyToken: (_token: string): Promise<TokenPayload> => {
      const err = new Error("Invalid token");
      (err as Error & { name: string; }).name = "AuthError";
      return Promise.reject(err);
    }
  };

  const adapter = new AuthExtensionAdapter({
    authMiddleware: mockAuthMiddleware as unknown as ConstructorParameters<
      typeof AuthExtensionAdapter
    >[0]["authMiddleware"],
    authProvider: initializedProvider as unknown as ConstructorParameters<
      typeof AuthExtensionAdapter
    >[0]["authProvider"],
    authRoutes: mockAuthRoutes as unknown as ConstructorParameters<
      typeof AuthExtensionAdapter
    >[0]["authRoutes"]
  });

  await adapter.initialize(makeContext());
  const result = await adapter.healthCheck();
  assertEquals(result.healthy, true);
});
