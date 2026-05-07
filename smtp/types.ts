/**
 * Public types for Disc's in-house SMTP module.
 *
 * Why in-house: there is no maintained jsr-native SMTP client and the
 * project policy is jsr-only (no `npm:` specifiers, no
 * `https://deno.land/x/...`). The protocol surface we need —
 * EHLO/STARTTLS/AUTH PLAIN|LOGIN/MAIL FROM/RCPT TO/DATA/QUIT — is
 * small enough to implement directly on top of `Deno.connect` /
 * `Deno.startTls`.
 *
 * Designed for the auth webhook subscriber that ships in the next
 * task: `Mailer` is the consumer-facing interface; `createMailer()`
 * accepts undefined config and returns a `NoopMailer` so flows that
 * call `.send(...)` keep working when SMTP isn't configured (gh/geldata#8224).
 */

/**
 * Connection + auth + identity settings for an SMTP server.
 *
 * Defaults follow nodemailer-style ergonomics:
 *   - port defaults to 587 (STARTTLS) when `secure` is unset/false,
 *     or 465 (implicit TLS) when `secure: true`
 *   - hostname defaults to "localhost" for the EHLO greeting
 *   - timeoutMs defaults to 30s per send
 */
export interface SmtpConfig {
  /**
   * Optional SMTP authentication. When provided, the client picks
   * AUTH PLAIN if advertised, otherwise AUTH LOGIN.
   */
  auth?: { user: string; pass: string; };
  /** Default From address (RFC 5322). Email.from overrides per send. */
  from: string;
  /** SMTP server hostname or IP. */
  host: string;
  /**
   * Hostname used in the EHLO greeting. Defaults to "localhost".
   * Some servers (e.g. Gmail) reject EHLO from generic names; set this
   * to a real reverse-DNS-resolvable name in production.
   */
  hostname?: string;
  /**
   * Port. Defaults to 587 (submission, STARTTLS) when !secure, or 465
   * (legacy implicit TLS) when secure.
   */
  port?: number;
  /** Override the default From for the Reply-To header on every send. */
  replyTo?: string;
  /**
   * Use implicit TLS at connection time (port 465 style). When false,
   * the client connects in plaintext and upgrades via STARTTLS if the
   * server advertises it.
   */
  secure?: boolean;
  /** Per-message timeout in ms. Default 30000. */
  timeoutMs?: number;
  /**
   * Off-by-default cert validation toggle (#8533).
   *
   * IMPORTANT: Deno does not expose a per-connection
   * `rejectUnauthorized` flag on `connectTls` / `startTls`. If you
   * need to talk to a server with a self-signed cert, set this to
   * `false` AND launch your Deno process with
   * `--unsafely-ignore-certificate-errors=<host>`.
   *
   * Setting this to `false` here only causes the mailer to log a
   * warning; the actual disable must happen at the runtime CLI level.
   * See smtp/README.md.
   */
  tlsRejectUnauthorized?: boolean;
}

/**
 * One outgoing message. `text` is required; `html` is optional and
 * triggers multipart/alternative when present.
 */
export interface Email {
  /** Optional From override (RFC 5322). Falls back to SmtpConfig.from. */
  from?: string;
  /** Extra headers, merged after defaults. Caller wins on collision. */
  headers?: Record<string, string>;
  /**
   * Optional HTML body. When present, the message is sent as
   * multipart/alternative with `text` as the plaintext fallback.
   */
  html?: string;
  /** Reply-To override; falls back to SmtpConfig.replyTo if set. */
  replyTo?: string;
  /** Subject line. RFC 2047 encoded-word applied if non-ASCII. */
  subject: string;
  /** Plaintext body. Required even when `html` is provided. */
  text: string;
  /** One or more recipients (RFC 5322). */
  to: string | string[];
}

/**
 * Per-send result returned by every `Mailer` implementation.
 *
 * `accepted` and `rejected` mirror nodemailer's shape so consumers can
 * surface partial-failure cases (some recipients accepted, others 550).
 */
export interface MailerResult {
  /** Recipients the server accepted with 250 on RCPT TO. */
  accepted: string[];
  /** RFC 5322 Message-ID assigned to this send. */
  messageId: string;
  /** Recipients the server rejected (4xx/5xx on RCPT TO). */
  rejected: string[];
}

/**
 * Test-friendly transport injection. Mirrors the pattern in
 * `auth/webhooks.ts` (`WebhookSenderOptions`).
 */
export interface SmtpClientOptions {
  /**
   * Override the socket factory. Returning a `Deno.Conn`-compatible
   * duplex stream lets tests run without binding real ports. Default
   * uses `Deno.connect` / `Deno.connectTls`.
   */
  connectImpl?: SmtpConnectImpl;
}

/**
 * Subset of `Deno.Conn` the SMTP client actually uses. Lets tests
 * substitute a fake duplex without implementing the entire interface.
 */
export interface SmtpConn {
  close(): void;
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
}

/**
 * Optional second return slot is the post-STARTTLS upgraded conn.
 * Returning `undefined` for it means STARTTLS isn't available in the
 * test fake; the client will skip the upgrade.
 */
export interface SmtpConnectImpl {
  connect(opts: {
    host: string;
    port: number;
    secure: boolean;
  }): Promise<SmtpConn>;
  /**
   * STARTTLS upgrade. Default impl wraps `Deno.startTls`. Tests can
   * return the same conn to skip TLS layering.
   */
  startTls(conn: SmtpConn, opts: { hostname: string; }): Promise<SmtpConn>;
}
