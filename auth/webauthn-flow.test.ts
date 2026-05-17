/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * End-to-end WebAuthn registration + login flow against AuthProvider.
 * Uses the test-only helpers to fabricate authenticator responses
 * from a JS-controlled keypair, the same shape a real browser would
 * emit. (gh/geldata#6725)
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertRejects } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthError, AuthErrorCode } from "./types.ts";
import { AuthProvider } from "./provider.ts";
import { base64UrlDecode, base64UrlEncode } from "./webauthn.ts";
import { generateTOTP } from "./totp.ts";
import { TestDatabase } from "./test-database.ts";

import {
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateTestKeyPair,
  signAssertion
} from "./webauthn-test-helper.ts";

const ORIGIN = "https://example.com";
const RP_ID = "example.com";

interface RegisteredPasskey {
  credentialId: string;
  privateKey: CryptoKey;
  userId: string;
}

/*** RUNTIME ------------------------------------------ ***/

/*** --- Registration --- ***/

Deno.test("WebAuthn registration — happy path persists the credential", async () => {
  const { db, provider } = await makeProvider();

  try {
    const passkey = await registerPasskey(provider);
    const list = await provider.listWebAuthnCredentials(passkey.userId);
    assertEquals(list.length, 1);
    assertEquals(list[0].credentialId, passkey.credentialId);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn registration — rejects challenge replay", async () => {
  const { db, provider } = await makeProvider();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const kp = await generateTestKeyPair();
    const credentialId = new Uint8Array([10, 20, 30]);

    const authData = await buildAuthenticatorData({
      attestedCredential: { cosePublicKey: kp.cosePublicKey, credentialId },
      counter: 0,
      rpId: RP_ID
    });

    const finish = {
      attestationObject: base64UrlEncode(buildAttestationObject({ authData })),
      challengeId: opts.challengeId,
      clientDataJSON: base64UrlEncode(
        buildClientDataJSON({
          challenge,
          origin: ORIGIN,
          type: "webauthn.create"
        })
      ),
      credentialId: base64UrlEncode(credentialId)
    };

    await provider.finishWebAuthnRegistration(finish);

    const err = await assertRejects(() => provider.finishWebAuthnRegistration(finish), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn registration — rejects mismatched origin", async () => {
  const { db, provider } = await makeProvider();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const kp = await generateTestKeyPair();
    const credentialId = new Uint8Array([1, 2, 3]);

    const authData = await buildAuthenticatorData({
      attestedCredential: { cosePublicKey: kp.cosePublicKey, credentialId },
      counter: 0,
      rpId: RP_ID
    });

    await assertRejects(
      () =>
        provider.finishWebAuthnRegistration({
          attestationObject: base64UrlEncode(buildAttestationObject({ authData })),
          challengeId: opts.challengeId,
          clientDataJSON: base64UrlEncode(
            buildClientDataJSON({
              challenge,
              origin: "https://attacker.example",
              type: "webauthn.create"
            })
          ),
          credentialId: base64UrlEncode(credentialId)
        }),
      Error,
      "origin mismatch"
    );
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn registration — rejects mismatched rpId in authData", async () => {
  const { db, provider } = await makeProvider();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const kp = await generateTestKeyPair();
    const credentialId = new Uint8Array([1, 2, 3]);

    /*** authenticatorData hashed for a different rpId ***/
    const authData = await buildAuthenticatorData({
      attestedCredential: { cosePublicKey: kp.cosePublicKey, credentialId },
      counter: 0,
      rpId: "other-domain.com"
    });

    const err = await assertRejects(
      () =>
        provider.finishWebAuthnRegistration({
          attestationObject: base64UrlEncode(buildAttestationObject({ authData })),
          challengeId: opts.challengeId,
          clientDataJSON: base64UrlEncode(
            buildClientDataJSON({
              challenge,
              origin: ORIGIN,
              type: "webauthn.create"
            })
          ),
          credentialId: base64UrlEncode(credentialId)
        }),
      AuthError
    );

    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

/*** --- Login --- ***/

Deno.test("WebAuthn login — completes end-to-end and bumps the counter", async () => {
  const { db, provider } = await makeProvider();

  try {
    const passkey = await registerPasskey(provider);
    const opts = await provider.beginWebAuthnLogin("u@example.com");
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const authData = await buildAuthenticatorData({ counter: 5, rpId: RP_ID });
    const cd = buildClientDataJSON({ challenge, origin: ORIGIN, type: "webauthn.get" });
    const sig = await signAssertion({ authData, clientDataJSON: cd, privateKey: passkey.privateKey });

    const result = await provider.finishWebAuthnLogin({
      authenticatorData: base64UrlEncode(authData),
      challengeId: opts.challengeId,
      clientDataJSON: base64UrlEncode(cd),
      credentialId: passkey.credentialId,
      signature: base64UrlEncode(sig)
    });

    assert(!("mfaRequired" in result));

    if (!("mfaRequired" in result)) {
      assertEquals(result.user.id, passkey.userId);
      assert(result.token);
    }
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn login — rejects counter regression (cloning detection)", async () => {
  const { db, provider } = await makeProvider();

  try {
    const passkey = await registerPasskey(provider); /*** registered with counter=1 ***/
    /*** First login bumps stored counter to 5. ***/
    const opts1 = await provider.beginWebAuthnLogin("u@example.com");
    const c1 = base64UrlDecode(opts1.publicKey.challenge);
    const ad1 = await buildAuthenticatorData({ counter: 5, rpId: RP_ID });
    const cd1 = buildClientDataJSON({ challenge: c1, origin: ORIGIN, type: "webauthn.get" });
    const sig1 = await signAssertion({ authData: ad1, clientDataJSON: cd1, privateKey: passkey.privateKey });

    await provider.finishWebAuthnLogin({
      authenticatorData: base64UrlEncode(ad1),
      challengeId: opts1.challengeId,
      clientDataJSON: base64UrlEncode(cd1),
      credentialId: passkey.credentialId,
      signature: base64UrlEncode(sig1)
    });

    /*** Second login at counter=3 (regressed) — clone detected. ***/
    const opts2 = await provider.beginWebAuthnLogin("u@example.com");
    const c2 = base64UrlDecode(opts2.publicKey.challenge);
    const ad2 = await buildAuthenticatorData({ rpId: RP_ID, counter: 3 });
    const cd2 = buildClientDataJSON({ challenge: c2, origin: ORIGIN, type: "webauthn.get" });
    const sig2 = await signAssertion({ authData: ad2, clientDataJSON: cd2, privateKey: passkey.privateKey });

    const err = await assertRejects(
      () =>
        provider.finishWebAuthnLogin({
          authenticatorData: base64UrlEncode(ad2),
          challengeId: opts2.challengeId,
          clientDataJSON: base64UrlEncode(cd2),
          credentialId: passkey.credentialId,
          signature: base64UrlEncode(sig2)
        }),
      AuthError
    );

    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn login — rejects unknown credential", async () => {
  const { db, provider } = await makeProvider();

  try {
    await provider.register({ email: "u@example.com", password: "password123" });
    const opts = await provider.beginWebAuthnLogin("u@example.com");
    const c = base64UrlDecode(opts.publicKey.challenge);
    const ad = await buildAuthenticatorData({ rpId: RP_ID, counter: 1 });
    const cd = buildClientDataJSON({ challenge: c, origin: ORIGIN, type: "webauthn.get" });
    const kp = await generateTestKeyPair();
    const sig = await signAssertion({ authData: ad, clientDataJSON: cd, privateKey: kp.privateKey });

    const err = await assertRejects(
      () =>
        provider.finishWebAuthnLogin({
          authenticatorData: base64UrlEncode(ad),
          challengeId: opts.challengeId,
          clientDataJSON: base64UrlEncode(cd),
          credentialId: base64UrlEncode(new Uint8Array([99, 99, 99])),
          signature: base64UrlEncode(sig)
        }),
      AuthError
    );

    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn login — composes with TOTP MFA (returns MfaChallenge when enrolled)", async () => {
  const { db, provider } = await makeProvider();

  try {
    const passkey = await registerPasskey(provider);
    /*** Enroll + confirm TOTP for the same user ***/
    const enrollment = await provider.enrollTOTP(passkey.userId);
    const code = await generateTOTP(enrollment.secret);
    await provider.confirmTOTP(passkey.userId, code);

    const opts = await provider.beginWebAuthnLogin("u@example.com");
    const c = base64UrlDecode(opts.publicKey.challenge);
    const ad = await buildAuthenticatorData({ rpId: RP_ID, counter: 7 });
    const cd = buildClientDataJSON({ challenge: c, origin: ORIGIN, type: "webauthn.get" });
    const sig = await signAssertion({ authData: ad, clientDataJSON: cd, privateKey: passkey.privateKey });

    const result = await provider.finishWebAuthnLogin({
      authenticatorData: base64UrlEncode(ad),
      challengeId: opts.challengeId,
      clientDataJSON: base64UrlEncode(cd),
      credentialId: passkey.credentialId,
      signature: base64UrlEncode(sig)
    });

    assert("mfaRequired" in result);

    if ("mfaRequired" in result)
      assertEquals(result.factors, ["totp"]);
  } finally {
    await db.close();
  }
});

/*** --- Credential management --- ***/

Deno.test("listWebAuthnCredentials + deleteWebAuthnCredential", async () => {
  const { db, provider } = await makeProvider();

  try {
    const passkey = await registerPasskey(provider);
    let list = await provider.listWebAuthnCredentials(passkey.userId);
    assertEquals(list.length, 1);

    await provider.deleteWebAuthnCredential(passkey.userId, passkey.credentialId);
    list = await provider.listWebAuthnCredentials(passkey.userId);
    assertEquals(list.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("beginWebAuthnRegistration — rejects when WebAuthn not configured", async () => {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false
      /*** No webauthn config! ***/
    },
    db
  );

  await provider.initialize();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const err = await assertRejects(() => provider.beginWebAuthnRegistration(reg.user.id), AuthError);
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_OPERATION);
  } finally {
    await db.close();
  }
});

/*** --- Discoverable credentials (gh/geldata#7196) --- ***/

Deno.test(`beginWebAuthnRegistration — defaults residentKey to "preferred" for passkey discoverability`, async () => {
  const { db, provider } = await makeProvider();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    assertEquals(opts.publicKey.authenticatorSelection?.residentKey, "preferred");
    assertEquals(opts.publicKey.authenticatorSelection?.requireResidentKey, false);
    assertEquals(opts.publicKey.authenticatorSelection?.userVerification, "preferred");
  } finally {
    await db.close();
  }
});

Deno.test(`beginWebAuthnRegistration — requireResidentKey=true upgrades to "required"`, async () => {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false,
      webauthn: {
        origin: ORIGIN,
        requireResidentKey: true,
        rpId: RP_ID,
        rpName: "Test App"
      }
    },
    db
  );

  await provider.initialize();

  try {
    const reg = await provider.register({ email: "u@example.com", password: "password123" });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    assertEquals(opts.publicKey.authenticatorSelection?.residentKey, "required");
    assertEquals(opts.publicKey.authenticatorSelection?.requireResidentKey, true);
  } finally {
    await db.close();
  }
});

/*** HELPER ------------------------------------------- ***/

async function makeProvider(): Promise<{ db: TestDatabase; provider: AuthProvider; }> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false,
      webauthn: {
        origin: ORIGIN,
        rpId: RP_ID,
        rpName: "Test App"
      }
    },
    db
  );

  await provider.initialize();

  return { db, provider };
}

async function registerPasskey(provider: AuthProvider, email = "u@example.com"): Promise<RegisteredPasskey> {
  const reg = await provider.register({ email, password: "password123" });
  const opts = await provider.beginWebAuthnRegistration(reg.user.id);
  const challenge = base64UrlDecode(opts.publicKey.challenge);
  const kp = await generateTestKeyPair();
  const credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  const authData = await buildAuthenticatorData({
    attestedCredential: { cosePublicKey: kp.cosePublicKey, credentialId },
    counter: 1,
    rpId: RP_ID
  });

  const attObj = buildAttestationObject({ authData });

  const cd = buildClientDataJSON({
    challenge,
    origin: ORIGIN,
    type: "webauthn.create"
  });

  await provider.finishWebAuthnRegistration({
    attestationObject: base64UrlEncode(attObj),
    challengeId: opts.challengeId,
    clientDataJSON: base64UrlEncode(cd),
    credentialId: base64UrlEncode(credentialId)
  });

  return {
    credentialId: base64UrlEncode(credentialId),
    privateKey: kp.privateKey,
    userId: reg.user.id
  };
}
