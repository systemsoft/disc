import { assertEquals, assertRejects, assertExists } from "@std/assert";
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { AuthProvider } from "./provider.ts";
import { AuthConfig, AuthErrorCode, RegisterData, LoginCredentials } from "./types.ts";
import { TestDatabase } from "./test-database.ts";

describe("AuthProvider", () => {
  let provider: AuthProvider;
  let db: TestDatabase;
  const testConfig: AuthConfig = {
    jwt_secret: "test-secret-key-for-testing-only",
    bcrypt_rounds: 10,
    token_expiry: 3600,
    refresh_token_expiry: 86400,
    allow_registration: true,
    password_min_length: 8,
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
      const user = await provider.get_user(response.user.id);
      
      // Password should be hashed, not plain text
      assertExists(user);
      assertNotEquals(user.password_hash, "PlainTextPassword123!");
      // Hash should be bcrypt format ($2b$...)
      assert(user.password_hash.startsWith("$2"));
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
        AuthErrorCode.USER_ALREADY_EXISTS
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
        AuthErrorCode.PASSWORD_TOO_WEAK
      );
    });

    it("should reject registration when disabled", async () => {
      const noRegProvider = new AuthProvider(
        { ...testConfig, allow_registration: false },
        db
      );
      await noRegProvider.initialize();

      const registerData: RegisterData = {
        email: "test@example.com",
        password: "SecurePass123!",
      };

      await assertRejects(
        () => noRegProvider.register(registerData),
        Error,
        AuthErrorCode.REGISTRATION_DISABLED
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
        AuthErrorCode.INVALID_CREDENTIALS
      );
    });

    it("should reject non-existent user", async () => {
      const credentials: LoginCredentials = {
        email: "nonexistent@example.com",
        password: "AnyPassword123!",
      };

      await assertRejects(
        () => provider.login(credentials),
        Error,
        AuthErrorCode.USER_NOT_FOUND
      );
    });

    it("should reject inactive users", async () => {
      // Deactivate user
      await db.execute(
        "UPDATE users SET active = false WHERE email = ?",
        ["login@example.com"]
      );

      const credentials: LoginCredentials = {
        email: "login@example.com",
        password: "MyPassword123!",
      };

      await assertRejects(
        () => provider.login(credentials),
        Error,
        AuthErrorCode.USER_INACTIVE
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
      const payload = await provider.verify_token(response.token);

      assertExists(payload);
      assertEquals(payload.email, "token@example.com");
      assertEquals(payload.sub, response.user.id);
      assert(payload.exp > Date.now() / 1000);
    });

    it("should reject expired tokens", async () => {
      // Create provider with very short expiry
      const shortExpiryProvider = new AuthProvider(
        { ...testConfig, token_expiry: 0 },
        db
      );
      await shortExpiryProvider.initialize();

      const registerData: RegisterData = {
        email: "expired@example.com",
        password: "ExpiredPass123!",
      };

      const response = await shortExpiryProvider.register(registerData);
      
      // Wait a moment for token to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      await assertRejects(
        () => shortExpiryProvider.verify_token(response.token),
        Error,
        AuthErrorCode.TOKEN_EXPIRED
      );
    });

    it("should refresh tokens successfully", async () => {
      const registerData: RegisterData = {
        email: "refresh@example.com",
        password: "RefreshPass123!",
      };

      const response = await provider.register(registerData);
      assertExists(response.refresh_token);

      const newResponse = await provider.refresh(response.refresh_token!);
      
      assertExists(newResponse.token);
      assertNotEquals(newResponse.token, response.token);
      assertEquals(newResponse.user.email, "refresh@example.com");
    });

    it("should reject invalid refresh tokens", async () => {
      await assertRejects(
        () => provider.refresh("invalid-refresh-token"),
        Error,
        AuthErrorCode.INVALID_REFRESH_TOKEN
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
      assertEquals(response.session.user_id, response.user.id);
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
        () => provider.verify_token(response.token),
        Error,
        AuthErrorCode.SESSION_EXPIRED
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
      await provider.revoke_all_sessions(response1.user.id);

      // Both tokens should be invalid
      await assertRejects(
        () => provider.verify_token(response1.token),
        Error,
        AuthErrorCode.SESSION_EXPIRED
      );
      await assertRejects(
        () => provider.verify_token(response2.token),
        Error,
        AuthErrorCode.SESSION_EXPIRED
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

      await provider.update_password(
        response.user.id,
        "OldPassword123!",
        "NewPassword456!"
      );

      // Old password should fail
      await assertRejects(
        () => provider.login({
          email: "password@example.com",
          password: "OldPassword123!",
        }),
        Error,
        AuthErrorCode.INVALID_CREDENTIALS
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
        () => provider.update_password(
          response.user.id,
          "WrongOldPassword",
          "NewPassword456!"
        ),
        Error,
        AuthErrorCode.INVALID_CREDENTIALS
      );
    });

    it("should handle password reset flow", async () => {
      // Request password reset
      const resetToken = await provider.reset_password_request("password@example.com");
      assertExists(resetToken);

      // Reset password with token
      await provider.reset_password(resetToken, "ResetPassword789!");

      // Login with new password
      const response = await provider.login({
        email: "password@example.com",
        password: "ResetPassword789!",
      });
      assertExists(response.user);
    });

    it("should reject invalid reset tokens", async () => {
      await assertRejects(
        () => provider.reset_password("invalid-token", "NewPassword123!"),
        Error,
        AuthErrorCode.INVALID_TOKEN
      );
    });
  });

  describe("Email Verification", () => {
    it("should handle email verification flow", async () => {
      const verifyProvider = new AuthProvider(
        { ...testConfig, require_email_verification: true },
        db
      );
      await verifyProvider.initialize();

      const registerData: RegisterData = {
        email: "verify@example.com",
        password: "VerifyPass123!",
      };

      const response = await verifyProvider.register(registerData);
      
      // User should be unverified initially
      const user = await verifyProvider.get_user(response.user.id);
      assertExists(user);
      assertEquals(user.email_verified, false);

      // Get verification token (normally sent via email)
      const result = await db.query(
        "SELECT verification_token FROM users WHERE id = ?",
        [response.user.id]
      );
      const verificationToken = result.rows[0].verification_token;

      // Verify email
      await verifyProvider.verify_email(verificationToken);

      // Check user is now verified
      const verifiedUser = await verifyProvider.get_user(response.user.id);
      assertExists(verifiedUser);
      assertEquals(verifiedUser.email_verified, true);
    });

    it("should reject login for unverified emails when required", async () => {
      const verifyProvider = new AuthProvider(
        { ...testConfig, require_email_verification: true },
        db
      );
      await verifyProvider.initialize();

      const registerData: RegisterData = {
        email: "unverified@example.com",
        password: "UnverifiedPass123!",
      };

      await verifyProvider.register(registerData);

      await assertRejects(
        () => verifyProvider.login({
          email: "unverified@example.com",
          password: "UnverifiedPass123!",
        }),
        Error,
        AuthErrorCode.EMAIL_NOT_VERIFIED
      );
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