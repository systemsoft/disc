/**
 * SASL SCRAM-SHA-256 authentication implementation
 * Based on RFC 7677 and PostgreSQL's implementation
 */

import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import {
  decodeBase64,
  encodeBase64,
} from "https://deno.land/std@0.208.0/encoding/base64.ts";

export class ScramClient {
  private clientNonce: string;
  private serverNonce: string = "";
  private salt: Uint8Array = new Uint8Array();
  private iterations: number = 0;
  private authMessage: string = "";
  private serverSignature: string = "";

  constructor(private username: string, private password: string) {
    this.clientNonce = this.generateNonce();
  }

  /**
   * Generate client-first message for SCRAM-SHA-256
   */
  getInitialMessage(): string {
    const gs2Header = "n,,"; // No channel binding
    const clientFirstBare = `n=${
      this.saslPrep(this.username)
    },r=${this.clientNonce}`;
    this.authMessage = clientFirstBare;
    return gs2Header + clientFirstBare;
  }

  /**
   * Process server-first message and generate client-final message
   */
  async processServerFirst(serverFirst: string): Promise<string> {
    const params = this.parseServerMessage(serverFirst);

    if (!params.r || !params.s || !params.i) {
      throw new Error("Invalid server-first message");
    }

    // Verify server nonce starts with client nonce
    if (!params.r.startsWith(this.clientNonce)) {
      throw new Error("Server nonce does not match client nonce");
    }

    this.serverNonce = params.r;
    this.salt = decodeBase64(params.s);
    this.iterations = parseInt(params.i, 10);

    // Build client-final message
    const channelBinding = "c=" + encodeBase64("n,,");
    const clientFinalWithoutProof = `${channelBinding},r=${this.serverNonce}`;

    // Build auth message
    this.authMessage =
      `${this.authMessage},${serverFirst},${clientFinalWithoutProof}`;

    // Compute proof
    const saltedPassword = await this.pbkdf2(
      this.password,
      this.salt,
      this.iterations,
    );

    const clientKey = await this.hmac(saltedPassword, "Client Key");
    const storedKey = await this.sha256(clientKey);
    const clientSignature = await this.hmac(storedKey, this.authMessage);
    const clientProof = this.xor(clientKey, clientSignature);

    // Compute and store server signature for verification
    const serverKey = await this.hmac(saltedPassword, "Server Key");
    this.serverSignature = encodeBase64(
      await this.hmac(serverKey, this.authMessage),
    );

    const proof = encodeBase64(clientProof);
    return `${clientFinalWithoutProof},p=${proof}`;
  }

  /**
   * Verify server-final message
   */
  verifyServerFinal(serverFinal: string): boolean {
    const params = this.parseServerMessage(serverFinal);

    if (params.e) {
      throw new Error(`Server error: ${params.e}`);
    }

    if (!params.v) {
      throw new Error("Missing server signature");
    }

    return params.v === this.serverSignature;
  }

  /**
   * Generate a random nonce
   */
  private generateNonce(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return encodeBase64(bytes).replace(/=/g, "");
  }

  /**
   * Parse server message into key-value pairs
   */
  private parseServerMessage(message: string): Record<string, string> {
    const params: Record<string, string> = {};
    const parts = message.split(",");

    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq !== -1) {
        const key = part.substring(0, eq);
        const value = part.substring(eq + 1);
        params[key] = value;
      }
    }

    return params;
  }

  /**
   * PBKDF2 key derivation
   */
  private async pbkdf2(
    password: string,
    salt: Uint8Array,
    iterations: number,
  ): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(password);

    const key = await crypto.subtle.importKey(
      "raw",
      passwordBytes as BufferSource,
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations,
        hash: "SHA-256",
      },
      key,
      256,
    );

    return new Uint8Array(bits);
  }

  /**
   * HMAC-SHA-256
   */
  private async hmac(
    key: Uint8Array | string,
    message: string,
  ): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
    const messageBytes = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      messageBytes,
    );

    return new Uint8Array(signature);
  }

  /**
   * SHA-256 hash
   */
  private async sha256(data: Uint8Array): Promise<Uint8Array> {
    const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
    return new Uint8Array(hash);
  }

  /**
   * XOR two byte arrays
   */
  private xor(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) {
      throw new Error("XOR operands must have same length");
    }

    const result = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
      result[i] = a[i] ^ b[i];
    }
    return result;
  }

  /**
   * SASLprep normalization (simplified version)
   * Full implementation would use stringprep profile
   */
  private saslPrep(str: string): string {
    // Remove non-printable ASCII characters
    // deno-lint-ignore no-control-regex
    return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  }
}

export class ScramServer {
  private clientNonce: string = "";
  private serverNonce: string;
  private salt: Uint8Array;
  private iterations: number;
  private storedKey: Uint8Array;
  private serverKey: Uint8Array;
  private authMessage: string = "";

  constructor(
    storedKey: Uint8Array,
    serverKey: Uint8Array,
    salt: Uint8Array,
    iterations = 4096,
  ) {
    this.storedKey = storedKey;
    this.serverKey = serverKey;
    this.salt = salt;
    this.iterations = iterations;
    this.serverNonce = this.generateNonce();
  }

  /**
   * Process client-first message and generate server-first message
   */
  processClientFirst(clientFirst: string): string {
    // Parse client-first message
    const gs2Pos = clientFirst.indexOf(",", 3);
    const clientFirstBare = clientFirst.substring(gs2Pos + 1);

    const params = this.parseClientMessage(clientFirstBare);

    if (!params.n || !params.r) {
      throw new Error("Invalid client-first message");
    }

    this.clientNonce = params.r;
    this.authMessage = clientFirstBare;

    // Generate server-first message
    const serverNonce = this.clientNonce + this.serverNonce;
    const serverFirst = `r=${serverNonce},s=${
      encodeBase64(this.salt)
    },i=${this.iterations}`;

    this.authMessage += "," + serverFirst;

    return serverFirst;
  }

  /**
   * Process client-final message and generate server-final message
   */
  async processClientFinal(clientFinal: string): Promise<string> {
    const params = this.parseClientMessage(clientFinal);

    if (!params.c || !params.r || !params.p) {
      throw new Error("Invalid client-final message");
    }

    // Build auth message
    const clientFinalWithoutProof = clientFinal.replace(/,p=[^,]*$/, "");
    this.authMessage += "," + clientFinalWithoutProof;

    // Verify client proof
    const clientSignature = await this.hmac(this.storedKey, this.authMessage);
    const clientProof = decodeBase64(params.p);
    const clientKey = this.xor(clientProof, clientSignature);
    const storedKey = await this.sha256(clientKey);

    // Compare stored keys
    if (!this.compareBytes(storedKey, this.storedKey)) {
      throw new Error("Authentication failed");
    }

    // Generate server signature
    const serverSignature = await this.hmac(this.serverKey, this.authMessage);

    return `v=${encodeBase64(serverSignature)}`;
  }

  private generateNonce(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return encodeBase64(bytes).replace(/=/g, "");
  }

  private parseClientMessage(message: string): Record<string, string> {
    const params: Record<string, string> = {};
    const parts = message.split(",");

    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq !== -1) {
        const key = part.substring(0, eq);
        const value = part.substring(eq + 1);
        params[key] = value;
      }
    }

    return params;
  }

  private async hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      messageBytes,
    );

    return new Uint8Array(signature);
  }

  private async sha256(data: Uint8Array): Promise<Uint8Array> {
    const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
    return new Uint8Array(hash);
  }

  private xor(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) {
      throw new Error("XOR operands must have same length");
    }

    const result = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
      result[i] = a[i] ^ b[i];
    }
    return result;
  }

  private compareBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }
}

/**
 * Generate stored keys for a user (for server-side storage)
 */
export async function generateStoredKeys(
  _username: string,
  password: string,
  iterations = 4096,
): Promise<{
  storedKey: Uint8Array;
  serverKey: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}> {
  const encoder = new TextEncoder();
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const passwordBytes = encoder.encode(password);

  const key = await crypto.subtle.importKey(
    "raw",
    passwordBytes as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    key,
    256,
  );

  const saltedPassword = new Uint8Array(bits);

  // Generate client key and stored key
  const clientKeyBytes = encoder.encode("Client Key");
  const clientKeyCrypto = await crypto.subtle.importKey(
    "raw",
    saltedPassword as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const clientKey = new Uint8Array(
    await crypto.subtle.sign("HMAC", clientKeyCrypto, clientKeyBytes),
  );
  const storedKey = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientKey as BufferSource),
  );

  // Generate server key
  const serverKeyBytes = encoder.encode("Server Key");
  const serverKeyCrypto = await crypto.subtle.importKey(
    "raw",
    saltedPassword as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const serverKey = new Uint8Array(
    await crypto.subtle.sign("HMAC", serverKeyCrypto, serverKeyBytes),
  );

  return { storedKey, serverKey, salt, iterations };
}
