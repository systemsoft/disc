/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Username identity tests — the counterpart to `email-normalization.test.ts`.
 *
 * `users.username` carries the same byte-exact `TEXT UNIQUE` constraint that
 * `email` did, with the same two consequences: `ada` and `Ada` can be taken by
 * two different people, and whoever registered as `Ada` cannot log in as
 * `ada`. Usernames are therefore trimmed on write and compared
 * case-insensitively, with the stored casing preserved for display.
 *
 * Unlike email, `username` is nullable — plenty of accounts have none — so a
 * whitespace-only username normalizes to NULL rather than an empty string, and
 * many accounts must be able to hold NULL at once.
 */

/*** NATIVE ------------------------------------------- ***/

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertExists, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { requireAuthResponse, type AuthConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

describe("Username identity", () => {
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
    it("rejects a username differing only in case", async () => {
      await provider.register({
        email: "ada@example.com",
        password,
        username: "ada"
      });

      await assertRejects(
        () =>
          provider.register({
            email: "billie@example.com",
            password,
            username: "Ada"
          }),
        Error,
        "User already exists"
      );
    });

    it("rejects a username differing only in surrounding whitespace", async () => {
      await provider.register({
        email: "ada@example.com",
        password,
        username: "ada"
      });

      await assertRejects(
        () =>
          provider.register({
            email: "billie@example.com",
            password,
            username: "  ada  "
          }),
        Error,
        "User already exists"
      );
    });

    it("trims the stored username", async () => {
      const response = await provider.register({
        email: "ada@example.com",
        password,
        username: "  ada \n"
      });

      assertEquals(response.user.username, "ada");
    });

    it("preserves the casing the user chose", async () => {
      const response = await provider.register({
        email: "ada@example.com",
        password,
        username: "AdaLovelace"
      });

      assertEquals(response.user.username, "AdaLovelace");
    });

    it("treats a whitespace-only username as absent", async () => {
      const response = await provider.register({
        email: "ada@example.com",
        password,
        username: "   "
      });

      assertEquals(response.user.username ?? null, null);
    });

    it("lets many accounts have no username at all", async () => {
      // NULLs are distinct under a unique index; a second account without a
      // username must not collide with the first.
      await provider.register({ email: "ada@example.com", password });
      const second = await provider.register({
        email: "billie@example.com",
        password
      });

      assertExists(second.user.id);
    });

    it("still treats genuinely different usernames as distinct", async () => {
      await provider.register({
        email: "ada@example.com",
        password,
        username: "ada"
      });
      const other = await provider.register({
        email: "billie@example.com",
        password,
        username: "ada2"
      });

      assertExists(other.user.id);
    });
  });

  describe("login", () => {
    it("accepts a different casing than was registered", async () => {
      await provider.register({
        email: "ada@example.com",
        password,
        username: "AdaLovelace"
      });

      const result = requireAuthResponse(
        await provider.login({ password, username: "adalovelace" })
      );

      assertExists(result.token);
    });

    it("accepts surrounding whitespace", async () => {
      await provider.register({
        email: "ada@example.com",
        password,
        username: "ada"
      });

      const result = requireAuthResponse(
        await provider.login({ password, username: "  ada  " })
      );

      assertExists(result.token);
    });
  });
});
