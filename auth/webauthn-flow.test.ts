/**
 * End-to-end WebAuthn registration + login flow against AuthProvider.
 * Uses the test-only helpers to fabricate authenticator responses
 * from a JS-controlled keypair, the same shape a real browser would
 * emit. (gh/geldata#6725)
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { generateTOTP } from "./totp.ts";
import { AuthError, AuthErrorCode } from "./types.ts";
import { buildAttestationObject, buildAuthenticatorData, buildClientDataJSON, generateTestKeyPair, signAssertion } from "./webauthn-test-helper.ts";
import { base64UrlDecode, base64UrlEncode } from "./webauthn.ts";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";

async function makeProvider(): Promise<{
  provider: AuthProvider;
  db: TestDatabase;
}> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false,
      webauthn: {
        rpId: RP_ID,
        rpName: "Test App",
        origin: ORIGIN,
      },
    },
    db,
  );
  await provider.initialize();
  return { provider, db };
}

interface RegisteredPasskey {
  userId: string;
  credentialId: string;
  privateKey: CryptoKey;
}

async function registerPasskey(
  provider: AuthProvider,
  email = "u@example.com",
): Promise<RegisteredPasskey> {
  const reg = await provider.register({ email, password: "password123" });
  const opts = await provider.beginWebAuthnRegistration(reg.user.id);
  const challenge = base64UrlDecode(opts.publicKey.challenge);
  const kp = await generateTestKeyPair();
  const credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const authData = await buildAuthenticatorData({
    rpId: RP_ID,
    counter: 1,
    attestedCredential: { credentialId, cosePublicKey: kp.cosePublicKey },
  });
  const attObj = buildAttestationObject({ authData });
  const cd = buildClientDataJSON({
    type: "webauthn.create",
    challenge,
    origin: ORIGIN,
  });
  await provider.finishWebAuthnRegistration({
    challengeId: opts.challengeId,
    credentialId: base64UrlEncode(credentialId),
    attestationObject: base64UrlEncode(attObj),
    clientDataJSON: base64UrlEncode(cd),
  });
  return {
    userId: reg.user.id,
    credentialId: base64UrlEncode(credentialId),
    privateKey: kp.privateKey,
  };
}

// ── Registration ──────────────────────────────────────────────────────

Deno.test("WebAuthn registration — happy path persists the credential", async () => {
  const { provider, db } = await makeProvider();
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
  const { provider, db } = await makeProvider();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const kp = await generateTestKeyPair();
    const credentialId = new Uint8Array([10, 20, 30]);
    const authData = await buildAuthenticatorData({
      rpId: RP_ID,
      counter: 0,
      attestedCredential: { credentialId, cosePublicKey: kp.cosePublicKey },
    });
    const finish = {
      challengeId: opts.challengeId,
      credentialId: base64UrlEncode(credentialId),
      attestationObject: base64UrlEncode(buildAttestationObject({ authData })),
      clientDataJSON: base64UrlEncode(
        buildClientDataJSON({
          type: "webauthn.create",
          challenge,
          origin: ORIGIN,
        }),
      ),
    };
    await provider.finishWebAuthnRegistration(finish);

    const err = await assertRejects(
      () => provider.finishWebAuthnRegistration(finish),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn registration — rejects mismatched origin", async () => {
  const { provider, db } = await makeProvider();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const kp = await generateTestKeyPair();
    const credentialId = new Uint8Array([1, 2, 3]);
    const authData = await buildAuthenticatorData({
      rpId: RP_ID,
      counter: 0,
      attestedCredential: { credentialId, cosePublicKey: kp.cosePublicKey },
    });

    await assertRejects(
      () =>
        provider.finishWebAuthnRegistration({
          challengeId: opts.challengeId,
          credentialId: base64UrlEncode(credentialId),
          attestationObject: base64UrlEncode(
            buildAttestationObject({ authData }),
          ),
          clientDataJSON: base64UrlEncode(
            buildClientDataJSON({
              type: "webauthn.create",
              challenge,
              origin: "https://attacker.example",
            }),
          ),
        }),
      Error,
      "origin mismatch",
    );
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn registration — rejects mismatched rpId in authData", async () => {
  const { provider, db } = await makeProvider();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const kp = await generateTestKeyPair();
    const credentialId = new Uint8Array([1, 2, 3]);
    // authenticatorData hashed for a different rpId
    const authData = await buildAuthenticatorData({
      rpId: "other-domain.com",
      counter: 0,
      attestedCredential: { credentialId, cosePublicKey: kp.cosePublicKey },
    });

    const err = await assertRejects(
      () =>
        provider.finishWebAuthnRegistration({
          challengeId: opts.challengeId,
          credentialId: base64UrlEncode(credentialId),
          attestationObject: base64UrlEncode(
            buildAttestationObject({ authData }),
          ),
          clientDataJSON: base64UrlEncode(
            buildClientDataJSON({
              type: "webauthn.create",
              challenge,
              origin: ORIGIN,
            }),
          ),
        }),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

// ── Login ────────────────────────────────────────────────────────────

Deno.test("WebAuthn login — completes end-to-end and bumps the counter", async () => {
  const { provider, db } = await makeProvider();
  try {
    const passkey = await registerPasskey(provider);

    const opts = await provider.beginWebAuthnLogin("u@example.com");
    const challenge = base64UrlDecode(opts.publicKey.challenge);
    const authData = await buildAuthenticatorData({
      rpId: RP_ID,
      counter: 5,
    });
    const cd = buildClientDataJSON({
      type: "webauthn.get",
      challenge,
      origin: ORIGIN,
    });
    const sig = await signAssertion({
      privateKey: passkey.privateKey,
      authData,
      clientDataJSON: cd,
    });

    const result = await provider.finishWebAuthnLogin({
      challengeId: opts.challengeId,
      credentialId: passkey.credentialId,
      authenticatorData: base64UrlEncode(authData),
      clientDataJSON: base64UrlEncode(cd),
      signature: base64UrlEncode(sig),
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
  const { provider, db } = await makeProvider();
  try {
    const passkey = await registerPasskey(provider); // registered with counter=1

    // First login bumps stored counter to 5.
    const opts1 = await provider.beginWebAuthnLogin("u@example.com");
    const c1 = base64UrlDecode(opts1.publicKey.challenge);
    const ad1 = await buildAuthenticatorData({ rpId: RP_ID, counter: 5 });
    const cd1 = buildClientDataJSON({
      type: "webauthn.get",
      challenge: c1,
      origin: ORIGIN,
    });
    const sig1 = await signAssertion({
      privateKey: passkey.privateKey,
      authData: ad1,
      clientDataJSON: cd1,
    });
    await provider.finishWebAuthnLogin({
      challengeId: opts1.challengeId,
      credentialId: passkey.credentialId,
      authenticatorData: base64UrlEncode(ad1),
      clientDataJSON: base64UrlEncode(cd1),
      signature: base64UrlEncode(sig1),
    });

    // Second login at counter=3 (regressed) — clone detected.
    const opts2 = await provider.beginWebAuthnLogin("u@example.com");
    const c2 = base64UrlDecode(opts2.publicKey.challenge);
    const ad2 = await buildAuthenticatorData({ rpId: RP_ID, counter: 3 });
    const cd2 = buildClientDataJSON({
      type: "webauthn.get",
      challenge: c2,
      origin: ORIGIN,
    });
    const sig2 = await signAssertion({
      privateKey: passkey.privateKey,
      authData: ad2,
      clientDataJSON: cd2,
    });
    const err = await assertRejects(
      () =>
        provider.finishWebAuthnLogin({
          challengeId: opts2.challengeId,
          credentialId: passkey.credentialId,
          authenticatorData: base64UrlEncode(ad2),
          clientDataJSON: base64UrlEncode(cd2),
          signature: base64UrlEncode(sig2),
        }),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn login — rejects unknown credential", async () => {
  const { provider, db } = await makeProvider();
  try {
    await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const opts = await provider.beginWebAuthnLogin("u@example.com");
    const c = base64UrlDecode(opts.publicKey.challenge);
    const ad = await buildAuthenticatorData({ rpId: RP_ID, counter: 1 });
    const cd = buildClientDataJSON({
      type: "webauthn.get",
      challenge: c,
      origin: ORIGIN,
    });
    const kp = await generateTestKeyPair();
    const sig = await signAssertion({
      privateKey: kp.privateKey,
      authData: ad,
      clientDataJSON: cd,
    });
    const err = await assertRejects(
      () =>
        provider.finishWebAuthnLogin({
          challengeId: opts.challengeId,
          credentialId: base64UrlEncode(new Uint8Array([99, 99, 99])),
          authenticatorData: base64UrlEncode(ad),
          clientDataJSON: base64UrlEncode(cd),
          signature: base64UrlEncode(sig),
        }),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_TOKEN);
  } finally {
    await db.close();
  }
});

Deno.test("WebAuthn login — composes with TOTP MFA (returns MfaChallenge when enrolled)", async () => {
  const { provider, db } = await makeProvider();
  try {
    const passkey = await registerPasskey(provider);
    // Enroll + confirm TOTP for the same user
    const enrollment = await provider.enrollTOTP(passkey.userId);
    const code = await generateTOTP(enrollment.secret);
    await provider.confirmTOTP(passkey.userId, code);

    const opts = await provider.beginWebAuthnLogin("u@example.com");
    const c = base64UrlDecode(opts.publicKey.challenge);
    const ad = await buildAuthenticatorData({ rpId: RP_ID, counter: 7 });
    const cd = buildClientDataJSON({
      type: "webauthn.get",
      challenge: c,
      origin: ORIGIN,
    });
    const sig = await signAssertion({
      privateKey: passkey.privateKey,
      authData: ad,
      clientDataJSON: cd,
    });
    const result = await provider.finishWebAuthnLogin({
      challengeId: opts.challengeId,
      credentialId: passkey.credentialId,
      authenticatorData: base64UrlEncode(ad),
      clientDataJSON: base64UrlEncode(cd),
      signature: base64UrlEncode(sig),
    });
    assert("mfaRequired" in result);
    if ("mfaRequired" in result) {
      assertEquals(result.factors, ["totp"]);
    }
  } finally {
    await db.close();
  }
});

// ── Credential management ───────────────────────────────────────────

Deno.test("listWebAuthnCredentials + deleteWebAuthnCredential", async () => {
  const { provider, db } = await makeProvider();
  try {
    const passkey = await registerPasskey(provider);
    let list = await provider.listWebAuthnCredentials(passkey.userId);
    assertEquals(list.length, 1);

    await provider.deleteWebAuthnCredential(
      passkey.userId,
      passkey.credentialId,
    );
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
      requireEmailVerification: false,
      // No webauthn config!
    },
    db,
  );
  await provider.initialize();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const err = await assertRejects(
      () => provider.beginWebAuthnRegistration(reg.user.id),
      AuthError,
    );
    assertEquals((err as AuthError).code, AuthErrorCode.INVALID_OPERATION);
  } finally {
    await db.close();
  }
});

// ── Discoverable credentials (gh/geldata#7196) ──────────────────────

Deno.test("beginWebAuthnRegistration — defaults residentKey to 'preferred' for passkey discoverability", async () => {
  const { provider, db } = await makeProvider();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    assertEquals(opts.publicKey.authenticatorSelection?.residentKey, "preferred");
    assertEquals(opts.publicKey.authenticatorSelection?.requireResidentKey, false);
    assertEquals(opts.publicKey.authenticatorSelection?.userVerification, "preferred");
  } finally {
    await db.close();
  }
});

Deno.test("beginWebAuthnRegistration — requireResidentKey=true upgrades to 'required'", async () => {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false,
      webauthn: {
        rpId: RP_ID,
        rpName: "Test App",
        origin: ORIGIN,
        requireResidentKey: true,
      },
    },
    db,
  );
  await provider.initialize();
  try {
    const reg = await provider.register({
      email: "u@example.com",
      password: "password123",
    });
    const opts = await provider.beginWebAuthnRegistration(reg.user.id);
    assertEquals(opts.publicKey.authenticatorSelection?.residentKey, "required");
    assertEquals(opts.publicKey.authenticatorSelection?.requireResidentKey, true);
  } finally {
    await db.close();
  }
});
