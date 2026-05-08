/**
 * Disc Language Server (#7411 + #655)
 *
 * Phase 1 covers the bare-minimum LSP loop:
 *   - `initialize` / `initialized` handshake
 *   - `textDocument/didOpen` / `didChange` / `didClose` (full-document sync)
 *   - `textDocument/publishDiagnostics` after each change
 *   - `shutdown` / `exit`
 *
 * No hover / completion / go-to-definition yet — those land in
 * follow-up phases. The transport (stdio framing) is separated from
 * message handling so tests can drive the server with a synthetic
 * transport.
 */

import { provideCompletion } from "./completion.ts";
import { provideDefinition } from "./definition.ts";
import { analyzeDiscDocument } from "./diagnostics.ts";
import { provideDocumentSymbols } from "./document-symbols.ts";
import {
  analyzeEmbeddedDocument,
  type EmbeddedSdlContext,
  isEmbeddedEqlHost,
  provideEmbeddedCompletion,
  provideEmbeddedDefinition,
  provideEmbeddedHover
} from "./embedded-edgeql.ts";
import { provideFormatting } from "./formatting.ts";
import { provideHover } from "./hover.ts";
import {
  type DidChangeTextDocumentParams,
  type DidCloseTextDocumentParams,
  type DidOpenTextDocumentParams,
  type DocumentFormattingParams,
  type DocumentUri,
  type InitializeResult,
  type PublishDiagnosticsParams,
  type ReferenceParams,
  type RenameParams,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcSuccessResponse,
  type SemanticTokensParams,
  type TextDocumentIdentifier,
  type TextDocumentPositionParams,
  TextDocumentSyncKind
} from "./protocol.ts";
import { provideReferences } from "./references.ts";
import { prepareRename, provideRename } from "./rename.ts";
import { provideSemanticTokens, SEMANTIC_TOKEN_LEGEND } from "./semantic-tokens.ts";

type Sender = (msg: RpcMessage) => void;

interface OpenDocument {
  text: string;
  version: number;
}

export class LanguageServer {
  private docs = new Map<DocumentUri, OpenDocument>();
  private initialized = false;
  private shutdownRequested = false;

  constructor(private send: Sender) {}

  /**
   * Process a single inbound JSON-RPC message. Sync from the caller's
   * perspective — diagnostics analysis is fast and CPU-bound, so we
   * don't bother with async queuing for Phase 1.
   */
  /**
   * Process a single inbound JSON-RPC message. Returns a Promise so
   * callers can `await` it — handling is synchronous today, but
   * future phases (hover/completion) will need DB lookups, and
   * keeping the async signature now avoids a callsite churn later.
   */
  handle(msg: RpcMessage): Promise<void> {
    if ("method" in msg) {
      if ("id" in msg) {
        this.handleRequest(msg as RpcRequest);
      } else {
        this.handleNotification(msg as RpcNotification);
      }
    }
    // Ignore inbound responses — Phase 1 doesn't issue server→client
    // requests.
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------
  // Requests (require a response)
  // ---------------------------------------------------------------------

  private handleRequest(req: RpcRequest): void {
    switch (req.method) {
      case "initialize": {
        const result: InitializeResult = {
          capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            hoverProvider: true,
            completionProvider: { triggerCharacters: [":", " ", ">"] },
            definitionProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            documentFormattingProvider: true,
            semanticTokensProvider: {
              legend: SEMANTIC_TOKEN_LEGEND,
              full: true
            }
          },
          serverInfo: { name: "disc-lsp", version: "0.1.0" }
        };
        this.respond(req.id, result);
        return;
      }

      case "textDocument/hover": {
        const params = req.params as TextDocumentPositionParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, null);
          return;
        }
        // Phase 6: TS/JS host files get embedded-EdgeQL hover scoped
        // to `eql\`...\`` literals. Phase 7 adds cross-file SDL
        // resolution — user-defined types declared in any open
        // `.disc` document are surfaced too. Outside any literal
        // returns null so we don't surface SDL-flavored hover in
        // plain TS code.
        const hover = isEmbeddedEqlHost(params.textDocument.uri) ?
          provideEmbeddedHover(doc.text, params.position, this.collectSdlContext()) :
          provideHover(doc.text, params.position);
        this.respond(req.id, hover);
        return;
      }

      case "textDocument/completion": {
        const params = req.params as TextDocumentPositionParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, []);
          return;
        }
        const completion = isEmbeddedEqlHost(params.textDocument.uri) ?
          provideEmbeddedCompletion(doc.text, params.position, this.collectSdlContext()) :
          provideCompletion(doc.text, params.position);
        this.respond(req.id, completion);
        return;
      }

      case "textDocument/definition": {
        const params = req.params as TextDocumentPositionParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, null);
          return;
        }
        // Phase 7: TS/JS host files route through the embedded
        // definition provider so a user-defined type in `eql\`...\``
        // jumps to its `.disc` declaration. SDL files keep the
        // existing same-file resolution.
        const definition = isEmbeddedEqlHost(params.textDocument.uri) ?
          provideEmbeddedDefinition(doc.text, params.position, this.collectSdlContext()) :
          provideDefinition(doc.text, params.position, params.textDocument.uri);
        this.respond(req.id, definition);
        return;
      }

      case "textDocument/documentSymbol": {
        const params = req.params as { textDocument: TextDocumentIdentifier; };
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, []);
          return;
        }
        this.respond(req.id, provideDocumentSymbols(doc.text));
        return;
      }

      case "textDocument/references": {
        const params = req.params as ReferenceParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, []);
          return;
        }
        // Phase 8a: pass the cross-file SDL context so a type
        // declared in one .disc file finds uses in sibling files.
        this.respond(
          req.id,
          provideReferences(
            doc.text,
            params.position,
            params.textDocument.uri,
            {
              includeDeclaration: params.context?.includeDeclaration ?? true,
              context: this.collectSdlContext()
            }
          )
        );
        return;
      }

      case "textDocument/prepareRename": {
        const params = req.params as TextDocumentPositionParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, null);
          return;
        }
        this.respond(req.id, prepareRename(doc.text, params.position));
        return;
      }

      case "textDocument/rename": {
        const params = req.params as RenameParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, null);
          return;
        }
        // Phase 8a: pass the cross-file SDL context so renames edit
        // every file that uses the type + collision-check against
        // siblings.
        this.respond(
          req.id,
          provideRename(
            doc.text,
            params.position,
            params.newName,
            params.textDocument.uri,
            { context: this.collectSdlContext() }
          )
        );
        return;
      }

      case "textDocument/semanticTokens/full": {
        const params = req.params as SemanticTokensParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, { data: [] });
          return;
        }
        // Phase 8c: only emit semantic tokens for `.disc` files. The
        // embedded-EdgeQL provider would need its own legend for TS
        // host files; out of scope for v1.
        if (!params.textDocument.uri.endsWith(".disc")) {
          this.respond(req.id, { data: [] });
          return;
        }
        this.respond(req.id, provideSemanticTokens(doc.text));
        return;
      }

      case "textDocument/formatting": {
        const params = req.params as DocumentFormattingParams;
        const doc = this.docs.get(params.textDocument.uri);
        if (!doc) {
          this.respond(req.id, []);
          return;
        }
        // Phase 8b: only format `.disc` files. Embedded EdgeQL inside
        // TS/JS host files is out of scope — let the host formatter
        // (deno fmt / prettier) handle those.
        if (!params.textDocument.uri.endsWith(".disc")) {
          this.respond(req.id, []);
          return;
        }
        this.respond(req.id, provideFormatting(doc.text));
        return;
      }

      case "shutdown": {
        this.shutdownRequested = true;
        this.respond(req.id, null);
        return;
      }

      default: {
        // Unknown method — respond with a method-not-found error so
        // the client doesn't hang on its pending request.
        this.send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` }
        });
        return;
      }
    }
  }

  /**
   * Build the cross-file SDL context for embedded-EdgeQL providers
   * (Phase 7). Iterates every open document, picks out the `.disc`
   * files, and hands their text + URI to the embedded providers so
   * hover/completion/definition for user-declared types resolve from
   * the SDL the editor has open.
   *
   * No FS scan — we rely on the editor having opened the relevant
   * `.disc` file (most editors do this when the project's lsp config
   * declares `.disc` as a known language). When no SDL is open, the
   * providers fall back to Phase 6 behavior (keywords + scalars only).
   */
  private collectSdlContext(): EmbeddedSdlContext {
    const documents: { uri: DocumentUri; text: string; }[] = [];
    for (const [uri, doc] of this.docs) {
      if (uri.endsWith(".disc")) {
        documents.push({ uri, text: doc.text });
      }
    }
    return { documents };
  }

  // ---------------------------------------------------------------------
  // Notifications (no response)
  // ---------------------------------------------------------------------

  private handleNotification(notif: RpcNotification): void {
    switch (notif.method) {
      case "initialized":
        this.initialized = true;
        return;

      case "exit":
        // The transport layer translates this into a process exit.
        return;

      case "textDocument/didOpen":
        this.onDidOpen(notif.params as DidOpenTextDocumentParams);
        return;

      case "textDocument/didChange":
        this.onDidChange(notif.params as DidChangeTextDocumentParams);
        return;

      case "textDocument/didClose":
        this.onDidClose(notif.params as DidCloseTextDocumentParams);
        return;

      default:
        // Silently ignore unknown notifications per LSP spec.
        return;
    }
  }

  // ---------------------------------------------------------------------
  // Document sync handlers
  // ---------------------------------------------------------------------

  private onDidOpen(params: DidOpenTextDocumentParams): void {
    const { uri, text, version } = params.textDocument;
    this.docs.set(uri, { text, version });
    this.publishDiagnostics(uri, version, text);
  }

  private onDidChange(params: DidChangeTextDocumentParams): void {
    const uri = params.textDocument.uri;
    // Phase 1 sync mode is Full — the last entry contains the full new text.
    const change = params.contentChanges[params.contentChanges.length - 1];
    if (!change)
      return;
    const text = change.text;
    const version = params.textDocument.version;
    this.docs.set(uri, { text, version });
    this.publishDiagnostics(uri, version, text);
  }

  private onDidClose(params: DidCloseTextDocumentParams): void {
    const uri = params.textDocument.uri;
    this.docs.delete(uri);
    // Per LSP convention, clear diagnostics for closed files so they
    // don't linger in the editor's problems pane.
    this.publishDiagnostics(uri, undefined, "");
  }

  private publishDiagnostics(
    uri: DocumentUri,
    version: number | undefined,
    text: string
  ): void {
    // SDL diagnostics for `.disc`; embedded-EdgeQL diagnostics for any
    // TS/JS host file (Phase 5). Other URIs get an empty diagnostic
    // list so the editor's problems pane stays clean.
    const diagnostics = isEmbeddedEqlHost(uri) ? analyzeEmbeddedDocument(text) : analyzeDiscDocument(text);
    const params: PublishDiagnosticsParams = {
      uri,
      version,
      diagnostics
    };
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params
    });
  }

  private respond(id: number | string, result: unknown): void {
    const resp: RpcSuccessResponse = {
      jsonrpc: "2.0",
      id,
      result
    };
    this.send(resp);
  }

  /** Test/diagnostic accessors */
  isInitialized(): boolean {
    return this.initialized;
  }

  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }
}

// ---------------------------------------------------------------------
// Stdio transport — wraps a `LanguageServer` to read/write LSP
// framing on stdin/stdout.
// ---------------------------------------------------------------------

/**
 * Run the language server reading framed JSON-RPC from stdin and
 * writing to stdout. Returns when the client sends an `exit`
 * notification (after a prior `shutdown`).
 */
export async function runStdio(): Promise<number> {
  const encoder = new TextEncoder();
  const writer = Deno.stdout.writable.getWriter();

  const send = (msg: RpcMessage): void => {
    const body = encoder.encode(JSON.stringify(msg));
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    // Fire-and-forget: chained writes are serialized by the writer's
    // internal queue. Errors abort the loop on the next read.
    writer.write(header).catch(() => {});
    writer.write(body).catch(() => {});
  };

  const server = new LanguageServer(send);
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);

  while (true) {
    let chunk: Uint8Array;
    try {
      const { value, done } = await reader.read();
      if (done)
        break;
      chunk = value;
    } catch {
      break;
    }

    // Append to buffer.
    const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
    merged.set(buffer);
    merged.set(chunk, buffer.byteLength);
    buffer = merged;

    // Drain as many full messages as the buffer holds.
    while (true) {
      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd === -1)
        break;
      const headerText = decoder.decode(buffer.subarray(0, headerEnd));
      const contentLength = parseContentLength(headerText);
      if (contentLength === null) {
        // Malformed header — drop the buffer and resume.
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const totalNeeded = headerEnd + 4 + contentLength;
      if (buffer.byteLength < totalNeeded)
        break;
      const body = decoder.decode(
        buffer.subarray(headerEnd + 4, totalNeeded)
      );
      buffer = buffer.subarray(totalNeeded);

      let msg: RpcMessage;
      try {
        msg = JSON.parse(body) as RpcMessage;
      } catch {
        continue;
      }
      await server.handle(msg);

      // The `exit` notification ends the loop after a prior shutdown.
      if (
        "method" in msg &&
        msg.method === "exit" &&
        !("id" in msg)
      ) {
        return server.isShutdownRequested() ? 0 : 1;
      }
    }
  }

  return 0;
}

function findHeaderEnd(buf: Uint8Array): number {
  // Look for `\r\n\r\n` (0x0D 0x0A 0x0D 0x0A).
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split(/\r\n/)) {
    const m = line.match(/^Content-Length:\s*(\d+)$/i);
    if (m)
      return parseInt(m[1], 10);
  }
  return null;
}
