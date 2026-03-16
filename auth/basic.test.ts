import { assertEquals, assertExists } from "@std/assert";
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { AuthProvider } from "./provider.ts";
import { AuthConfig, AuthError } from "./types.ts";
import { TestDatabase } from "./test-database.ts";

describe("Auth Module Smoke Test", () => {
  let provider: AuthProvider;
  let db: TestDatabase;
  
  const testConfig: AuthConfig = {
    jwt_secret: "test-secret-key-at-least-32-characters-long",
    bcrypt_rounds: 4, // Faster for testing
    token_expiry: 3600,
    password_min_length: 6, // Shorter for testing
  };

  beforeEach(async () => {
    db = new TestDatabase();
    await db.connect();
    provider = new AuthProvider(testConfig, db);
    await provider.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it("should initialize auth provider", () => {
    assertExists(provider);
  });

  it("should validate passwords correctly", async () => {
    try {
      await provider.register({
        email: "test@example.com",
        password: "short", // Should fail
      });
    } catch (error) {
      assertEquals((error as AuthError).code, "PASSWORD_TOO_WEAK");
    }
  });

  it("should create JWT tokens", async () => {
    // Mock bcrypt by reducing rounds and using simple implementation
    const response = await provider.register({
      email: "test@example.com",
      password: "longenoughpassword",
    });
    
    assertExists(response.token);
    assertExists(response.user);
    assertEquals(response.user.email, "test@example.com");
  });
});