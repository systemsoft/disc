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

Deno.test("LanguageServer - initialize advertises hover + completion capabilities", async () => {
  const tx = new FakeTransport();
  const srv = new LanguageServer((m) => tx.send(m));
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: {} },
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 1);
  const result = (r as { result: { capabilities: Record<string, unknown> } }).result;
  assertEquals(result.capabilities.hoverProvider, true);
  assertExists(result.capabilities.completionProvider);
});

Deno.test("LanguageServer - hover request returns markdown for known scalar", async () => {
  const { srv, tx } = await newServer();
  const text = `module default {
  type T {
    required name: str;
  };
}`;
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///a.disc", languageId: "disc", version: 1, text },
    },
  });
  tx.outgoing.length = 0;

  // Position over `str` (line 2, column 19 — `    required name: str;`)
  const strLineIdx = text.split("\n").findIndex((l) => l.includes(": str"));
  const character = text.split("\n")[strLineIdx].indexOf("str");
  await srv.handle({
    jsonrpc: "2.0",
    id: 42,
    method: "textDocument/hover",
    params: {
      textDocument: { uri: "file:///a.disc" },
      position: { line: strLineIdx, character },
    },
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 42);
  assertExists(r);
  const result = (r as { result: { contents: { value: string } } | null }).result;
  assertExists(result);
  assertEquals(result!.contents.value.includes("str"), true);
});

Deno.test("LanguageServer - completion returns SDL keywords + scalars", async () => {
  const { srv, tx } = await newServer();
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///c.disc",
        languageId: "disc",
        version: 1,
        text: "module default {\n}",
      },
    },
  });
  tx.outgoing.length = 0;
  await srv.handle({
    jsonrpc: "2.0",
    id: 7,
    method: "textDocument/completion",
    params: {
      textDocument: { uri: "file:///c.disc" },
      position: { line: 1, character: 0 },
    },
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 7);
  const result = (r as { result: { label: string }[] }).result;
  const labels = new Set(result.map((i) => i.label));
  assertEquals(labels.has("type"), true);
  assertEquals(labels.has("str"), true);
});

Deno.test("LanguageServer - hover/completion on unknown document returns null/empty", async () => {
  const { srv, tx } = await newServer();
  tx.outgoing.length = 0;
  await srv.handle({
    jsonrpc: "2.0",
    id: 50,
    method: "textDocument/hover",
    params: {
      textDocument: { uri: "file:///nonexistent.disc" },
      position: { line: 0, character: 0 },
    },
  });
  const hover = tx.outgoing.find((m) => "id" in m && m.id === 50);
  assertEquals((hover as { result: unknown }).result, null);

  await srv.handle({
    jsonrpc: "2.0",
    id: 51,
    method: "textDocument/completion",
    params: {
      textDocument: { uri: "file:///nonexistent.disc" },
      position: { line: 0, character: 0 },
    },
  });
  const compl = tx.outgoing.find((m) => "id" in m && m.id === 51);
  assertEquals(((compl as { result: unknown }).result as unknown[]).length, 0);
});

Deno.test("LanguageServer - initialize advertises definition + documentSymbol capabilities", async () => {
  const tx = new FakeTransport();
  const srv = new LanguageServer((m) => tx.send(m));
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: {} },
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 1);
  const result = (r as { result: { capabilities: Record<string, unknown> } }).result;
  assertEquals(result.capabilities.definitionProvider, true);
  assertEquals(result.capabilities.documentSymbolProvider, true);
});

Deno.test("LanguageServer - definition jumps to declaration", async () => {
  const { srv, tx } = await newServer();
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required link author -> User;
  };
}`;
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///d.disc", languageId: "disc", version: 1, text },
    },
  });
  tx.outgoing.length = 0;

  // Position over the second `User` (the reference)
  const lines = text.split("\n");
  const refLine = lines.findIndex((l) => l.includes("-> User"));
  const character = lines[refLine].indexOf("User");

  await srv.handle({
    jsonrpc: "2.0",
    id: 33,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: "file:///d.disc" },
      position: { line: refLine, character },
    },
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 33);
  assertExists(r);
  const result = (r as { result: { uri: string; range: { start: { line: number } } } | null }).result;
  assertExists(result);
  assertEquals(result!.uri, "file:///d.disc");
  // Declaration is on the line containing `type User`
  const declLine = lines.findIndex((l) => l.includes("type User"));
  assertEquals(result!.range.start.line, declLine);
});

Deno.test("LanguageServer - documentSymbol returns the file outline", async () => {
  const { srv, tx } = await newServer();
  await srv.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///s.disc",
        languageId: "disc",
        version: 1,
        text: `module default {
  type User {
    required name: str;
    multi link posts -> Post;
  };

  type Post {
    required title: str;
  };
}`,
      },
    },
  });
  tx.outgoing.length = 0;

  await srv.handle({
    jsonrpc: "2.0",
    id: 44,
    method: "textDocument/documentSymbol",
    params: { textDocument: { uri: "file:///s.disc" } },
  });
  const r = tx.outgoing.find((m) => "id" in m && m.id === 44);
  const result = (r as { result: { name: string; children?: { name: string }[] }[] }).result;
  const names = result.map((s) => s.name).sort();
  assertEquals(names, ["Post", "User"]);
  const user = result.find((s) => s.name === "User")!;
  const childNames = (user.children ?? []).map((c) => c.name).sort();
  assertEquals(childNames, ["name", "posts"]);
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
