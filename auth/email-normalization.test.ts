/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Email identity tests.
 *
 * `users.email` carries a plain `TEXT UNIQUE` constraint, and PostgreSQL
 * compares TEXT byte-exactly. On its own that lets `ada@example.com`,
 * `Ada@example.com` and `ada@example.com ` all coexist as separate accounts,
 * and someone who registered with one casing cannot log in with another —
 * `login()` finds no row and returns the same generic failure as a wrong
 * password, so the symptom is indistinguishable from forgetting it.
 *
 * Addresses are therefore trimmed on write and compared case-insensitively.
 * Stored casing is preserved: the local part of an address is technically
 * case-sensitive per RFC 5321, so it is kept for display and delivery while
 * identity comparisons ignore it.
 */

/*** NATIVE ------------------------------------------- ***/

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertExists, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { requireAuthResponse, type AuthConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

describe("Email identity", () => {
  let db: TestDatabase;
  let provider: AuthProvider;

  const testConfig: AuthConfig = {
    bcryptRounds: 4,
    jwtSecret: "test-secret-key-at-least-32-characters-long",
    passwordMinLength: 6,
    tokenExpiry: 3600
  };

  const password = "correct-horse";

  beforeEach(async () => {
    db = new TestDatabase();
    await db.connect();
    provider = new AuthProvider(testConfig, db);
    await provider.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("registration", () => {
    it("rejects an address differing only in case", async () => {
      await provider.register({ email: "ada@example.com", password });

      await assertRejects(
        () => provider.register({ email: "Ada@example.com", password }),
        Error,
        "User already exists"
      );
    });

    it("rejects an address differing only in domain case", async () => {
      await provider.register({ email: "ada@example.com", password });

      await assertRejects(
        () => provider.register({ email: "ada@EXAMPLE.com", password }),
        Error,
        "User already exists"
      );
    });

    it("rejects an address differing only in surrounding whitespace", async () => {
      await provider.register({ email: "ada@example.com", password });

      await assertRejects(
        () => provider.register({ email: "  ada@example.com  ", password }),
        Error,
        "User already exists"
      );
    });

    it("trims the stored address", async () => {
      const response = await provider.register({
        email: "  billie@example.com \n",
        password
      });

      assertEquals(response.user.email, "billie@example.com");
    });

    it("preserves the casing the user typed", async () => {
      // RFC 5321 makes the local part case-sensitive; identity ignores case
      // but delivery and display should show what they entered.
      const response = await provider.register({
        email: "Ada.Lovelace@Example.com",
        password
      });

      assertEquals(response.user.email, "Ada.Lovelace@Example.com");
    });

    it("still treats genuinely different addresses as distinct", async () => {
      await provider.register({ email: "ada@example.com", password });
      const other = await provider.register({
        email: "a.da@example.com",
        password
      });

      assertExists(other.user.id);
    });
  });

  describe("login", () => {
    it("accepts a different casing than was registered", async () => {
      await provider.register({ email: "Ada@Example.com", password });

      const result = requireAuthResponse(
        await provider.login({ email: "ada@example.com", password })
      );

      assertExists(result.token);
    });

    it("accepts surrounding whitespace", async () => {
      await provider.register({ email: "ada@example.com", password });

      const result = requireAuthResponse(
        await provider.login({ email: "  ada@example.com  ", password })
      );

      assertExists(result.token);
    });
  });

  describe("account lookup", () => {
    it("resolves a user id from a differently-cased address", async () => {
      const registered = await provider.register({
        email: "ada@example.com",
        password
      });

      assertEquals(
        await provider.resolveUserId("ADA@EXAMPLE.COM"),
        registered.user.id
      );
    });

    it("resolves a user id from an untrimmed address", async () => {
      const registered = await provider.register({
        email: "ada@example.com",
        password
      });

      assertEquals(
        await provider.resolveUserId(" ada@example.com "),
        registered.user.id
      );
    });

    it("still returns null for an address nobody holds", async () => {
      await provider.register({ email: "ada@example.com", password });
      assertEquals(await provider.resolveUserId("nobody@example.com"), null);
    });
  });

  describe("password reset", () => {
    it("issues a token for a differently-cased address", async () => {
      await provider.register({ email: "ada@example.com", password });

      const token = await provider.resetPasswordRequest("ADA@example.com");
      assertExists(token);
      assertEquals(token.length > 0, true);
    });
  });
});
