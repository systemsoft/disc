/**
 * Mailer-level tests: header construction, multipart, RFC 2047
 * encoded-words, and the no-op fallback.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { _testing, createMailer, NoopMailer, SmtpMailer } from "./mailer.ts";
import type { SmtpConn, SmtpConnectImpl } from "./types.ts";

const { buildMimeMessage, encodeHeaderValue, extractAddr, newMessageId } = _testing;

// ── createMailer / NoopMailer ──────────────────────────────────────────

Deno.test("createMailer(undefined) returns a NoopMailer", async () => {
  const mailer = createMailer(undefined);
  assert(mailer instanceof NoopMailer);

  const result = await mailer.send({
    to: "x@y",
    subject: "hi",
    text: "body",
  });

  assertEquals(result.accepted, ["x@y"]);
  assertEquals(result.rejected, []);
  assertMatch(result.messageId, /^[0-9a-f-]+@/);
});

Deno.test("NoopMailer normalizes string-or-array to: list", async () => {
  const mailer = new NoopMailer();
  const r1 = await mailer.send({
    to: ["a@x", "b@x"],
    subject: "s",
    text: "t",
  });
  assertEquals(r1.accepted, ["a@x", "b@x"]);

  const r2 = await mailer.send({ to: "solo@x", subject: "s", text: "t" });
  assertEquals(r2.accepted, ["solo@x"]);
});

// ── header / body construction ─────────────────────────────────────────

Deno.test("buildMimeMessage - text-only email has expected headers", () => {
  const msg = buildMimeMessage({
    date: new Date(Date.UTC(2026, 0, 15, 10, 30, 0)),
    email: { to: "a@x", subject: "hello", text: "world" },
    from: "from@x",
    messageId: "abc@x",
    to: ["a@x"],
  });

  assert(msg.includes("From: from@x\r\n"));
  assert(msg.includes("To: a@x\r\n"));
  assert(msg.includes("Subject: hello\r\n"));
  assert(msg.includes("Date: Thu, 15 Jan 2026 10:30:00 +0000\r\n"));
  assert(msg.includes("Message-ID: <abc@x>\r\n"));
  assert(msg.includes("MIME-Version: 1.0\r\n"));
  assert(msg.includes("Content-Type: text/plain; charset=utf-8\r\n"));
  assert(msg.endsWith("world"));
});

Deno.test("buildMimeMessage - html email is multipart/alternative with both parts", () => {
  const msg = buildMimeMessage({
    date: new Date(),
    email: {
      to: "a@x",
      subject: "s",
      text: "plain",
      html: "<p>html</p>",
    },
    from: "f@x",
    messageId: "id@x",
    to: ["a@x"],
  });

  const ctMatch = msg.match(
    /Content-Type: multipart\/alternative; boundary="(.+?)"/,
  );
  assert(ctMatch, "multipart Content-Type missing");
  const boundary = ctMatch[1];
  assert(msg.includes(`--${boundary}\r\n`));
  assert(msg.includes("text/plain; charset=utf-8"));
  assert(msg.includes("text/html; charset=utf-8"));
  assert(msg.includes("plain"));
  assert(msg.includes("<p>html</p>"));
  assert(msg.includes(`--${boundary}--`));
});

Deno.test("encodeHeaderValue - ASCII passes through unchanged", () => {
  assertEquals(encodeHeaderValue("Hello World"), "Hello World");
});

Deno.test("encodeHeaderValue - non-ASCII encoded as RFC 2047 encoded-word", () => {
  const encoded = encodeHeaderValue("café ☕");
  assertMatch(encoded, /^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  // Round-trip the base64 segment to confirm it decodes to the input.
  const m = encoded.match(/^=\?utf-8\?B\?(.+?)\?=$/);
  assert(m);
  const decoded = new TextDecoder().decode(decodeBase64(m[1]));
  assertEquals(decoded, "café ☕");
});

Deno.test("extractAddr - strips display name from 'Name <addr>'", () => {
  assertEquals(extractAddr("Disc <no-reply@disc.dev>"), "no-reply@disc.dev");
  assertEquals(extractAddr("bare@x"), "bare@x");
});

Deno.test("newMessageId - uses domain from address, fallback to disc.local", () => {
  assertMatch(newMessageId("user@example.com"), /@example\.com$/);
  assertMatch(newMessageId("nodomain"), /@disc\.local$/);
});

Deno.test("buildMimeMessage - extra headers merged but don't overwrite defaults", () => {
  const msg = buildMimeMessage({
    date: new Date(Date.UTC(2026, 0, 1)),
    email: {
      to: "a@x",
      subject: "s",
      text: "t",
      headers: {
        "X-Disc-Trace": "trace-id-123",
        "From": "evil@x", // must not override the From we control
      },
    },
    from: "real@x",
    messageId: "m@x",
    to: ["a@x"],
  });

  assert(msg.includes("X-Disc-Trace: trace-id-123"));
  // Only one From header, and it's the one we set.
  const fromHeaders = msg.split("\r\n").filter((l) => l.startsWith("From:"));
  assertEquals(fromHeaders, ["From: real@x"]);
});

// ── SmtpMailer end-to-end via injected fake socket ─────────────────────

/**
 * Tiny fake that captures written bytes and replies with canned 2xx
 * codes — just enough to drive `SmtpMailer.send` through to a
 * successful `MailerResult`. Body parsing happens after the test by
 * extracting the bytes sent between "354 Go\r\n" and the bare ".".
 */
function makeRecordingSocket(): {
  conn: SmtpConn;
  written: () => string;
} {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let writeBuffer = "";
  let readQueue: Uint8Array = encoder.encode("220 smtp.test\r\n");
  const writes: string[] = [];

  const conn: SmtpConn = {
    close(): void {},
    read(p: Uint8Array): Promise<number | null> {
      return new Promise((resolve) => {
        const tick = (): void => {
          if (readQueue.length > 0) {
            const n = Math.min(p.length, readQueue.length);
            p.set(readQueue.subarray(0, n));
            readQueue = readQueue.subarray(n);
            resolve(n);
            return;
          }
          queueMicrotask(tick);
        };
        tick();
      });
    },
    // deno-lint-ignore require-await
    async write(p: Uint8Array): Promise<number> {
      const chunk = decoder.decode(p);
      writes.push(chunk);
      writeBuffer += chunk;
      while (writeBuffer.includes("\r\n")) {
        const idx = writeBuffer.indexOf("\r\n");
        const line = writeBuffer.slice(0, idx);
        writeBuffer = writeBuffer.slice(idx + 2);
        if (line.startsWith("EHLO")) {
          readQueue = appendBytes(readQueue, encoder.encode("250 smtp.test\r\n"));
        } else if (line.startsWith("MAIL FROM")) {
          readQueue = appendBytes(readQueue, encoder.encode("250 OK\r\n"));
        } else if (line.startsWith("RCPT TO")) {
          readQueue = appendBytes(readQueue, encoder.encode("250 OK\r\n"));
        } else if (line === "DATA") {
          readQueue = appendBytes(readQueue, encoder.encode("354 Go\r\n"));
        } else if (line === ".") {
          readQueue = appendBytes(readQueue, encoder.encode("250 Queued\r\n"));
        } else if (line === "QUIT") {
          readQueue = appendBytes(readQueue, encoder.encode("221 Bye\r\n"));
        }
      }
      return p.length;
    },
  };

  return { conn, written: () => writes.join("") };
}

function appendBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function makeConnectImpl(socket: { conn: SmtpConn; }): SmtpConnectImpl {
  return {
    // deno-lint-ignore require-await
    connect: async () => socket.conn,
    // deno-lint-ignore require-await
    startTls: async (c) => c,
  };
}

Deno.test("SmtpMailer.send - returns accepted/rejected and a Message-ID", async () => {
  const socket = makeRecordingSocket();
  const mailer = new SmtpMailer(
    {
      from: "Disc <no-reply@disc.dev>",
      host: "smtp.test",
      port: 25,
    },
    { connectImpl: makeConnectImpl(socket) },
  );

  const result = await mailer.send({
    to: "user@example.com",
    subject: "Welcome",
    text: "hi",
  });

  assertEquals(result.accepted, ["user@example.com"]);
  assertEquals(result.rejected, []);
  assertMatch(result.messageId, /@disc\.dev$/);

  const wire = socket.written();
  assert(wire.includes("MAIL FROM:<no-reply@disc.dev>"));
  assert(wire.includes("RCPT TO:<user@example.com>"));
  assert(wire.includes("From: Disc <no-reply@disc.dev>"));
  assert(wire.includes("Subject: Welcome"));
  assert(wire.includes("Message-ID: <"));
});

Deno.test("SmtpMailer.send - non-ASCII subject is RFC 2047 encoded on the wire", async () => {
  const socket = makeRecordingSocket();
  const mailer = new SmtpMailer(
    {
      from: "no-reply@disc.dev",
      host: "smtp.test",
      port: 25,
    },
    { connectImpl: makeConnectImpl(socket) },
  );

  await mailer.send({
    to: "user@example.com",
    subject: "Café ☕",
    text: "body",
  });

  const wire = socket.written();
  assertMatch(wire, /Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/);
  assert(!wire.includes("Subject: Café"), "raw non-ASCII subject leaked to wire");
});

Deno.test("SmtpMailer.send - html email produces multipart on the wire", async () => {
  const socket = makeRecordingSocket();
  const mailer = new SmtpMailer(
    {
      from: "no-reply@disc.dev",
      host: "smtp.test",
      port: 25,
    },
    { connectImpl: makeConnectImpl(socket) },
  );

  await mailer.send({
    to: "user@example.com",
    subject: "Hi",
    text: "plain text",
    html: "<p>html part</p>",
  });

  const wire = socket.written();
  assertMatch(wire, /Content-Type: multipart\/alternative; boundary="/);
  assert(wire.includes("plain text"));
  assert(wire.includes("<p>html part</p>"));
});

Deno.test("SmtpMailer.send - throws when 'to' is empty", async () => {
  const mailer = new SmtpMailer({
    from: "no-reply@disc.dev",
    host: "smtp.test",
    port: 25,
  });

  let caught: Error | undefined;
  try {
    await mailer.send({ to: [], subject: "s", text: "t" });
  } catch (e) {
    caught = e as Error;
  }
  assert(caught, "expected throw on empty recipient list");
  assertMatch(caught!.message, /at least one recipient/i);
});
