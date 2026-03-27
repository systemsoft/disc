/**
 * SCRAM-SHA-256 server-side implementation for Gel binary protocol auth.
 *
 * Implements RFC 5802 / RFC 7677 (SCRAM-SHA-256) using the Web Crypto API
 * (crypto.subtle) for all cryptographic operations. No external dependencies.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Bridge Uint8Array<ArrayBufferLike> to Uint8Array<ArrayBuffer> for
 * WebCrypto API calls. In Deno, Uint8Array is always backed by a plain
 * ArrayBuffer, but TS 5.7+ generic Uint8Array types are stricter.
 */
const asBuf = (a: Uint8Array): Uint8Array<ArrayBuffer> =>
  a as Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScramServerState {
  username: string;
  clientNonce: string;
  serverNonce: string;
  salt: Uint8Array;
  iterations: number;
  clientFirstMessageBare: string;
  serverFirstMessage: string;
}

// ---------------------------------------------------------------------------
// Crypto helpers (all using Web Crypto API)
// ---------------------------------------------------------------------------

/**
 * Compute HMAC-SHA-256 of `data` under `key`.
 */
async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asBuf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, asBuf(data));
  return new Uint8Array(sig);
}

/**
 * Compute SHA-256 digest.
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", asBuf(data));
  return new Uint8Array(digest);
}

/**
 * Hi() — PBKDF2 with HMAC-SHA-256.
 * Equivalent to PBKDF2(password, salt, iterations, keyLen=32).
 */
async function hi(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    asBuf(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: asBuf(salt),
      iterations: iterations,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * XOR two equal-length byte arrays.
 */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error(
      `xorBytes: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  const result = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Nonce generation
// ---------------------------------------------------------------------------

function generateNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return toBase64(bytes);
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of two byte arrays.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Public API — Server-side functions
// ---------------------------------------------------------------------------

/**
 * Parse client-first-message from SASL initial response.
 *
 * Format: "n,,n=<user>,r=<client-nonce>"
 *
 * The gs2-header is "n,," (no channel binding, no authzid).
 * The client-first-message-bare is "n=<user>,r=<client-nonce>".
 */
export function parseClientFirstMessage(data: Uint8Array): {
  gs2Header: string;
  clientFirstMessageBare: string;
  username: string;
  clientNonce: string;
} {
  const str = textDecoder.decode(data);

  // Split off gs2-header: first two commas delimit it.
  // gs2-header = gs2-cbind-flag "," [authzid] ","
  const firstComma = str.indexOf(",");
  if (firstComma === -1) {
    throw new Error("SCRAM: malformed client-first-message (no commas)");
  }
  const secondComma = str.indexOf(",", firstComma + 1);
  if (secondComma === -1) {
    throw new Error(
      "SCRAM: malformed client-first-message (missing second comma)",
    );
  }

  const gs2Header = str.substring(0, secondComma + 1);
  const clientFirstMessageBare = str.substring(secondComma + 1);

  // Parse attributes from client-first-message-bare
  const attrs = clientFirstMessageBare.split(",");
  let username = "";
  let clientNonce = "";

  for (const attr of attrs) {
    if (attr.startsWith("n=")) {
      username = attr.substring(2);
    } else if (attr.startsWith("r=")) {
      clientNonce = attr.substring(2);
    }
  }

  if (!username) {
    throw new Error("SCRAM: missing username in client-first-message");
  }
  if (!clientNonce) {
    throw new Error("SCRAM: missing nonce in client-first-message");
  }

  return { gs2Header, clientFirstMessageBare, username, clientNonce };
}

/**
 * Generate server-first-message.
 *
 * Format: "r=<combined-nonce>,s=<base64-salt>,i=<iterations>"
 *
 * The combined nonce is clientNonce + serverNonce.
 */
export function generateServerFirstMessage(
  clientNonce: string,
  salt: Uint8Array,
  iterations: number,
): { serverNonce: string; serverFirstMessage: string } {
  const serverNonce = generateNonce();
  const combinedNonce = clientNonce + serverNonce;
  const serverFirstMessage = `r=${combinedNonce},s=${
    toBase64(salt)
  },i=${iterations}`;

  return { serverNonce, serverFirstMessage };
}

/**
 * Verify client-final-message and compute server signature.
 *
 * client-final-message format: "c=<channel-binding>,r=<nonce>,p=<proof>"
 *
 * Verification:
 *   AuthMessage = client-first-message-bare + "," +
 *                 server-first-message + "," +
 *                 client-final-message-without-proof
 *   ClientSignature = HMAC(StoredKey, AuthMessage)
 *   ClientKey = ClientSignature XOR ClientProof
 *   check: SHA-256(ClientKey) == StoredKey
 *   ServerSignature = HMAC(ServerKey, AuthMessage)
 */
export async function verifyClientFinalMessage(
  data: Uint8Array,
  state: ScramServerState,
  storedKey: Uint8Array,
  serverKey: Uint8Array,
): Promise<{ valid: boolean; serverSignature: string }> {
  const str = textDecoder.decode(data);

  // Parse client-final-message: c=<cb>,r=<nonce>,p=<proof>
  const attrs = str.split(",");
  let channelBinding = "";
  let nonce = "";
  let proof = "";

  for (const attr of attrs) {
    if (attr.startsWith("c=")) {
      channelBinding = attr.substring(2);
    } else if (attr.startsWith("r=")) {
      nonce = attr.substring(2);
    } else if (attr.startsWith("p=")) {
      proof = attr.substring(2);
    }
  }

  if (!channelBinding || !nonce || !proof) {
    return { valid: false, serverSignature: "" };
  }

  // Verify nonce: must be clientNonce + serverNonce
  const expectedNonce = state.clientNonce + state.serverNonce;
  if (nonce !== expectedNonce) {
    return { valid: false, serverSignature: "" };
  }

  // client-final-message-without-proof: everything before ",p="
  const proofIdx = str.lastIndexOf(",p=");
  if (proofIdx === -1) {
    return { valid: false, serverSignature: "" };
  }
  const clientFinalMessageWithoutProof = str.substring(0, proofIdx);

  // AuthMessage
  const authMessage =
    `${state.clientFirstMessageBare},${state.serverFirstMessage},${clientFinalMessageWithoutProof}`;
  const authMessageBytes = textEncoder.encode(authMessage);

  // ClientSignature = HMAC(StoredKey, AuthMessage)
  const clientSignature = await hmacSha256(storedKey, authMessageBytes);

  // ClientKey = ClientSignature XOR ClientProof
  const clientProof = fromBase64(proof);
  const clientKey = xorBytes(clientSignature, clientProof);

  // Verify: SHA-256(ClientKey) should equal StoredKey
  const computedStoredKey = await sha256(clientKey);
  const valid = constantTimeEqual(computedStoredKey, storedKey);

  // Compute ServerSignature for server-final-message
  const serverSignatureBytes = await hmacSha256(
    serverKey,
    authMessageBytes,
  );
  const serverSignature = toBase64(serverSignatureBytes);

  return { valid, serverSignature };
}

/**
 * Derive StoredKey and ServerKey from a password + salt + iterations.
 *
 *   SaltedPassword = Hi(Normalize(password), salt, iterations)
 *   ClientKey = HMAC(SaltedPassword, "Client Key")
 *   StoredKey = SHA-256(ClientKey)
 *   ServerKey = HMAC(SaltedPassword, "Server Key")
 */
export async function deriveKeys(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<{ storedKey: Uint8Array; serverKey: Uint8Array }> {
  const passwordBytes = textEncoder.encode(password);
  const saltedPassword = await hi(passwordBytes, salt, iterations);

  // ClientKey = HMAC(SaltedPassword, "Client Key")
  const clientKey = await hmacSha256(
    saltedPassword,
    textEncoder.encode("Client Key"),
  );

  // StoredKey = SHA-256(ClientKey)
  const storedKey = await sha256(clientKey);

  // ServerKey = HMAC(SaltedPassword, "Server Key")
  const serverKey = await hmacSha256(
    saltedPassword,
    textEncoder.encode("Server Key"),
  );

  return { storedKey, serverKey };
}

// ---------------------------------------------------------------------------
// Client-side helpers (exported for testing the full SCRAM flow)
// ---------------------------------------------------------------------------

/**
 * Client-side helper: build client-first-message.
 * Format: "n,,n=<user>,r=<client-nonce>"
 */
export function buildClientFirstMessage(
  username: string,
  clientNonce: string,
): { message: Uint8Array; clientFirstMessageBare: string } {
  const clientFirstMessageBare = `n=${username},r=${clientNonce}`;
  const message = textEncoder.encode(`n,,${clientFirstMessageBare}`);
  return { message, clientFirstMessageBare };
}

/**
 * Client-side helper: build client-final-message given server-first-message.
 */
export async function buildClientFinalMessage(
  password: string,
  clientNonce: string,
  clientFirstMessageBare: string,
  serverFirstMessage: string,
): Promise<Uint8Array> {
  // Parse server-first-message to get combined nonce, salt, iterations
  const serverAttrs = serverFirstMessage.split(",");
  let combinedNonce = "";
  let salt: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let iterations = 0;

  for (const attr of serverAttrs) {
    if (attr.startsWith("r=")) {
      combinedNonce = attr.substring(2);
    } else if (attr.startsWith("s=")) {
      salt = fromBase64(attr.substring(2));
    } else if (attr.startsWith("i=")) {
      iterations = parseInt(attr.substring(2), 10);
    }
  }

  // Verify combined nonce starts with client nonce
  if (!combinedNonce.startsWith(clientNonce)) {
    throw new Error("SCRAM: server nonce does not contain client nonce");
  }

  // channel-binding: base64("n,,") = "biws"
  const gs2Header = textEncoder.encode("n,,");
  const channelBinding = toBase64(gs2Header);

  // client-final-message-without-proof
  const clientFinalWithoutProof = `c=${channelBinding},r=${combinedNonce}`;

  // AuthMessage
  const authMessage =
    `${clientFirstMessageBare},${serverFirstMessage},${clientFinalWithoutProof}`;
  const authMessageBytes = textEncoder.encode(authMessage);

  // Derive keys
  const passwordBytes = textEncoder.encode(password);
  const saltedPassword = await hi(passwordBytes, salt, iterations);
  const clientKey = await hmacSha256(
    saltedPassword,
    textEncoder.encode("Client Key"),
  );
  const storedKey = await sha256(clientKey);

  // ClientSignature = HMAC(StoredKey, AuthMessage)
  const clientSignature = await hmacSha256(storedKey, authMessageBytes);

  // ClientProof = ClientKey XOR ClientSignature
  const clientProof = xorBytes(clientKey, clientSignature);

  // client-final-message
  const clientFinalMessage = `${clientFinalWithoutProof},p=${
    toBase64(clientProof)
  }`;
  return textEncoder.encode(clientFinalMessage);
}

// Re-export helpers for testing
export { fromBase64, generateNonce, toBase64 };
