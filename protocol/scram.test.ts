/**
 * Tests for SCRAM-SHA-256 authentication (protocol/scram.ts).
 */

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  buildClientFinalMessage,
  buildClientFirstMessage,
  deriveKeys,
  fromBase64,
  generateServerFirstMessage,
  parseClientFirstMessage,
  toBase64,
  verifyClientFinalMessage
} from "./scram.ts";
import type { ScramServerState } from "./scram.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// deriveKeys
// ---------------------------------------------------------------------------

Deno.test("scram - deriveKeys produces 32-byte stored and server keys", async () => {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const { storedKey, serverKey } = await deriveKeys("password", salt, 4096);
  assertEquals(storedKey.length, 32);
  assertEquals(serverKey.length, 32);
});

Deno.test("scram - deriveKeys is deterministic for same inputs", async () => {
  const salt = textEncoder.encode("fixed-salt-value");
  const k1 = await deriveKeys("mypassword", salt, 4096);
  const k2 = await deriveKeys("mypassword", salt, 4096);
  assertEquals(k1.storedKey, k2.storedKey);
  assertEquals(k1.serverKey, k2.serverKey);
});

Deno.test("scram - deriveKeys produces different keys for different passwords", async () => {
  const salt = textEncoder.encode("same-salt");
  const k1 = await deriveKeys("password1", salt, 4096);
  const k2 = await deriveKeys("password2", salt, 4096);
  assertNotEquals(toBase64(k1.storedKey), toBase64(k2.storedKey));
  assertNotEquals(toBase64(k1.serverKey), toBase64(k2.serverKey));
});

Deno.test("scram - deriveKeys produces different keys for different salts", async () => {
  const salt1 = textEncoder.encode("salt-alpha");
  const salt2 = textEncoder.encode("salt-bravo");
  const k1 = await deriveKeys("samepass", salt1, 4096);
  const k2 = await deriveKeys("samepass", salt2, 4096);
  assertNotEquals(toBase64(k1.storedKey), toBase64(k2.storedKey));
});

// ---------------------------------------------------------------------------
// parseClientFirstMessage
// ---------------------------------------------------------------------------

Deno.test("scram - parseClientFirstMessage extracts username and nonce", () => {
  const msg = textEncoder.encode("n,,n=testuser,r=rOprNGfwEbeRWgbNEkqO");
  const result = parseClientFirstMessage(msg);
  assertEquals(result.gs2Header, "n,,");
  assertEquals(result.username, "testuser");
  assertEquals(result.clientNonce, "rOprNGfwEbeRWgbNEkqO");
  assertEquals(
    result.clientFirstMessageBare,
    "n=testuser,r=rOprNGfwEbeRWgbNEkqO"
  );
});

Deno.test("scram - parseClientFirstMessage throws on missing nonce", () => {
  const msg = textEncoder.encode("n,,n=user");
  assertThrows(
    () => parseClientFirstMessage(msg),
    Error,
    "missing nonce"
  );
});

Deno.test("scram - parseClientFirstMessage throws on missing username", () => {
  const msg = textEncoder.encode("n,,r=somenonce");
  assertThrows(
    () => parseClientFirstMessage(msg),
    Error,
    "missing username"
  );
});

Deno.test("scram - parseClientFirstMessage throws on malformed input", () => {
  const msg = textEncoder.encode("garbage");
  assertThrows(
    () => parseClientFirstMessage(msg),
    Error,
    "malformed"
  );
});

// ---------------------------------------------------------------------------
// generateServerFirstMessage
// ---------------------------------------------------------------------------

Deno.test("scram - generateServerFirstMessage format is correct", () => {
  const salt = textEncoder.encode("abcdefghijklmnop");
  const { serverNonce, serverFirstMessage } = generateServerFirstMessage(
    "clientNonce123",
    salt,
    4096
  );

  // Server nonce should be non-empty
  assertNotEquals(serverNonce, "");

  // serverFirstMessage should contain combined nonce, salt, and iterations
  const parts = serverFirstMessage.split(",");
  assertEquals(parts.length, 3);

  // r= should start with client nonce
  assertEquals(parts[0].startsWith("r=clientNonce123"), true);

  // s= should be base64 of salt
  assertEquals(parts[1].startsWith("s="), true);
  const decodedSalt = fromBase64(parts[1].substring(2));
  assertEquals(decodedSalt, salt);

  // i= should be iterations
  assertEquals(parts[2], "i=4096");
});

// ---------------------------------------------------------------------------
// Full SCRAM flow: client-first -> server-first -> client-final -> verify
// ---------------------------------------------------------------------------

Deno.test("scram - full SCRAM-SHA-256 flow succeeds with correct password", async () => {
  const password = "correcthorsebatterystaple";
  const clientNonce = "client-nonce-abc123";

  // 1. Client builds first message
  const { message: clientFirstMsg, clientFirstMessageBare } = buildClientFirstMessage("ada", clientNonce);

  // 2. Server parses client-first
  const parsed = parseClientFirstMessage(clientFirstMsg);
  assertEquals(parsed.username, "ada");
  assertEquals(parsed.clientNonce, clientNonce);

  // 3. Server generates server-first
  const salt = textEncoder.encode("serversalt123456");
  const iterations = 4096;
  const { serverNonce, serverFirstMessage } = generateServerFirstMessage(
    parsed.clientNonce,
    salt,
    iterations
  );

  // 4. Server derives keys from password
  const { storedKey, serverKey } = await deriveKeys(password, salt, iterations);

  // 5. Client builds final message
  const clientFinalMsg = await buildClientFinalMessage(
    password,
    clientNonce,
    clientFirstMessageBare,
    serverFirstMessage
  );

  // 6. Server verifies client-final
  const state: ScramServerState = {
    username: "ada",
    clientNonce: parsed.clientNonce,
    serverNonce,
    salt,
    iterations,
    clientFirstMessageBare: parsed.clientFirstMessageBare,
    serverFirstMessage,
    gs2Header: parsed.gs2Header
  };

  const result = await verifyClientFinalMessage(
    clientFinalMsg,
    state,
    storedKey,
    serverKey
  );

  assertEquals(result.valid, true);
  assertNotEquals(result.serverSignature, "");
});

Deno.test("scram - full SCRAM flow fails with wrong password", async () => {
  const correctPassword = "rightpassword";
  const wrongPassword = "wrongpassword";
  const clientNonce = "nonce-wrong-pass";

  // Client builds first message
  const { message: clientFirstMsg, clientFirstMessageBare } = buildClientFirstMessage("billie", clientNonce);

  // Server parses
  const parsed = parseClientFirstMessage(clientFirstMsg);

  // Server generates server-first
  const salt = textEncoder.encode("salt-for-test-16");
  const iterations = 4096;
  const { serverNonce, serverFirstMessage } = generateServerFirstMessage(
    parsed.clientNonce,
    salt,
    iterations
  );

  // Server derives keys from CORRECT password
  const { storedKey, serverKey } = await deriveKeys(
    correctPassword,
    salt,
    iterations
  );

  // Client builds final message with WRONG password
  const clientFinalMsg = await buildClientFinalMessage(
    wrongPassword,
    clientNonce,
    clientFirstMessageBare,
    serverFirstMessage
  );

  // Server verifies — should fail
  const state: ScramServerState = {
    username: "billie",
    clientNonce: parsed.clientNonce,
    serverNonce,
    salt,
    iterations,
    clientFirstMessageBare: parsed.clientFirstMessageBare,
    serverFirstMessage,
    gs2Header: parsed.gs2Header
  };

  const result = await verifyClientFinalMessage(
    clientFinalMsg,
    state,
    storedKey,
    serverKey
  );

  assertEquals(result.valid, false);
});

Deno.test("scram - verifyClientFinalMessage rejects tampered nonce", async () => {
  const password = "password123";
  const clientNonce = "nonce-tamper-test";

  const { message: clientFirstMsg, clientFirstMessageBare } = buildClientFirstMessage("cher", clientNonce);
  const parsed = parseClientFirstMessage(clientFirstMsg);

  const salt = textEncoder.encode("salt-tamper-test");
  const iterations = 4096;
  const { serverNonce, serverFirstMessage } = generateServerFirstMessage(
    parsed.clientNonce,
    salt,
    iterations
  );

  const { storedKey, serverKey } = await deriveKeys(password, salt, iterations);

  // Build a valid client-final, then tamper with the nonce
  const clientFinalMsg = await buildClientFinalMessage(
    password,
    clientNonce,
    clientFirstMessageBare,
    serverFirstMessage
  );

  // Use a state with a different serverNonce (simulating nonce tampering)
  const state: ScramServerState = {
    username: "cher",
    clientNonce: parsed.clientNonce,
    serverNonce: serverNonce + "tampered",
    salt,
    iterations,
    clientFirstMessageBare: parsed.clientFirstMessageBare,
    serverFirstMessage,
    gs2Header: parsed.gs2Header
  };

  const result = await verifyClientFinalMessage(
    clientFinalMsg,
    state,
    storedKey,
    serverKey
  );

  // Nonce mismatch should cause rejection
  assertEquals(result.valid, false);
});

Deno.test("scram - verifyClientFinalMessage rejects empty proof", async () => {
  const msg = textEncoder.encode("c=biws,r=somenonce");
  const state: ScramServerState = {
    username: "test",
    clientNonce: "cn",
    serverNonce: "sn",
    salt: new Uint8Array(16),
    iterations: 4096,
    clientFirstMessageBare: "n=test,r=cn",
    serverFirstMessage: "r=cnsn,s=AAAA,i=4096",
    gs2Header: "n,,"
  };

  const result = await verifyClientFinalMessage(
    msg,
    state,
    new Uint8Array(32),
    new Uint8Array(32)
  );
  assertEquals(result.valid, false);
});

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

Deno.test("scram - toBase64 and fromBase64 round-trip", () => {
  const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const encoded = toBase64(original);
  const decoded = fromBase64(encoded);
  assertEquals(decoded, original);
});

Deno.test("scram - toBase64 produces correct encoding", () => {
  const data = textEncoder.encode("Hello");
  assertEquals(toBase64(data), "SGVsbG8=");
});

// ---------------------------------------------------------------------------
// buildClientFirstMessage
// ---------------------------------------------------------------------------

Deno.test("scram - buildClientFirstMessage produces correct format", () => {
  const { message, clientFirstMessageBare } = buildClientFirstMessage(
    "user",
    "abc123"
  );
  const str = textDecoder.decode(message);
  assertEquals(str, "n,,n=user,r=abc123");
  assertEquals(clientFirstMessageBare, "n=user,r=abc123");
});

// ---------------------------------------------------------------------------
// P0-10: iteration count floor
// ---------------------------------------------------------------------------

Deno.test("scram - deriveKeys rejects iteration counts below MIN_SCRAM_ITERATIONS (P0-10)", async () => {
  const { MIN_SCRAM_ITERATIONS } = await import("./scram.ts");
  const salt = textEncoder.encode("0123456789abcdef");

  // Below the floor must throw
  let threw = false;
  try {
    await deriveKeys("password", salt, 1);
  } catch (_) {
    threw = true;
  }
  assertEquals(threw, true, `deriveKeys(1) must throw`);

  threw = false;
  try {
    await deriveKeys("password", salt, MIN_SCRAM_ITERATIONS - 1);
  } catch (_) {
    threw = true;
  }
  assertEquals(threw, true, `deriveKeys(min-1) must throw`);

  // At the floor succeeds
  const ok = await deriveKeys("password", salt, MIN_SCRAM_ITERATIONS);
  assertNotEquals(ok.storedKey.length, 0);
});

// ---------------------------------------------------------------------------
// P0-11: channel-binding validation
// ---------------------------------------------------------------------------

Deno.test("scram - verifyClientFinalMessage rejects mismatched channel binding (P0-11)", async () => {
  const password = "correctpassword";
  const clientNonce = "client-nonce-xyz";

  // Client and server complete the first round normally
  const { clientFirstMessageBare } = buildClientFirstMessage(
    "carol",
    clientNonce
  );
  const salt = textEncoder.encode("some-16b-salt!!!");
  const iterations = 4096;
  const { serverNonce, serverFirstMessage } = generateServerFirstMessage(
    clientNonce,
    salt,
    iterations
  );
  const { storedKey, serverKey } = await deriveKeys(password, salt, iterations);

  // Build a normal client-final-message for the honest gs2 header "n,,"
  const honestFinal = await buildClientFinalMessage(
    password,
    clientNonce,
    clientFirstMessageBare,
    serverFirstMessage
  );

  // Tamper: swap the honest c=biws for a different (valid-looking) value
  const str = textDecoder.decode(honestFinal);
  const tampered = textEncoder.encode(str.replace("c=biws", "c=eSws")); // base64("y,,")

  const state: ScramServerState = {
    username: "carol",
    clientNonce,
    serverNonce,
    salt,
    iterations,
    clientFirstMessageBare,
    serverFirstMessage,
    gs2Header: "n,," // server recorded this from the honest first message
  };

  const tamperedResult = await verifyClientFinalMessage(
    tampered,
    state,
    storedKey,
    serverKey
  );
  assertEquals(
    tamperedResult.valid,
    false,
    "Mismatched channel binding must fail verification"
  );

  // Sanity: honest message still verifies
  const honestResult = await verifyClientFinalMessage(
    honestFinal,
    state,
    storedKey,
    serverKey
  );
  assertEquals(honestResult.valid, true);
});
