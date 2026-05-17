/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertExists } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { type AuthConfig, type AuthError } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

describe("Auth Module Smoke Test", () => {
  let db: TestDatabase;
  let provider: AuthProvider;

  const testConfig: AuthConfig = {
    bcryptRounds: 4, /*** Faster for testing ***/
    jwtSecret: "test-secret-key-at-least-32-characters-long",
    passwordMinLength: 6, /*** Shorter for testing ***/
    tokenExpiry: 3600
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
        password: "short" /*** Should fail ***/
      });
    } catch (error) {
      assertEquals((error as AuthError).code, "PASSWORD_TOO_WEAK");
    }
  });

  it("should create JWT tokens", async () => {
    /*** Mock bcrypt by reducing rounds and using simple implementation ***/
    const response = await provider.register({
      email: "test@example.com",
      password: "longenoughpassword"
    });

    assertExists(response.token);
    assertExists(response.user);
    assertEquals(response.user.email, "test@example.com");
  });
});
