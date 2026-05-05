/**
 * Tests for the TLS hot-reload helpers.
 * Ports geldata/gel#4297 (gh/geldata#4277).
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TlsCertWatcher, validatePemEnvelope } from "./tls-reload.ts";

// ── validatePemEnvelope ────────────────────────────────────────────────

Deno.test("validatePemEnvelope - accepts well-formed certificate", () => {
  const cert = `-----BEGIN CERTIFICATE-----
MIIBaAA...
-----END CERTIFICATE-----`;
  assertEquals(validatePemEnvelope(cert, "cert"), true);
});

Deno.test("validatePemEnvelope - rejects empty cert content", () => {
  assertEquals(validatePemEnvelope("", "cert"), false);
});

Deno.test("validatePemEnvelope - rejects cert without END marker", () => {
  assertEquals(
    validatePemEnvelope("-----BEGIN CERTIFICATE-----\nABC\n", "cert"),
    false,
  );
});

Deno.test("validatePemEnvelope - accepts plain RSA private key", () => {
  const key = `-----BEGIN PRIVATE KEY-----
MIIE...
-----END PRIVATE KEY-----`;
  assertEquals(validatePemEnvelope(key, "key"), true);
});

Deno.test("validatePemEnvelope - accepts RSA-prefixed private key", () => {
  const key = `-----BEGIN RSA PRIVATE KEY-----
MIIE...
-----END RSA PRIVATE KEY-----`;
  assertEquals(validatePemEnvelope(key, "key"), true);
});

Deno.test("validatePemEnvelope - accepts EC private key", () => {
  const key = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEE...
-----END EC PRIVATE KEY-----`;
  assertEquals(validatePemEnvelope(key, "key"), true);
});

Deno.test("validatePemEnvelope - accepts encrypted private key", () => {
  const key = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIF...
-----END ENCRYPTED PRIVATE KEY-----`;
  assertEquals(validatePemEnvelope(key, "key"), true);
});

Deno.test("validatePemEnvelope - rejects junk as a key", () => {
  assertEquals(validatePemEnvelope("not a key", "key"), false);
});

Deno.test("validatePemEnvelope - rejects cert content passed as a key", () => {
  const cert = `-----BEGIN CERTIFICATE-----
MIIBaAA...
-----END CERTIFICATE-----`;
  assertEquals(validatePemEnvelope(cert, "key"), false);
});

// ── TlsCertWatcher (debounce + read + callback) ────────────────────────

async function makeTempPair(): Promise<{
  certFile: string;
  keyFile: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "disc-tls-reload-test-" });
  const certFile = `${dir}/cert.pem`;
  const keyFile = `${dir}/key.pem`;
  // Seed with a structurally-valid PEM envelope. Crypto isn't checked
  // here; the watcher only inspects the envelope.
  await Deno.writeTextFile(
    certFile,
    "-----BEGIN CERTIFICATE-----\nseed\n-----END CERTIFICATE-----\n",
  );
  await Deno.writeTextFile(
    keyFile,
    "-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----\n",
  );
  return {
    certFile,
    keyFile,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

Deno.test("TlsCertWatcher - fires onReload after debounce when cert is rewritten", async () => {
  const { certFile, keyFile, cleanup } = await makeTempPair();
  let callCount = 0;
  let lastCert: string | undefined;
  let lastKey: string | undefined;
  const fired = Promise.withResolvers<void>();

  const watcher = new TlsCertWatcher({
    certFile,
    keyFile,
    debounceMs: 50,
    onReload: (cert, key) => {
      callCount++;
      lastCert = cert;
      lastKey = key;
      fired.resolve();
      return Promise.resolve();
    },
  });

  watcher.start();
  // Give the watcher a tick to subscribe.
  await new Promise((r) => setTimeout(r, 50));

  await Deno.writeTextFile(
    certFile,
    "-----BEGIN CERTIFICATE-----\nnew-cert\n-----END CERTIFICATE-----\n",
  );

  let timeoutId: number | undefined;
  await Promise.race([
    fired.promise,
    new Promise<void>((_, rej) => {
      timeoutId = setTimeout(
        () => rej(new Error("watcher didn't fire in 2s")),
        2000,
      );
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  assertEquals(callCount, 1);
  assertEquals(lastCert?.includes("new-cert"), true);
  assertEquals(lastKey?.includes("seed"), true);

  await watcher.stop();
  await cleanup();
});

Deno.test("TlsCertWatcher - debounces a burst of writes into a single reload", async () => {
  const { certFile, keyFile, cleanup } = await makeTempPair();
  let callCount = 0;
  const fired = Promise.withResolvers<void>();

  const watcher = new TlsCertWatcher({
    certFile,
    keyFile,
    debounceMs: 200,
    onReload: () => {
      callCount++;
      fired.resolve();
      return Promise.resolve();
    },
  });

  watcher.start();
  await new Promise((r) => setTimeout(r, 50));

  // Three rapid rewrites — should collapse to one reload.
  for (let i = 0; i < 3; i++) {
    await Deno.writeTextFile(
      certFile,
      `-----BEGIN CERTIFICATE-----\nrev${i}\n-----END CERTIFICATE-----\n`,
    );
    await new Promise((r) => setTimeout(r, 20));
  }
  for (let i = 0; i < 3; i++) {
    await Deno.writeTextFile(
      keyFile,
      `-----BEGIN PRIVATE KEY-----\nrev${i}\n-----END PRIVATE KEY-----\n`,
    );
    await new Promise((r) => setTimeout(r, 20));
  }

  let timeoutId: number | undefined;
  await Promise.race([
    fired.promise,
    new Promise<void>((_, rej) => {
      timeoutId = setTimeout(
        () => rej(new Error("watcher didn't fire in 2s")),
        2000,
      );
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  // Allow the debounce window to fully close so a second fire would have happened.
  await new Promise((r) => setTimeout(r, 400));

  assertEquals(callCount, 1);
  await watcher.stop();
  await cleanup();
});

Deno.test("TlsCertWatcher - skips reload when cert content is invalid PEM", async () => {
  const { certFile, keyFile, cleanup } = await makeTempPair();
  let callCount = 0;

  const watcher = new TlsCertWatcher({
    certFile,
    keyFile,
    debounceMs: 50,
    onReload: () => {
      callCount++;
      return Promise.resolve();
    },
  });

  watcher.start();
  await new Promise((r) => setTimeout(r, 50));

  await Deno.writeTextFile(certFile, "not a pem cert");
  // Wait well beyond debounce window.
  await new Promise((r) => setTimeout(r, 400));

  assertEquals(callCount, 0);
  await watcher.stop();
  await cleanup();
});

Deno.test("TlsCertWatcher - stop() is idempotent", async () => {
  const { certFile, keyFile, cleanup } = await makeTempPair();
  const watcher = new TlsCertWatcher({
    certFile,
    keyFile,
    debounceMs: 50,
    onReload: () => Promise.resolve(),
  });

  watcher.start();
  await watcher.stop();
  await watcher.stop(); // must not throw

  await cleanup();
});
