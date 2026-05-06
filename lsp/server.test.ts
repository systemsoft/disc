/**
 * LanguageServer message-handling tests (#7411 + #655 — Phase 1)
 *
 * Drives the server via a synthetic transport rather than real stdio
 * pipes — same code path, no Deno.command spawning needed.
 */

import { assertEquals, assertExists } from "@std/assert";
import { LanguageServer } from "./server.ts";
import type { RpcMessage } from "./protocol.ts";

class FakeTransport {
  outgoing: RpcMessage[] = [];
  send(msg: RpcMessage): void {
    this.outgoing.push(msg);
  }
  received(method: string): RpcMessage[] {
    return this.outgoing.filter((m) => "method" in m && m.method === method);
  }
}

async function newServer(): Promise<{ srv: LanguageServer; tx: FakeTransport }> {
  const tx = new FakeTransport();
  const srv = new LanguageServer((m) => tx.send(m));
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: {} },
  });
  await srv.handle({
    jsonrpc: "2.0",
    method: "initialized",
    params: {},
  });
  return { srv, tx };
}

Deno.test("LanguageServer - initialize returns capabilities", async () => {
  const tx = new FakeTransport();
  const srv = new LanguageServer((m) => tx.send(m));
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: {} },
  });
  const responses = tx.outgoing.filter(
    (m) => "id" in m && m.id === 1 && "result" in m,
  );
  assertEquals(responses.length, 1);
  const result = (responses[0] as { result: { capabilities: { textDocumentSync: number } } }).result;
  // textDocumentSync.Full = 1
  assertEquals(result.capabilities.textDocumentSync, 1);
});

Deno.test("LanguageServer - didOpen with valid SDL publishes empty diagnostics", async () => {
  const { srv, tx } = await newServer();
  tx.outgoing.length = 0; // clear init responses
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/test.disc",
        languageId: "disc",
        version: 1,
        text: "module default { type T { required name: str; }; }",
      },
    },
  });

  const published = tx.received("textDocument/publishDiagnostics");
  assertEquals(published.length, 1);
  const params = (published[0] as { params: { uri: string; diagnostics: unknown[] } }).params;
  assertEquals(params.uri, "file:///tmp/test.disc");
  assertEquals(params.diagnostics.length, 0);
});

Deno.test("LanguageServer - didOpen with bad SDL publishes error diagnostics", async () => {
  const { srv, tx } = await newServer();
  tx.outgoing.length = 0;
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/bad.disc",
        languageId: "disc",
        version: 1,
        text: `module default {
          type X {
            annotation custom_undeclared := 'x';
          };
        }`,
      },
    },
  });

  const published = tx.received("textDocument/publishDiagnostics");
  assertEquals(published.length, 1);
  const params = (published[0] as {
    params: { uri: string; diagnostics: { message: string; severity?: number }[] };
  }).params;
  assertEquals(params.uri, "file:///tmp/bad.disc");
  assertExists(
    params.diagnostics.find((d) => d.message.includes("custom_undeclared")),
  );
});

Deno.test("LanguageServer - didChange re-publishes diagnostics for new text", async () => {
  const { srv, tx } = await newServer();
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/x.disc",
        languageId: "disc",
        version: 1,
        text: "module default { type X { required name: str; }; }",
      },
    },
  });
  tx.outgoing.length = 0;

  // Replace with broken content
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: "file:///tmp/x.disc", version: 2 },
      contentChanges: [{ text: "module default { type X { typo_here; }; }" }],
    },
  });

  const published = tx.received("textDocument/publishDiagnostics");
  assertEquals(published.length, 1);
  const diags = (published[0] as { params: { diagnostics: unknown[] } }).params.diagnostics;
  assertEquals(diags.length > 0, true, "expected diagnostics for broken doc");
});

Deno.test("LanguageServer - shutdown returns null result", async () => {
  const { srv, tx } = await newServer();
  tx.outgoing.length = 0;
  await srv.handle({
    jsonrpc: "2.0",
    id: 99,
    method: "shutdown",
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 99);
  assertExists(r);
  assertEquals((r as { result: unknown }).result, null);
});
