/**
 * Protocol-level tests for `SmtpClient`. We use a scripted in-memory
 * fake socket rather than a real TCP listener — keeps tests fast,
 * deterministic, and free of port allocation. The pattern mirrors
 * `auth/webhooks.ts`'s `fetchImpl` injection.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { SmtpClient } from "./client.ts";
import type { SmtpConn, SmtpConnectImpl } from "./types.ts";

interface ScriptStep {
  /** Substring the client must write next, in order. */
  expect: string;
  /** Reply line(s) the fake server sends back. Each entry gets CRLF. */
  reply: string[];
}

interface FakeSocketResult {
  conn: SmtpConn;
  /** Everything the client wrote, decoded as utf-8. */
  written(): string;
}

function makeScriptedSocket(steps: ScriptStep[]): FakeSocketResult {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let stepIdx = -1; // -1 = banner; 0..N = real exchanges
  let writeBuffer = "";
  // Pending bytes the server is delivering to the client's read().
  let readQueue: Uint8Array = new Uint8Array(0);
  const writtenAll: string[] = [];

  const enqueueReply = (lines: string[]): void => {
    const text = lines.map((l) => l + "\r\n").join("");
    const bytes = encoder.encode(text);
    const merged = new Uint8Array(readQueue.length + bytes.length);
    merged.set(readQueue, 0);
    merged.set(bytes, readQueue.length);
    readQueue = merged;
  };

  // First "step" is the connection greeting. Caller scripts it as the
  // synthetic step at index -1: we look for steps[0] only when we see
  // the first actual write.
  // Convention: the first ScriptStep with expect: "" is the banner.
  // For simplicity we emit it eagerly here.
  if (steps.length > 0 && steps[0].expect === "") {
    enqueueReply(steps[0].reply);
    stepIdx = 0; // banner consumed; next write is matched against steps[1]
  }

  const advanceFromWrite = (chunk: string): void => {
    writeBuffer += chunk;
    writtenAll.push(chunk);
    // While the buffer contains a CRLF, we consider the line(s)
    // "delivered" and move through the script.
    while (writeBuffer.includes("\r\n")) {
      const idx = writeBuffer.indexOf("\r\n");
      const line = writeBuffer.slice(0, idx);
      writeBuffer = writeBuffer.slice(idx + 2);
      const next = stepIdx + 1;
      if (next >= steps.length) {
        throw new Error(
          `script exhausted; client wrote unexpected line: ${JSON.stringify(line)}`,
        );
      }
      const step = steps[next];
      if (!line.includes(step.expect) && step.expect !== ".") {
        throw new Error(
          `script step ${next}: expected ${JSON.stringify(step.expect)}, got ${JSON.stringify(line)}`,
        );
      }
      // Special case for end-of-DATA marker: must be exactly ".".
      if (step.expect === "." && line !== ".") {
        // The client may also write body lines; only treat a bare "."
        // as the DATA terminator. Skip body-only lines (don't advance).
        continue;
      }
      stepIdx = next;
      enqueueReply(step.reply);
    }
  };

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
          // No data yet — wait for next write to push more.
          queueMicrotask(tick);
        };
        tick();
      });
    },
    // deno-lint-ignore require-await
    async write(p: Uint8Array): Promise<number> {
      const chunk = decoder.decode(p);
      advanceFromWrite(chunk);
      return p.length;
    },
  };

  return {
    conn,
    written: () => writtenAll.join(""),
  };
}

function makeConnectImpl(socket: FakeSocketResult): SmtpConnectImpl {
  return {
    // deno-lint-ignore require-await
    connect: async () => socket.conn,
    // deno-lint-ignore require-await
    startTls: async (conn) => conn, // skip actual TLS layering in tests
  };
}

// ── tests ──────────────────────────────────────────────────────────────

Deno.test("SmtpClient - happy path: EHLO, MAIL, RCPT, DATA, QUIT", async () => {
  const socket = makeScriptedSocket([
    { expect: "", reply: ["220 smtp.test ESMTP ready"] },
    { expect: "EHLO ", reply: ["250-smtp.test", "250 SIZE 10240000"] },
    { expect: "MAIL FROM:", reply: ["250 OK"] },
    { expect: "RCPT TO:", reply: ["250 Accepted"] },
    { expect: "DATA", reply: ["354 Go ahead"] },
    { expect: ".", reply: ["250 Queued as XYZ"] },
    { expect: "QUIT", reply: ["221 Bye"] },
  ]);

  const client = new SmtpClient({
    connectImpl: makeConnectImpl(socket),
    host: "smtp.test",
    hostname: "client.test",
    port: 25,
    secure: false,
    timeoutMs: 1000,
  });

  const outcome = await client.send({
    body: "Subject: hi\r\n\r\nhello",
    from: "from@test",
    to: ["to@test"],
  });

  assertEquals(outcome.accepted, ["to@test"]);
  assertEquals(outcome.rejected, []);
  const wire = socket.written();
  assert(wire.includes("EHLO client.test"));
  assert(wire.includes("MAIL FROM:<from@test>"));
  assert(wire.includes("RCPT TO:<to@test>"));
});

Deno.test("SmtpClient - AUTH PLAIN happy path", async () => {
  const socket = makeScriptedSocket([
    { expect: "", reply: ["220 smtp.test ESMTP"] },
    { expect: "EHLO ", reply: ["250-smtp.test", "250 AUTH PLAIN LOGIN"] },
    { expect: "AUTH PLAIN ", reply: ["235 OK"] },
    { expect: "MAIL FROM:", reply: ["250 OK"] },
    { expect: "RCPT TO:", reply: ["250 Accepted"] },
    { expect: "DATA", reply: ["354 Go ahead"] },
    { expect: ".", reply: ["250 Queued"] },
    { expect: "QUIT", reply: ["221 Bye"] },
  ]);

  const client = new SmtpClient({
    auth: { user: "alice", pass: "secret" },
    connectImpl: makeConnectImpl(socket),
    host: "smtp.test",
    hostname: "client.test",
    port: 587,
    secure: false,
    timeoutMs: 1000,
  });

  await client.send({
    body: "Subject: hi\r\n\r\nbody",
    from: "from@test",
    to: ["to@test"],
  });

  const wire = socket.written();
  // Find the AUTH PLAIN payload and verify it decodes to \0user\0pass.
  const m = wire.match(/AUTH PLAIN ([A-Za-z0-9+/=]+)\r\n/);
  assert(m, "AUTH PLAIN line missing from wire");
  const decoded = new TextDecoder().decode(decodeBase64(m[1]));
  assertEquals(decoded, "\u0000alice\u0000secret");
});

Deno.test("SmtpClient - AUTH LOGIN fallback when PLAIN not advertised", async () => {
  const socket = makeScriptedSocket([
    { expect: "", reply: ["220 smtp.test"] },
    { expect: "EHLO ", reply: ["250-smtp.test", "250 AUTH LOGIN"] },
    { expect: "AUTH LOGIN", reply: ["334 VXNlcm5hbWU6"] },
    // user (base64 of "alice") then 334 to ask for pass
    { expect: "YWxpY2U=", reply: ["334 UGFzc3dvcmQ6"] },
    // pass (base64 of "secret") then 235 OK
    { expect: "c2VjcmV0", reply: ["235 OK"] },
    { expect: "MAIL FROM:", reply: ["250 OK"] },
    { expect: "RCPT TO:", reply: ["250 OK"] },
    { expect: "DATA", reply: ["354 Go"] },
    { expect: ".", reply: ["250 Queued"] },
    { expect: "QUIT", reply: ["221 Bye"] },
  ]);

  const client = new SmtpClient({
    auth: { user: "alice", pass: "secret" },
    connectImpl: makeConnectImpl(socket),
    host: "smtp.test",
    hostname: "client.test",
    port: 587,
    secure: false,
    timeoutMs: 1000,
  });

  await client.send({
    body: "Subject: hi\r\n\r\nbody",
    from: "f@x",
    to: ["t@x"],
  });

  const wire = socket.written();
  assert(wire.includes("AUTH LOGIN\r\n"));
  assert(wire.includes("YWxpY2U=\r\n"));
  assert(wire.includes("c2VjcmV0\r\n"));
});

Deno.test("SmtpClient - skips STARTTLS when secure:true (already TLS)", async () => {
  const socket = makeScriptedSocket([
    { expect: "", reply: ["220 smtp.test"] },
    { expect: "EHLO ", reply: ["250-smtp.test", "250 STARTTLS"] },
    { expect: "MAIL FROM:", reply: ["250 OK"] },
    { expect: "RCPT TO:", reply: ["250 OK"] },
    { expect: "DATA", reply: ["354 Go"] },
    { expect: ".", reply: ["250 Queued"] },
    { expect: "QUIT", reply: ["221 Bye"] },
  ]);

  const client = new SmtpClient({
    connectImpl: makeConnectImpl(socket),
    host: "smtp.test",
    hostname: "client.test",
    port: 465,
    secure: true,
    timeoutMs: 1000,
  });

  await client.send({
    body: "Subject: hi\r\n\r\nb",
    from: "f@x",
    to: ["t@x"],
  });

  const wire = socket.written();
  assert(!wire.includes("STARTTLS"));
});

Deno.test("SmtpClient - multi-recipient: some accepted, one rejected", async () => {
  const socket = makeScriptedSocket([
    { expect: "", reply: ["220 smtp.test"] },
    { expect: "EHLO ", reply: ["250 smtp.test"] },
    { expect: "MAIL FROM:", reply: ["250 OK"] },
    { expect: "RCPT TO:<a@x>", reply: ["250 OK"] },
    { expect: "RCPT TO:<bogus@x>", reply: ["550 No such user"] },
    { expect: "RCPT TO:<b@x>", reply: ["250 OK"] },
    { expect: "DATA", reply: ["354 Go"] },
    { expect: ".", reply: ["250 Queued"] },
    { expect: "QUIT", reply: ["221 Bye"] },
  ]);

  const client = new SmtpClient({
    connectImpl: makeConnectImpl(socket),
    host: "smtp.test",
    hostname: "client.test",
    port: 25,
    secure: false,
    timeoutMs: 1000,
  });

  const outcome = await client.send({
    body: "Subject: hi\r\n\r\nb",
    from: "f@x",
    to: ["a@x", "bogus@x", "b@x"],
  });

  assertEquals(outcome.accepted, ["a@x", "b@x"]);
  assertEquals(outcome.rejected, ["bogus@x"]);
});

Deno.test("SmtpClient - all RCPTs rejected: skips DATA, returns rejected", async () => {
  const socket = makeScriptedSocket([
    { expect: "", reply: ["220 smtp.test"] },
    { expect: "EHLO ", reply: ["250 smtp.test"] },
    { expect: "MAIL FROM:", reply: ["250 OK"] },
    { expect: "RCPT TO:", reply: ["550 No such user"] },
    { expect: "QUIT", reply: ["221 Bye"] },
  ]);

  const client = new SmtpClient({
    connectImpl: makeConnectImpl(socket),
    host: "smtp.test",
    hostname: "client.test",
    port: 25,
    secure: false,
    timeoutMs: 1000,
  });

  const outcome = await client.send({
    body: "Subject: hi\r\n\r\nb",
    from: "f@x",
    to: ["nobody@x"],
  });

  assertEquals(outcome.accepted, []);
  assertEquals(outcome.rejected, ["nobody@x"]);
  const wire = socket.written();
  assert(!wire.includes("DATA\r\n"), "DATA must not be sent when no RCPT accepted");
});

Deno.test("SmtpClient - server hangs up mid-DATA: throws meaningful error", async () => {
  // Hang up means read() returns null. We script up to DATA then make
  // the next read return EOF.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let writeBuffer = "";
  let readQueue: Uint8Array = encoder.encode("220 smtp.test\r\n");
  let dataSent = false;
  let dropped = false;

  const conn: SmtpConn = {
    close(): void {},
    read(p: Uint8Array): Promise<number | null> {
      return new Promise((resolve) => {
        const tick = (): void => {
          if (dropped) {
            resolve(null); // EOF
            return;
          }
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
      writeBuffer += decoder.decode(p);
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
          dataSent = true;
          readQueue = appendBytes(readQueue, encoder.encode("354 Go\r\n"));
        } else if (line === "." && dataSent) {
          dropped = true; // server disappears before final 250
        }
      }
      return p.length;
    },
  };

  const client = new SmtpClient({
    connectImpl: {
      // deno-lint-ignore require-await
      connect: async () => conn,
      // deno-lint-ignore require-await
      startTls: async (c) => c,
    },
    host: "smtp.test",
    hostname: "client.test",
    port: 25,
    secure: false,
    timeoutMs: 1000,
  });

  await assertRejects(
    () =>
      client.send({
        body: "Subject: hi\r\n\r\nb",
        from: "f@x",
        to: ["t@x"],
      }),
    Error,
  );
});

function appendBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

Deno.test("SmtpClient - dot-stuffing escapes lines starting with .", async () => {
  // Capture the bytes the client sends during DATA.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let writeBuffer = "";
  let readQueue: Uint8Array = encoder.encode("220 smtp.test\r\n");
  const allWrites: string[] = [];

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
      allWrites.push(chunk);
      writeBuffer += chunk;
      // Reply only to control commands (lines ending with CRLF that
      // we recognize). Body bytes during DATA come after the 354
      // and before the bare "." terminator — they don't get replies.
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

  const client = new SmtpClient({
    connectImpl: {
      // deno-lint-ignore require-await
      connect: async () => conn,
      // deno-lint-ignore require-await
      startTls: async (c) => c,
    },
    host: "smtp.test",
    hostname: "client.test",
    port: 25,
    secure: false,
    timeoutMs: 1000,
  });

  // Body has a line starting with "." that must become "..".
  const body = "Subject: hi\r\n\r\nnormal line\r\n.dotted line\r\nend";
  await client.send({ body, from: "f@x", to: ["t@x"] });

  const wire = allWrites.join("");
  // The dotted line should appear as "..dotted line" on the wire.
  assert(
    wire.includes("\r\n..dotted line\r\n"),
    `expected dot-stuffed line in wire; got: ${JSON.stringify(wire)}`,
  );
});
