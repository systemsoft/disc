/**
 * Mailer interface and concrete implementations.
 *
 * `Mailer` is the consumer-facing surface (auth webhook subscriber
 * will depend on this, not on `SmtpClient`). Two implementations:
 *
 *   - `SmtpMailer`: builds RFC 5322 headers, generates Message-IDs,
 *     and delegates to `SmtpClient` for the actual protocol exchange.
 *   - `NoopMailer`: drop-in for when SMTP isn't configured. Logs at
 *     INFO and returns a synthetic result so callers like
 *     `requestMagicLink` never fail just because outbound mail isn't
 *     wired (gh/geldata#8224).
 *
 * `createMailer(undefined)` returns `NoopMailer`. Pass a fully-formed
 * `SmtpConfig` to get the real thing.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { getLogger } from "../lib/logger.ts";
import { defaultConnectImpl, type SendEnvelope, SmtpClient } from "./client.ts";
import type { Email, MailerResult, SmtpClientOptions, SmtpConfig } from "./types.ts";

const log = getLogger("smtp-mailer");

export interface Mailer {
  send(email: Email): Promise<MailerResult>;
}

/**
 * Production mailer: builds the message and hands it to `SmtpClient`.
 */
export class SmtpMailer implements Mailer {
  private readonly cfg: SmtpConfig;
  private readonly options: SmtpClientOptions;

  constructor(cfg: SmtpConfig, options: SmtpClientOptions = {}) {
    this.cfg = cfg;
    this.options = options;

    if (cfg.tlsRejectUnauthorized === false) {
      // Honest about the runtime constraint: Deno doesn't expose
      // per-connection cert validation toggles, so we can't actually
      // disable validation here. Tell the operator they need
      // `--unsafely-ignore-certificate-errors=<host>` on the Deno CLI.
      // See smtp/README.md.
      log.warn(
        "tlsRejectUnauthorized=false is informational only; pass " +
          "--unsafely-ignore-certificate-errors=<host> to Deno to actually " +
          "disable TLS cert validation",
        { host: cfg.host },
      );
    }
  }

  async send(email: Email): Promise<MailerResult> {
    const recipients = normalizeRecipients(email.to);
    if (recipients.length === 0) {
      throw new Error("Email.to must contain at least one recipient");
    }

    const from = email.from ?? this.cfg.from;
    const messageId = newMessageId(from);
    const replyTo = email.replyTo ?? this.cfg.replyTo;

    const body = buildMimeMessage({
      date: new Date(),
      email,
      from,
      messageId,
      replyTo,
      to: recipients,
    });

    const secure = this.cfg.secure ?? false;
    const port = this.cfg.port ?? (secure ? 465 : 587);
    const hostname = this.cfg.hostname ?? "localhost";
    const timeoutMs = this.cfg.timeoutMs ?? 30_000;

    const client = new SmtpClient({
      auth: this.cfg.auth,
      connectImpl: this.options.connectImpl ?? defaultConnectImpl,
      host: this.cfg.host,
      hostname,
      port,
      secure,
      timeoutMs,
    });

    const envelope: SendEnvelope = {
      body,
      from: extractAddr(from),
      to: recipients.map(extractAddr),
    };

    const outcome = await client.send(envelope);

    return {
      accepted: outcome.accepted,
      messageId,
      rejected: outcome.rejected,
    };
  }
}

/**
 * Drop-in mailer for unconfigured deployments.
 *
 * The original Gel bug (gh/geldata#8224) was that calling
 * `requestMagicLink` on an instance with no SMTP config raised an
 * exception. We choose graceful no-op so webhook-only delivery setups
 * keep working: the auth flow still emits the
 * `MagicLinkRequested` / `PasswordResetRequested` event, an external
 * subscriber renders + sends the email, and the SMTP path is simply
 * never exercised.
 */
export class NoopMailer implements Mailer {
  // deno-lint-ignore require-await
  async send(email: Email): Promise<MailerResult> {
    const recipients = normalizeRecipients(email.to);
    const messageId = newMessageId("noop@disc.local");
    log.info("smtp not configured; skipping send", {
      to: recipients,
      subject: email.subject,
      messageId,
    });
    return {
      accepted: recipients,
      messageId,
      rejected: [],
    };
  }
}

/**
 * Returns a `NoopMailer` when `config` is undefined, otherwise an
 * `SmtpMailer`. Callers don't have to branch on configuration —
 * always call `.send(...)` and accept that some deployments quietly
 * no-op.
 */
export function createMailer(
  config: SmtpConfig | undefined,
  options: SmtpClientOptions = {},
): Mailer {
  if (!config) return new NoopMailer();
  return new SmtpMailer(config, options);
}

// ── header / body construction ─────────────────────────────────────────

interface MimeArgs {
  date: Date;
  email: Email;
  from: string;
  messageId: string;
  replyTo?: string;
  to: string[];
}

/**
 * Build the full RFC 5322 message: headers, blank line, body. The
 * body is either text/plain or multipart/alternative depending on
 * whether `email.html` is set.
 */
function buildMimeMessage(args: MimeArgs): string {
  const headers: string[] = [];
  const seen = new Set<string>();
  const pushHeader = (name: string, value: string): void => {
    headers.push(`${name}: ${value}`);
    seen.add(name.toLowerCase());
  };

  pushHeader("From", args.from);
  pushHeader("To", args.to.join(", "));
  if (args.replyTo) pushHeader("Reply-To", args.replyTo);
  pushHeader("Subject", encodeHeaderValue(args.email.subject));
  pushHeader("Date", formatRfc5322Date(args.date));
  pushHeader("Message-ID", `<${args.messageId}>`);
  pushHeader("MIME-Version", "1.0");

  let body: string;

  if (args.email.html !== undefined) {
    const boundary = `--disc-${crypto.randomUUID()}`;
    pushHeader(
      "Content-Type",
      `multipart/alternative; boundary="${boundary}"`,
    );
    body = buildMultipartAlternative(
      args.email.text,
      args.email.html,
      boundary,
    );
  } else {
    pushHeader("Content-Type", "text/plain; charset=utf-8");
    pushHeader("Content-Transfer-Encoding", "8bit");
    body = args.email.text;
  }

  // Caller-provided headers go last so they can override defaults if
  // they really want to (e.g. setting their own Message-ID for
  // idempotency). Skip names we already emitted to avoid duplicates.
  if (args.email.headers) {
    for (const [k, v] of Object.entries(args.email.headers)) {
      if (!seen.has(k.toLowerCase())) {
        headers.push(`${k}: ${v}`);
      }
    }
  }

  return headers.join("\r\n") + "\r\n\r\n" + body;
}

function buildMultipartAlternative(
  text: string,
  html: string,
  boundary: string,
): string {
  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/plain; charset=utf-8");
  parts.push("Content-Transfer-Encoding: 8bit");
  parts.push("");
  parts.push(text);
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/html; charset=utf-8");
  parts.push("Content-Transfer-Encoding: 8bit");
  parts.push("");
  parts.push(html);
  parts.push(`--${boundary}--`);
  return parts.join("\r\n");
}

/**
 * RFC 2047 encoded-word for non-ASCII header values. Conservative:
 * we encode the entire value as a single encoded-word when any
 * non-ASCII char is present. Real-world subjects rarely exceed the
 * 75-char encoded-word limit by enough to matter for transactional
 * mail, so we don't bother splitting.
 */
function encodeHeaderValue(value: string): string {
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const encoded = encodeBase64(new TextEncoder().encode(value));
  return `=?utf-8?B?${encoded}?=`;
}

/**
 * RFC 5322 §3.3 date format. Mail servers are surprisingly picky;
 * `toUTCString()` produces "GMT" which Outlook flags. Build the
 * "+0000" form by hand.
 */
function formatRfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${days[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${
    pad(d.getUTCSeconds())
  } +0000`;
}

/**
 * Generate a Message-ID using the From address's domain (or
 * `disc.local` if none can be parsed). UUID gives us collision
 * resistance without needing a process counter.
 */
function newMessageId(from: string): string {
  const addr = extractAddr(from);
  const domain = addr.includes("@") ? addr.split("@")[1] : "disc.local";
  return `${crypto.randomUUID()}@${domain}`;
}

/** Strip display name from "Name <addr>" form, returning bare addr. */
function extractAddr(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}

function normalizeRecipients(to: string | string[]): string[] {
  if (Array.isArray(to)) return to.filter((r) => r.length > 0);
  return to.length > 0 ? [to] : [];
}

export const _testing = {
  buildMimeMessage,
  encodeHeaderValue,
  extractAddr,
  formatRfc5322Date,
  newMessageId,
};
