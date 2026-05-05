/**
 * Minimal SMTP client over a TCP/TLS socket.
 *
 * Implements just enough of the SMTP submission protocol (RFC 5321 +
 * RFC 3207 STARTTLS + RFC 4954 AUTH) to send the kind of transactional
 * mail Disc's auth flows need. Not a general-purpose MTA; no
 * pipelining, no SMTPUTF8, no DSN, no XOAUTH2.
 *
 * One connection per send. That matches nodemailer's default transport
 * behavior, keeps the implementation small, and avoids the need for a
 * connection pool — auth-driven sends are infrequent.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { getLogger } from "../lib/logger.ts";
import type { SmtpConn, SmtpConnectImpl } from "./types.ts";

const log = getLogger("smtp-client");

const CRLF = "\r\n";
const DEFAULT_TIMEOUT_MS = 30_000;

/** TODO: implement XOAUTH2 (RFC 6749 §6) when there's demand. */

/**
 * Single-shot SMTP send envelope returned by `SmtpClient.send`. The
 * mailer wraps this with header building + Message-ID generation.
 */
export interface SendEnvelope {
  body: string;
  /** RFC 5321 reverse-path. */
  from: string;
  /** RFC 5321 forward-path list. */
  to: string[];
}

export interface SendOutcome {
  /** Recipients the server accepted on RCPT TO. */
  accepted: string[];
  /** Recipients the server rejected (4xx/5xx on RCPT TO). */
  rejected: string[];
}

export interface SmtpClientConfig {
  auth?: { user: string; pass: string };
  connectImpl?: SmtpConnectImpl;
  host: string;
  hostname: string;
  port: number;
  secure: boolean;
  timeoutMs: number;
}

/**
 * Default connector backed by Deno's TCP stack. Tests can swap this
 * for a fake by passing `connectImpl` via `SmtpClientConfig`.
 */
export const defaultConnectImpl: SmtpConnectImpl = {
  connect: async ({ host, port, secure }) => {
    if (secure) {
      return await Deno.connectTls({ hostname: host, port });
    }
    return await Deno.connect({ hostname: host, port });
  },
  // deno-lint-ignore require-await
  startTls: async (conn, { hostname }) => {
    // Deno.startTls only accepts Deno.TcpConn. The cast is safe in the
    // default path because `connect` always returns one; tests that
    // inject a fake duplex provide their own startTls.
    return Deno.startTls(conn as Deno.TcpConn, { hostname });
  },
};

/**
 * Raw SMTP client: takes a parsed envelope and a body, returns which
 * recipients the server accepted vs rejected. Single-use — call
 * `.send()` once per connection and let it close itself.
 */
export class SmtpClient {
  private readonly cfg: SmtpClientConfig;

  constructor(cfg: SmtpClientConfig) {
    this.cfg = cfg;
  }

  async send(envelope: SendEnvelope): Promise<SendOutcome> {
    const connector = this.cfg.connectImpl ?? defaultConnectImpl;
    let conn = await connector.connect({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
    });

    const reader = new LineReader(conn);
    let closed = false;
    const closeOnce = () => {
      if (!closed) {
        closed = true;
        try {
          conn.close();
        } catch {
          // already closed
        }
      }
    };

    try {
      // Banner: 220 <host> ESMTP ...
      await this.expect(reader, 220);

      let exts = await this.ehlo(conn, reader);

      // STARTTLS upgrade path (RFC 3207). Skipped when we connected
      // with implicit TLS (`secure: true`) or the server didn't
      // advertise it.
      if (!this.cfg.secure && exts.has("STARTTLS")) {
        await this.writeLine(conn, "STARTTLS");
        await this.expect(reader, 220);
        conn = await connector.startTls(conn, { hostname: this.cfg.host });
        reader.swap(conn);
        // RFC 3207 §4.2: after STARTTLS, repeat EHLO. Server may now
        // advertise different (e.g. AUTH) extensions over the secure
        // channel.
        exts = await this.ehlo(conn, reader);
      }

      if (this.cfg.auth) {
        await this.authenticate(conn, reader, exts);
      }

      await this.writeLine(conn, `MAIL FROM:<${envelope.from}>`);
      await this.expect(reader, 250);

      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const rcpt of envelope.to) {
        await this.writeLine(conn, `RCPT TO:<${rcpt}>`);
        const reply = await reader.readReply(this.cfg.timeoutMs);
        if (reply.code >= 200 && reply.code < 300) {
          accepted.push(rcpt);
        } else {
          rejected.push(rcpt);
          log.warn("smtp recipient rejected", {
            rcpt,
            code: reply.code,
            text: reply.text,
          });
        }
      }

      if (accepted.length === 0) {
        // Nothing to send — bail out cleanly without entering DATA.
        await this.writeLine(conn, "QUIT");
        // Don't strictly require 221; some servers drop on QUIT.
        await reader.readReply(this.cfg.timeoutMs).catch(() => {});
        return { accepted, rejected };
      }

      await this.writeLine(conn, "DATA");
      await this.expect(reader, 354);
      await this.writeBody(conn, envelope.body);
      await this.writeLine(conn, ".");
      await this.expect(reader, 250);

      await this.writeLine(conn, "QUIT");
      await reader.readReply(this.cfg.timeoutMs).catch(() => {});

      return { accepted, rejected };
    } catch (err) {
      throw wrapSmtpError(err);
    } finally {
      closeOnce();
    }
  }

  private async ehlo(
    conn: SmtpConn,
    reader: LineReader,
  ): Promise<Set<string>> {
    await this.writeLine(conn, `EHLO ${this.cfg.hostname}`);
    const reply = await reader.readReply(this.cfg.timeoutMs);
    if (reply.code !== 250) {
      throw new Error(`EHLO failed: ${reply.code} ${reply.text}`);
    }
    return parseEhloExtensions(reply.lines);
  }

  private async authenticate(
    conn: SmtpConn,
    reader: LineReader,
    exts: Set<string>,
  ): Promise<void> {
    if (!this.cfg.auth) return;
    const authExt = findAuthExtension(exts);
    const mechanisms = authExt ? authExt.split(/\s+/).slice(1).map((m) => m.toUpperCase()) : [];

    const { user, pass } = this.cfg.auth;

    if (mechanisms.includes("PLAIN") || mechanisms.length === 0) {
      // RFC 4616: \0user\0pass, base64-encoded.
      const payload = encodeBase64(
        new TextEncoder().encode(`\u0000${user}\u0000${pass}`),
      );
      await this.writeLine(conn, `AUTH PLAIN ${payload}`);
      await this.expect(reader, 235);
      return;
    }

    if (mechanisms.includes("LOGIN")) {
      await this.writeLine(conn, "AUTH LOGIN");
      await this.expect(reader, 334);
      await this.writeLine(
        conn,
        encodeBase64(new TextEncoder().encode(user)),
      );
      await this.expect(reader, 334);
      await this.writeLine(
        conn,
        encodeBase64(new TextEncoder().encode(pass)),
      );
      await this.expect(reader, 235);
      return;
    }

    throw new Error(
      `SMTP server advertises AUTH but supports no known mechanism (have: ${mechanisms.join(", ") || "(none)"})`,
    );
  }

  private async writeLine(conn: SmtpConn, line: string): Promise<void> {
    await writeAll(conn, new TextEncoder().encode(line + CRLF));
  }

  private async writeBody(conn: SmtpConn, body: string): Promise<void> {
    // Normalize line endings to CRLF and apply RFC 5321 §4.5.2
    // dot-stuffing: any line beginning with "." gets a leading dot
    // doubled so the terminator (".\r\n") isn't ambiguous.
    const normalized = body.replace(/\r\n|\r|\n/g, CRLF);
    const stuffed = normalized
      .split(CRLF)
      .map((l) => (l.startsWith(".") ? "." + l : l))
      .join(CRLF);
    const trailing = stuffed.endsWith(CRLF) ? "" : CRLF;
    await writeAll(
      conn,
      new TextEncoder().encode(stuffed + trailing),
    );
  }

  private async expect(
    reader: LineReader,
    expected: number,
  ): Promise<void> {
    const reply = await reader.readReply(this.cfg.timeoutMs);
    if (reply.code !== expected) {
      throw new Error(
        `SMTP expected ${expected}, got ${reply.code} ${reply.text}`,
      );
    }
  }
}

interface SmtpReply {
  code: number;
  /** All continuation lines, in order, without code prefix. */
  lines: string[];
  /** Joined `lines` for human-readable error reporting. */
  text: string;
}

/**
 * Buffers reads from the underlying conn into CRLF-delimited SMTP
 * reply lines. Handles multi-line replies (`250-FOO\r\n250 BAR\r\n`).
 * Public-ish so STARTTLS can swap the underlying conn while keeping
 * the buffer semantics consistent.
 */
class LineReader {
  private buffer = new Uint8Array(0);
  private conn: SmtpConn;
  private readonly decoder = new TextDecoder();

  constructor(conn: SmtpConn) {
    this.conn = conn;
  }

  swap(conn: SmtpConn): void {
    this.conn = conn;
    this.buffer = new Uint8Array(0);
  }

  async readReply(timeoutMs: number): Promise<SmtpReply> {
    const lines: string[] = [];
    let code = 0;
    while (true) {
      const line = await this.readLine(timeoutMs);
      // Reply lines are always at least 4 chars: "ddd " or "ddd-".
      if (line.length < 4) {
        throw new Error(`malformed SMTP reply: ${JSON.stringify(line)}`);
      }
      const replyCode = Number(line.slice(0, 3));
      if (Number.isNaN(replyCode)) {
        throw new Error(`malformed SMTP reply code: ${line}`);
      }
      const sep = line[3];
      const text = line.slice(4);
      lines.push(text);
      code = replyCode;
      if (sep === " ") break; // last line in a multi-line reply
      if (sep !== "-") {
        throw new Error(`malformed SMTP reply separator: ${line}`);
      }
    }
    return { code, lines, text: lines.join(" / ") };
  }

  private async readLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const idx = indexOfCrlf(this.buffer);
      if (idx >= 0) {
        const line = this.decoder.decode(this.buffer.subarray(0, idx));
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("SMTP read timed out");
      }
      const chunk = new Uint8Array(4096);
      const n = await withTimeout(this.conn.read(chunk), remaining);
      if (n === null) {
        throw new Error("SMTP connection closed by peer");
      }
      this.buffer = concatBytes(this.buffer, chunk.subarray(0, n));
    }
  }
}

function parseEhloExtensions(lines: string[]): Set<string> {
  // First EHLO line is the server greeting; subsequent lines are
  // extension names (and optional params), one per line. Index 0 is
  // intentionally skipped — it's "<host> at your service" or similar.
  const set = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;
    set.add(raw.toUpperCase());
  }
  return set;
}

function findAuthExtension(exts: Set<string>): string | undefined {
  for (const ext of exts) {
    if (ext.startsWith("AUTH ") || ext === "AUTH") return ext;
  }
  return undefined;
}

function indexOfCrlf(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function writeAll(conn: SmtpConn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const n = await conn.write(data.subarray(offset));
    if (n <= 0) throw new Error("SMTP write returned 0 bytes");
    offset += n;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("SMTP operation timed out")),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function wrapSmtpError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export const _testing = {
  DEFAULT_TIMEOUT_MS,
  parseEhloExtensions,
};
