/**
 * Minimal LSP protocol types (#7411 + #655)
 *
 * Only the subset Disc's language server actually uses. Full LSP types
 * live in the `vscode-languageserver-protocol` package, but pulling
 * that in just for type aliases would be a heavy dep for what is
 * mostly a few interface declarations.
 */

// ---------------------------------------------------------------------------
// JSON-RPC envelope (LSP rides on JSON-RPC 2.0)
// ---------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface RpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

// ---------------------------------------------------------------------------
// LSP common types
// ---------------------------------------------------------------------------

export type DocumentUri = string;

export interface Position {
  line: number; // 0-indexed
  character: number; // 0-indexed
}

export interface Range {
  start: Position;
  end: Position;
}

export const enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

export interface PublishDiagnosticsParams {
  uri: DocumentUri;
  version?: number;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Document sync params
// ---------------------------------------------------------------------------

export interface TextDocumentItem {
  uri: DocumentUri;
  languageId: string;
  version: number;
  text: string;
}

export interface VersionedTextDocumentIdentifier {
  uri: DocumentUri;
  version: number;
}

export interface TextDocumentIdentifier {
  uri: DocumentUri;
}

export interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

export interface TextDocumentContentChangeEvent {
  // Phase 1 supports full-document sync only — `range` omitted means
  // `text` is the full new content.
  text: string;
}

export interface DidChangeTextDocumentParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
  textDocument: TextDocumentIdentifier;
}

// ---------------------------------------------------------------------------
// Initialize result
// ---------------------------------------------------------------------------

export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;

export interface InitializeResult {
  capabilities: {
    textDocumentSync: typeof TextDocumentSyncKind[keyof typeof TextDocumentSyncKind];
  };
  serverInfo?: { name: string; version?: string };
}
