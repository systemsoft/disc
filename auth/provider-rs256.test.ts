// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { AuthProvider } from "./provider.ts";
import type { AuthConfig } from "./types.ts";
import { TestDatabase } from "./test-database.ts";

/**
 * P3-04: RS256 (asymmetric-key) JWT signing tests. The HS256 path keeps
 * its dedicated suite in `provider.test.ts`; this file exercises only
 * the RS256-specific behavior — key import, sign+verify, cross-algorithm
 * rejection, and configuration error reporting.
 */

// --- Helpers ---

async function generateRsaPemPair(): Promise<
  { privatePem: string; publicPem: string }
> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const privatePkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  );
  const publicSpki = new Uint8Array(
    await crypto.subtle.exportKey("spki", keyPair.publicKey),
  );

  return {
    privatePem: derToPem(privatePkcs8, "PRIVATE KEY"),
    publicPem: derToPem(publicSpki, "PUBLIC KEY"),
  };
}

function derToPem(der: Uint8Array, label: string): string {
  let bin = "";
  for (let i = 0; i < der.length; i++) bin += String.fromCharCode(der[i]);
  const b64 = btoa(bin);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${
    lines.join("\n")
  }\n-----END ${label}-----\n`;
}

// --- Tests ---

describe("AuthProvider — RS256", () => {
  let db: TestDatabase;
  let privatePem: string;
  let publicPem: string;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.connect();
    const pair = await generateRsaPemPair();
    privatePem = pair.privatePem;
    publicPem = pair.publicPem;
  });

  afterEach(async () => {
    await db.close();
  });

  it("registers a user and mints an RS256 token", async () => {
    const provider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPrivateKey: privatePem,
        jwtPublicKey: publicPem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await provider.initialize();

    const response = await provider.register({
      email: "rs@example.com",
      password: "SecurePass123!",
    });

    assertExists(response.token);
    // RS256 JWT header decodes to {"alg":"RS256","typ":"JWT"}
    const headerB64 = response.token.split(".")[0];
    const header = JSON.parse(
      atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")),
    );
    assertEquals(header.alg, "RS256");
  });

  it("verifies its own RS256 tokens end-to-end", async () => {
    const provider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPrivateKey: privatePem,
        jwtPublicKey: publicPem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await provider.initialize();

    const response = await provider.register({
      email: "verify@example.com",
      password: "SecurePass123!",
    });

    const payload = await provider.verifyToken(response.token);
    assertEquals(payload.email, "verify@example.com");
  });

  it("rejects HS256-signed tokens", async () => {
    // Mint an HS256 token from a parallel HS256 provider, then ask the
    // RS256 provider to verify — must fail because the algorithm doesn't
    // match the imported key. Same DB instance is reused so the session
    // row exists; only the signature check should fail.
    const hsProvider = new AuthProvider(
      {
        jwtSecret: "test-secret-key-for-testing-only-32+",
        bcryptRounds: 4,
      },
      db as any,
    );
    await hsProvider.initialize();
    const hsResponse = await hsProvider.register({
      email: "cross@example.com",
      password: "SecurePass123!",
    });

    const rsProvider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPrivateKey: privatePem,
        jwtPublicKey: publicPem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await rsProvider.initialize();

    await assertRejects(() => rsProvider.verifyToken(hsResponse.token));
  });

  it("the reverse: HS256 provider rejects RS256-signed tokens", async () => {
    const rsProvider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPrivateKey: privatePem,
        jwtPublicKey: publicPem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await rsProvider.initialize();
    const rsResponse = await rsProvider.register({
      email: "rev@example.com",
      password: "SecurePass123!",
    });

    const hsProvider = new AuthProvider(
      {
        jwtSecret: "test-secret-key-for-testing-only-32+",
        bcryptRounds: 4,
      },
      db as any,
    );
    await hsProvider.initialize();

    await assertRejects(() => hsProvider.verifyToken(rsResponse.token));
  });

  it("throws when jwtPublicKey is missing under RS256", async () => {
    const provider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPrivateKey: privatePem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await assertRejects(() => provider.initialize(), Error, "jwtPublicKey");
  });

  it("throws when jwtPrivateKey is missing under RS256", async () => {
    const provider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPublicKey: publicPem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await assertRejects(() => provider.initialize(), Error, "jwtPrivateKey");
  });

  it("throws on malformed PEM armor", async () => {
    const provider = new AuthProvider(
      {
        jwtAlgorithm: "RS256",
        jwtPrivateKey: "not a real pem block",
        jwtPublicKey: publicPem,
        bcryptRounds: 4,
      },
      db as any,
    );
    await assertRejects(
      () => provider.initialize(),
      Error,
      "PEM key missing",
    );
  });

  it("HS256 still requires jwtSecret (regression — config validation)", async () => {
    const provider = new AuthProvider(
      {
        // No jwtSecret, no jwtAlgorithm → defaults to HS256
        bcryptRounds: 4,
      } as AuthConfig,
      db as any,
    );
    await assertRejects(() => provider.initialize(), Error, "jwtSecret");
  });

  it("dropping jwtAlgorithm preserves HS256 default behavior", async () => {
    const provider = new AuthProvider(
      {
        jwtSecret: "test-secret-key-for-testing-only-32+",
        bcryptRounds: 4,
      },
      db as any,
    );
    await provider.initialize();

    const response = await provider.register({
      email: "default@example.com",
      password: "SecurePass123!",
    });
    const headerB64 = response.token.split(".")[0];
    const header = JSON.parse(
      atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")),
    );
    assertEquals(header.alg, "HS256");
    assert(response.token.length > 0);
  });
});
