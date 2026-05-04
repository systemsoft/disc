import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { AuthProvider } from "./provider.ts";
import {
  AuthConfig,
  AuthErrorCode,
  LoginCredentials,
  RegisterData,
} from "./types.ts";
import { TestDatabase } from "./test-database.ts";
import { configureLogging } from "../lib/logger.ts";

describe("AuthProvider", () => {
  let provider: AuthProvider;
  let db: TestDatabase;
  const testConfig: AuthConfig = {
    jwtSecret: "test-secret-key-for-testing-only",
    bcryptRounds: 10,
    tokenExpiry: 3600,
    refreshTokenExpiry: 86400,
    allowRegistration: true,
    passwordMinLength: 8,
  };

  beforeEach(async () => {
    // Use test database
    db = new TestDatabase();
    await db.connect();
    provider = new AuthProvider(testConfig, db as any);
    await provider.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("User Registration", () => {
    it("should register a new user successfully", async () => {
      const registerData: RegisterData = {
        email: "test@example.com",
        password: "SecurePass123!",
        username: "testuser",
      };

      const response = await provider.register(registerData);

      assertExists(response.user);
      assertEquals(response.user.email, "test@example.com");
      assertEquals(response.user.username, "testuser");
      assertExists(response.token);
      assertExists(response.session);
    });

    it("should hash passwords correctly", async () => {
      const registerData: RegisterData = {
        email: "hash@example.com",
        password: "PlainTextPassword123!",
      };

      const response = await provider.register(registerData);
      const user = await provider.getUser(response.user.id);

      // Password should be hashed, not plain text
      assertExists(user);
      assertNotEquals(user.passwordHash, "PlainTextPassword123!");
      // Hash should be bcrypt format ($2b$...)
      assert(user.passwordHash.startsWith("$2"));
    });

    it("should reject duplicate email registration", async () => {
      const registerData: RegisterData = {
        email: "duplicate@example.com",
        password: "SecurePass123!",
      };

      await provider.register(registerData);

      await assertRejects(
        () => provider.register(registerData),
        Error,
        AuthErrorCode.USER_ALREADY_EXISTS,
      );
    });

    it("should validate password strength", async () => {
      const weakPassword: RegisterData = {
        email: "weak@example.com",
        password: "weak",
      };

      await assertRejects(
        () => provider.register(weakPassword),
        Error,
        AuthErrorCode.PASSWORD_TOO_WEAK,
      );
    });

    it("should reject registration when disabled", async () => {
      const noRegProvider = new AuthProvider(
        { ...testConfig, allowRegistration: false },
        db,
      );
      await noRegProvider.initialize();

      const registerData: RegisterData = {
        email: "test@example.com",
        password: "SecurePass123!",
      };

      await assertRejects(
        () => noRegProvider.register(registerData),
        Error,
        AuthErrorCode.REGISTRATION_DISABLED,
      );
    });
  });

  describe("User Login", () => {
    const testUser: RegisterData = {
      email: "login@example.com",
      password: "MyPassword123!",
      username: "loginuser",
    };

    beforeEach(async () => {
      await provider.register(testUser);
    });

    it("should login with valid email and password", async () => {
      const credentials: LoginCredentials = {
        email: "login@example.com",
        password: "MyPassword123!",
      };

      const response = await provider.login(credentials);

      assertExists(response.user);
      assertEquals(response.user.email, "login@example.com");
      assertExists(response.token);
      assertExists(response.session);
    });

    it("should login with username and password", async () => {
      const credentials: LoginCredentials = {
        username: "loginuser",
        password: "MyPassword123!",
      };

      const response = await provider.login(credentials);

      assertExists(response.user);
      assertEquals(response.user.username, "loginuser");
    });

    it("should reject invalid password", async () => {
      const credentials: LoginCredentials = {
        email: "login@example.com",
        password: "WrongPassword",
      };

      await assertRejects(
        () => provider.login(credentials),
        Error,
        AuthErrorCode.INVALID_CREDENTIALS,
      );
    });

    it("should reject non-existent user with generic error (P1-35)", async () => {
      const credentials: LoginCredentials = {
        email: "nonexistent@example.com",
        password: "AnyPassword123!",
      };

      // P1-35: to prevent email enumeration, missing users produce the
      // same INVALID_CREDENTIALS error as wrong-password cases.
      await assertRejects(
        () => provider.login(credentials),
        Error,
        AuthErrorCode.INVALID_CREDENTIALS,
      );
    });

    it("should not leak account existence by timing (gh/geldata#9137)", async () => {
      // P1-35 made wrong-password and no-such-user return the same error
      // *message*. This test guards the matching *time*: without the
      // dummy bcrypt compare on the no-user path, an attacker could
      // distinguish the two by stopwatch (DB-only is ~1ms, bcrypt is
      // ~50ms+). Bounds are generous to keep CI stable.
      const wrongPassword: LoginCredentials = {
        email: "login@example.com",
        password: "WrongPassword",
      };
      const noSuchUser: LoginCredentials = {
        email: "definitely-not-a-real-user@example.com",
        password: "AnyPassword123!",
      };

      // Warm up — first bcrypt call after init is sometimes slower.
      await provider.login(wrongPassword).catch(() => {});

      const t0 = performance.now();
      await provider.login(wrongPassword).catch(() => {});
      const wrongPasswordMs = performance.now() - t0;

      const t1 = performance.now();
      await provider.login(noSuchUser).catch(() => {});
      const noSuchUserMs = performance.now() - t1;

      // The no-user path should be at least 30% of the wrong-password
      // path. Without the mitigation it would be ~1% (DB query only).
      // The actual ratio in practice is ~95%; this loose bound just
      // catches a regression where the mitigation goes missing.
      const ratio = noSuchUserMs / wrongPasswordMs;
      assert(
        ratio > 0.3,
        `timing ratio ${ratio.toFixed(2)} (no-user ${noSuchUserMs.toFixed(1)}ms vs wrong-pw ${wrongPasswordMs.toFixed(1)}ms) — dummy compare missing?`,
      );
    });

    it("should reject inactive users", async () => {
      // Deactivate user
      await db.execute(
        "UPDATE users SET active = false WHERE email = ?",
        ["login@example.com"],
      );

      const credentials: LoginCredentials = {
        email: "login@example.com",
        password: "MyPassword123!",
      };

      await assertRejects(
        () => provider.login(credentials),
        Error,
        AuthErrorCode.USER_INACTIVE,
      );
    });
  });

  describe("Token Management", () => {
    it("should generate valid JWT tokens", async () => {
      const registerData: RegisterData = {
        email: "token@example.com",
        password: "TokenPass123!",
      };

      const response = await provider.register(registerData);
      const payload = await provider.verifyToken(response.token);

      assertExists(payload);
      assertEquals(payload.email, "token@example.com");
      assertEquals(payload.sub, response.user.id);
      assert(payload.exp > Date.now() / 1000);
    });

    it("should reject expired tokens", async () => {
      // gh/geldata#7006: validator now rejects tokenExpiry ≤ 0; use 1
      // (the minimum) and wait past it. Adds ~1.1s but matches what an
      // operator could actually configure.
      const shortExpiryProvider = new AuthProvider(
        { ...testConfig, tokenExpiry: 1 },
        db,
      );
      await shortExpiryProvider.initialize();

      const registerData: RegisterData = {
        email: "expired@example.com",
        password: "ExpiredPass123!",
      };

      const response = await shortExpiryProvider.register(registerData);

      // Wait past the 1-second exp so the JWT is genuinely expired.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await assertRejects(
        () => shortExpiryProvider.verifyToken(response.token),
        Error,
        AuthErrorCode.TOKEN_EXPIRED,
      );
    });

    it("should refresh tokens successfully", async () => {
      const registerData: RegisterData = {
        email: "refresh@example.com",
        password: "RefreshPass123!",
      };

      const response = await provider.register(registerData);
      assertExists(response.refreshToken);

      const newResponse = await provider.refresh(response.refreshToken!);

      assertExists(newResponse.token);
      assertNotEquals(newResponse.token, response.token);
      assertEquals(newResponse.user.email, "refresh@example.com");
    });

    it("should reject invalid refresh tokens", async () => {
      await assertRejects(
        () => provider.refresh("invalid-refresh-token"),
        Error,
        AuthErrorCode.INVALID_REFRESH_TOKEN,
      );
    });
  });

  describe("Session Management", () => {
    it("should create sessions on login", async () => {
      const registerData: RegisterData = {
        email: "session@example.com",
        password: "SessionPass123!",
      };

      const response = await provider.register(registerData);

      assertExists(response.session);
      assertExists(response.session.id);
      assertExists(response.session.token);
      assertEquals(response.session.userId, response.user.id);
    });

    it("should logout and invalidate session", async () => {
      const registerData: RegisterData = {
        email: "logout@example.com",
        password: "LogoutPass123!",
      };

      const response = await provider.register(registerData);
      await provider.logout(response.session.id);

      // Verify token should fail after logout
      await assertRejects(
        () => provider.verifyToken(response.token),
        Error,
        AuthErrorCode.SESSION_EXPIRED,
      );
    });

    it("should revoke all user sessions", async () => {
      const registerData: RegisterData = {
        email: "revoke@example.com",
        password: "RevokePass123!",
      };

      const response1 = await provider.register(registerData);

      // Create another session
      const credentials: LoginCredentials = {
        email: "revoke@example.com",
        password: "RevokePass123!",
      };
      const response2 = await provider.login(credentials);

      // Revoke all sessions
      await provider.revokeAllSessions(response1.user.id);

      // Both tokens should be invalid
      await assertRejects(
        () => provider.verifyToken(response1.token),
        Error,
        AuthErrorCode.SESSION_EXPIRED,
      );
      await assertRejects(
        () => provider.verifyToken(response2.token),
        Error,
        AuthErrorCode.SESSION_EXPIRED,
      );
    });
  });

  describe("Password Management", () => {
    const testUser: RegisterData = {
      email: "password@example.com",
      password: "OldPassword123!",
    };

    beforeEach(async () => {
      await provider.register(testUser);
    });

    it("should update password successfully", async () => {
      const response = await provider.login({
        email: "password@example.com",
        password: "OldPassword123!",
      });

      await provider.updatePassword(
        response.user.id,
        "OldPassword123!",
        "NewPassword456!",
      );

      // Old password should fail
      await assertRejects(
        () =>
          provider.login({
            email: "password@example.com",
            password: "OldPassword123!",
          }),
        Error,
        AuthErrorCode.INVALID_CREDENTIALS,
      );

      // New password should work
      const newLogin = await provider.login({
        email: "password@example.com",
        password: "NewPassword456!",
      });
      assertExists(newLogin.user);
    });

    it("should require correct old password for update", async () => {
      const response = await provider.login({
        email: "password@example.com",
        password: "OldPassword123!",
      });

      await assertRejects(
        () =>
          provider.updatePassword(
            response.user.id,
            "WrongOldPassword",
            "NewPassword456!",
          ),
        Error,
        AuthErrorCode.INVALID_CREDENTIALS,
      );
    });

    it("should handle password reset flow", async () => {
      // Request password reset
      const resetToken = await provider.resetPasswordRequest(
        "password@example.com",
      );
      assertExists(resetToken);

      // Reset password with token
      await provider.resetPassword(resetToken, "ResetPassword789!");

      // Login with new password
      const response = await provider.login({
        email: "password@example.com",
        password: "ResetPassword789!",
      });
      assertExists(response.user);
    });

    it("should reject invalid reset tokens", async () => {
      await assertRejects(
        () => provider.resetPassword("invalid-token", "NewPassword123!"),
        Error,
        AuthErrorCode.INVALID_TOKEN,
      );
    });
  });

  describe("Email Verification", () => {
    it("should handle email verification flow", async () => {
      const verifyProvider = new AuthProvider(
        { ...testConfig, requireEmailVerification: true },
        db,
      );
      await verifyProvider.initialize();

      const registerData: RegisterData = {
        email: "verify@example.com",
        password: "VerifyPass123!",
      };

      const response = await verifyProvider.register(registerData);

      // User should be unverified initially
      const user = await verifyProvider.getUser(response.user.id);
      assertExists(user);
      assertEquals(user.emailVerified, false);

      // The plaintext verification token is returned once from register()
      // (caller is expected to email it). The DB holds only the hash, so
      // we can no longer fetch the plaintext back from SELECT.
      assertExists(response.verificationToken);

      // Verify email
      await verifyProvider.verifyEmail(response.verificationToken!);

      // Check user is now verified
      const verifiedUser = await verifyProvider.getUser(response.user.id);
      assertExists(verifiedUser);
      assertEquals(verifiedUser.emailVerified, true);
    });

    it("should reject login for unverified emails when required", async () => {
      const verifyProvider = new AuthProvider(
        { ...testConfig, requireEmailVerification: true },
        db,
      );
      await verifyProvider.initialize();

      const registerData: RegisterData = {
        email: "unverified@example.com",
        password: "UnverifiedPass123!",
      };

      await verifyProvider.register(registerData);

      await assertRejects(
        () =>
          verifyProvider.login({
            email: "unverified@example.com",
            password: "UnverifiedPass123!",
          }),
        Error,
        AuthErrorCode.EMAIL_NOT_VERIFIED,
      );
    });
  });

  describe("Session metadata (P2-21)", () => {
    it("persists ip_address and user_agent on register", async () => {
      const response = await provider.register({
        email: "ip@example.com",
        password: "GoodPass123!",
        meta: { ipAddress: "203.0.113.7", userAgent: "test-agent/1.0" },
      });

      const sessions = await db.query(
        "SELECT ip_address, user_agent FROM sessions WHERE id = ?",
        [response.session.id],
      );
      assertEquals(sessions.rows[0].ip_address, "203.0.113.7");
      assertEquals(sessions.rows[0].user_agent, "test-agent/1.0");
    });

    it("persists meta on login", async () => {
      await provider.register({
        email: "loginmeta@example.com",
        password: "GoodPass123!",
      });
      const response = await provider.login({
        email: "loginmeta@example.com",
        password: "GoodPass123!",
        meta: { ipAddress: "198.51.100.4", userAgent: "ua-2" },
      });

      const sessions = await db.query(
        "SELECT ip_address, user_agent FROM sessions WHERE id = ?",
        [response.session.id],
      );
      assertEquals(sessions.rows[0].ip_address, "198.51.100.4");
      assertEquals(sessions.rows[0].user_agent, "ua-2");
    });

    it("carries new meta forward across refresh", async () => {
      const reg = await provider.register({
        email: "refreshmeta@example.com",
        password: "GoodPass123!",
        meta: { ipAddress: "203.0.113.1", userAgent: "ua-old" },
      });

      const refreshed = await provider.refresh(reg.refreshToken!, {
        ipAddress: "203.0.113.99",
        userAgent: "ua-new",
      });

      const sessions = await db.query(
        "SELECT ip_address, user_agent FROM sessions WHERE id = ?",
        [refreshed.session.id],
      );
      assertEquals(sessions.rows[0].ip_address, "203.0.113.99");
      assertEquals(sessions.rows[0].user_agent, "ua-new");
    });
  });

  describe("Concurrent session limit (P2-22)", () => {
    it("emits an audit event with reason=max_sessions_per_user when cap is hit", async () => {
      // We rely on the audit log signal (which fires from the cap path
      // in createSession) rather than the post-cap session-table state,
      // because the in-memory TestDatabase doesn't sort/filter on
      // expires_at the way real Postgres does — and the cap revokes
      // whichever sessions the SELECT returns. The audit emission proves
      // the cap path executed; the live integration tests against real
      // PG (auth/pg-integration.test.ts) cover end-to-end correctness.
      const events: Array<Record<string, unknown>> = [];
      configureLogging({
        output: (line) => {
          try {
            const entry = JSON.parse(line);
            if (entry.module === "auth") events.push(entry);
          } catch {
            // ignore non-JSON
          }
        },
      });

      try {
        const cappedProvider = new AuthProvider(
          { ...testConfig, maxSessionsPerUser: 1 },
          db as any,
        );
        await cappedProvider.initialize();

        await cappedProvider.register({
          email: "cap@example.com",
          password: "GoodPass123!",
        });
        await cappedProvider.login({
          email: "cap@example.com",
          password: "GoodPass123!",
        });

        const capRevocations = events.filter(
          (e) =>
            e.event === "session_revoked" &&
            e.reason === "max_sessions_per_user",
        );
        assertEquals(
          capRevocations.length >= 1,
          true,
          "expected at least one auth.session_revoked event with reason=max_sessions_per_user",
        );
      } finally {
        configureLogging({ output: undefined });
      }
    });
  });

  describe("Audit hooks (P2-23)", () => {
    it("emits auth.login_succeeded and auth.registered events", async () => {
      const events: Array<Record<string, unknown>> = [];
      configureLogging({
        output: (line) => {
          try {
            const entry = JSON.parse(line);
            if (entry.module === "auth") events.push(entry);
          } catch {
            // ignore non-JSON
          }
        },
      });

      try {
        await provider.register({
          email: "audit@example.com",
          password: "GoodPass123!",
        });
        await provider.login({
          email: "audit@example.com",
          password: "GoodPass123!",
        });

        const eventNames = events.map((e) => e.event);
        assertEquals(eventNames.includes("registered"), true);
        assertEquals(eventNames.includes("login_succeeded"), true);
        assertEquals(eventNames.includes("session_created"), true);
      } finally {
        configureLogging({ output: undefined });
      }
    });
  });
});

function assert(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual === expected) {
    throw new Error(message || `Expected ${actual} to not equal ${expected}`);
  }
}
