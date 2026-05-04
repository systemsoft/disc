// deno-lint-ignore-file no-explicit-any
import { assertRejects } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { AuthProvider } from "./provider.ts";
import type { AuthConfig } from "./types.ts";
import { TestDatabase } from "./test-database.ts";

/**
 * gh/geldata#7006: every AuthConfig field is validated at
 * `initialize()` time so a bad configuration fails fast — at boot,
 * with a clear error pointing to the offending field — rather than
 * deferring the failure to the first auth request where the symptom
 * (opaque bcrypt or JWT crash) hides the cause.
 */

describe("AuthProvider — config validation (gh/geldata#7006)", () => {
  let db: TestDatabase;
  const baseConfig: AuthConfig = {
    jwtSecret: "test-secret-key-for-testing-only-32+",
    bcryptRounds: 4,
  };

  beforeEach(async () => {
    db = new TestDatabase();
    await db.connect();
  });

  afterEach(async () => {
    await db.close();
  });

  it("rejects bcryptRounds below 4", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, bcryptRounds: 3 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "bcryptRounds must be an integer in [4, 15]",
    );
  });

  it("rejects bcryptRounds above 15 (DoS amplifier)", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, bcryptRounds: 20 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "bcryptRounds must be an integer in [4, 15]",
    );
  });

  it("rejects non-integer bcryptRounds", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, bcryptRounds: 10.5 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "bcryptRounds must be an integer in [4, 15]",
    );
  });

  it("rejects tokenExpiry of zero", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, tokenExpiry: 0 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "tokenExpiry must be a positive number of seconds",
    );
  });

  it("rejects negative tokenExpiry", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, tokenExpiry: -1 },
      db as any,
    );
    await assertRejects(() => provider.initialize(), Error, "tokenExpiry");
  });

  it("rejects refreshTokenExpiry shorter than tokenExpiry", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, tokenExpiry: 3600, refreshTokenExpiry: 1800 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "refresh tokens shorter than access tokens",
    );
  });

  it("rejects passwordMinLength of 0", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, passwordMinLength: 0 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "passwordMinLength must be a positive integer",
    );
  });

  it("rejects negative maxSessionsPerUser", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, maxSessionsPerUser: -1 },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "maxSessionsPerUser must be a non-negative integer",
    );
  });

  it("accepts maxSessionsPerUser=0 (unlimited, the default)", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, maxSessionsPerUser: 0 },
      db as any,
    );
    // Should NOT throw.
    await provider.initialize();
  });

  it("rejects empty jwtIssuer", async () => {
    const provider = new AuthProvider(
      { ...baseConfig, jwtIssuer: "" },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "jwtIssuer must be a non-empty string",
    );
  });

  it("rejects unknown jwtAlgorithm at runtime (defends untrusted JSON)", async () => {
    // Cast through `unknown` because TypeScript catches this at compile
    // time — but config loaded from JSON / TOML at runtime could
    // smuggle through any string.
    const provider = new AuthProvider(
      { ...baseConfig, jwtAlgorithm: "ES256" as unknown as "HS256" },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      'jwtAlgorithm must be "HS256" or "RS256"',
    );
  });

  it("validation runs before key import — clear error precedence", async () => {
    // Both bcryptRounds (-1) and jwtSecret (missing) are invalid; the
    // validator runs first so the operator sees the bcrypt error
    // (more actionable) rather than the cryptic key-import failure.
    const provider = new AuthProvider(
      { jwtSecret: undefined, bcryptRounds: -1 } as AuthConfig,
      db as any,
    );
    await assertRejects(() => provider.initialize(), Error, "bcryptRounds");
  });
});
