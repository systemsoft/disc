/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * WebAuthn unit tests — round-trip parser + signature verify against
 * test-helper-built ceremony payloads.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import {
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  encodeCbor,
  generateTestKeyPair,
  signAssertion
} from "./webauthn-test-helper.ts";

import {
  base64UrlDecode,
  base64UrlEncode,
  decodeCbor,
  hashRpId,
  parseAttestationObject,
  parseAuthenticatorData,
  verifyAssertionSignature,
  verifyClientData
} from "./webauthn.ts";

/*** RUNTIME ------------------------------------------ ***/

/*** --- base64url + CBOR round-trip --- ***/

Deno.test("base64url encode/decode round-trip", () => {
  const input = new Uint8Array([0, 1, 0x7f, 0x80, 0xff, 0xfe]);
  const encoded = base64UrlEncode(input);
  /*** base64url has no padding ***/
  assert(!encoded.includes("="));
  assert(!encoded.includes("+"));
  assert(!encoded.includes("/"));
  const decoded = base64UrlDecode(encoded);
  assertEquals(decoded.length, input.length);

  for (let i = 0; i < input.length; i++) {
    assertEquals(decoded[i], input[i]);
  }
});

Deno.test("CBOR encode/decode round-trip — primitives + map + array", () => {
  const m = new Map<unknown, unknown>([
    ["str", "hello"],
    [1, 42],
    [-7, new Uint8Array([1, 2, 3])],
    ["arr", [1, "x", true]],
    ["nested", new Map([["k", 99]])]
  ]);

  const bytes = encodeCbor(m);
  const back = decodeCbor(bytes) as Map<unknown, unknown>;
  assertEquals(back.get("str"), "hello");
  assertEquals(back.get(1), 42);
  assertEquals((back.get(-7) as Uint8Array).length, 3);

  const arr = back.get("arr") as unknown[];
  assertEquals(arr[0], 1);
  assertEquals(arr[1], "x");
  assertEquals(arr[2], true);

  const nested = back.get("nested") as Map<unknown, unknown>;
  assertEquals(nested.get("k"), 99);
});

/*** --- parseAttestationObject --- ***/

Deno.test("parseAttestationObject — extracts credential id + ES256 pubkey", async () => {
  const kp = await generateTestKeyPair();
  const credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  const authData = await buildAuthenticatorData({
    attestedCredential: {
      cosePublicKey: kp.cosePublicKey,
      credentialId
    },
    counter: 1,
    rpId: "example.com"
  });

  const attObj = buildAttestationObject({ authData });
  const parsed = parseAttestationObject(attObj);
  assertEquals(parsed.fmt, "none");
  assertEquals(parsed.counter, 1);
  assertEquals(parsed.publicKey.alg, -7);
  assertEquals(parsed.publicKey.jwk.kty, "EC");
  assertEquals(parsed.publicKey.jwk.crv, "P-256");
  assertEquals(parsed.credentialId.length, credentialId.length);

  for (let i = 0; i < credentialId.length; i++) {
    assertEquals(parsed.credentialId[i], credentialId[i]);
  }
});

Deno.test("parseAttestationObject — rejects truncated input", () => {
  assertRejects(
    async () => {
      await Promise.resolve();
      parseAttestationObject(new Uint8Array([0x00]));
    },
    Error
  );
});

/*** --- parseAuthenticatorData --- ***/

Deno.test("parseAuthenticatorData — extracts rpIdHash + flags + counter", async () => {
  const authData = await buildAuthenticatorData({ counter: 42, rpId: "example.com" });
  const parsed = parseAuthenticatorData(authData);
  assertEquals(parsed.counter, 42);
  /*** UP + UV flags from helper default ***/
  assert(parsed.flags & 0x01);
  assert(parsed.flags & 0x04);

  const expectedRpHash = await hashRpId("example.com");

  for (let i = 0; i < 32; i++) {
    assertEquals(parsed.rpIdHash[i], expectedRpHash[i]);
  }
});

/*** --- verifyClientData --- ***/

Deno.test("verifyClientData — accepts matching challenge + origin + type", () => {
  const challenge = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

  const cd = buildClientDataJSON({
    challenge,
    origin: "https://example.com",
    type: "webauthn.create"
  });

  const parsed = verifyClientData({
    clientDataJSON: cd,
    expectedChallenge: challenge,
    expectedOrigin: "https://example.com",
    expectedType: "webauthn.create"
  });

  assertEquals(parsed.origin, "https://example.com");
});

Deno.test("verifyClientData — rejects mismatched challenge", () => {
  const cd = buildClientDataJSON({
    challenge: new Uint8Array([1, 2, 3]),
    origin: "https://example.com",
    type: "webauthn.create"
  });

  assertRejects(
    async () => {
      await Promise.resolve();

      verifyClientData({
        clientDataJSON: cd,
        expectedChallenge: new Uint8Array([9, 9, 9]),
        expectedOrigin: "https://example.com",
        expectedType: "webauthn.create"
      });
    },
    Error,
    "challenge mismatch"
  );
});

Deno.test("verifyClientData — rejects mismatched origin", () => {
  const challenge = new Uint8Array([1, 2, 3]);

  const cd = buildClientDataJSON({
    challenge,
    origin: "https://attacker.example",
    type: "webauthn.get"
  });

  assertRejects(
    async () => {
      await Promise.resolve();

      verifyClientData({
        clientDataJSON: cd,
        expectedChallenge: challenge,
        expectedOrigin: "https://example.com",
        expectedType: "webauthn.get"
      });
    },
    Error,
    "origin mismatch"
  );
});

/*** --- verifyAssertionSignature --- ***/

Deno.test("verifyAssertionSignature — accepts a valid ES256 assertion", async () => {
  const kp = await generateTestKeyPair();
  const credentialId = new Uint8Array([1, 2, 3, 4]);

  /*** Registration first to grab the parsed pubkey, then assertion. ***/
  const regAuthData = await buildAuthenticatorData({
    attestedCredential: { cosePublicKey: kp.cosePublicKey, credentialId },
    counter: 0,
    rpId: "example.com"
  });

  const reg = parseAttestationObject(buildAttestationObject({ authData: regAuthData }));
  const challenge = new Uint8Array([0xfe, 0xed]);
  const assertAuthData = await buildAuthenticatorData({ counter: 1, rpId: "example.com" });
  const cd = buildClientDataJSON({ challenge, origin: "https://example.com", type: "webauthn.get" });
  const sig = await signAssertion({ authData: assertAuthData, clientDataJSON: cd, privateKey: kp.privateKey });

  const ok = await verifyAssertionSignature({
    authData: assertAuthData,
    clientDataJSON: cd,
    publicKey: reg.publicKey,
    signature: sig
  });

  assertEquals(ok, true);
});

Deno.test("verifyAssertionSignature — rejects a tampered authData", async () => {
  const kp = await generateTestKeyPair();
  const credentialId = new Uint8Array([1, 2, 3, 4]);

  const regAuthData = await buildAuthenticatorData({
    attestedCredential: { cosePublicKey: kp.cosePublicKey, credentialId },
    counter: 0,
    rpId: "example.com"
  });

  const reg = parseAttestationObject(buildAttestationObject({ authData: regAuthData }));
  const challenge = new Uint8Array([0xab, 0xcd]);
  const authData = await buildAuthenticatorData({ counter: 1, rpId: "example.com" });
  const cd = buildClientDataJSON({ challenge, origin: "https://example.com", type: "webauthn.get" });
  const sig = await signAssertion({ authData, clientDataJSON: cd, privateKey: kp.privateKey });
  /*** Flip a byte in authData (simulating a MITM rewriting the counter). ***/
  const tampered = new Uint8Array(authData);
  tampered[33] ^= 0xff;

  const ok = await verifyAssertionSignature({
    authData: tampered,
    clientDataJSON: cd,
    publicKey: reg.publicKey,
    signature: sig
  });

  assertEquals(ok, false);
});

Deno.test("verifyAssertionSignature — rejects a different credential’s signature", async () => {
  const kpA = await generateTestKeyPair();
  const kpB = await generateTestKeyPair();
  const credentialId = new Uint8Array([1, 2, 3, 4]);

  const regAuthData = await buildAuthenticatorData({
    attestedCredential: { cosePublicKey: kpA.cosePublicKey, credentialId },
    counter: 0,
    rpId: "example.com"
  });

  const reg = parseAttestationObject(buildAttestationObject({ authData: regAuthData }));
  const challenge = new Uint8Array([0x12, 0x34]);
  const authData = await buildAuthenticatorData({ counter: 1, rpId: "example.com" });
  const cd = buildClientDataJSON({ challenge, origin: "https://example.com", type: "webauthn.get" });
  /*** Sign with key B, verify against key A’s stored pubkey. ***/
  const sig = await signAssertion({ authData, clientDataJSON: cd, privateKey: kpB.privateKey });

  const ok = await verifyAssertionSignature({
    authData,
    clientDataJSON: cd,
    publicKey: reg.publicKey,
    signature: sig
  });

  assertEquals(ok, false);
});
