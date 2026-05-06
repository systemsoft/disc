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
    hoverProvider?: boolean;
    completionProvider?: { triggerCharacters?: string[] };
    definitionProvider?: boolean;
    documentSymbolProvider?: boolean;
    referencesProvider?: boolean;
    renameProvider?: boolean | { prepareProvider?: boolean };
  };
  serverInfo?: { name: string; version?: string };
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface Hover {
  contents: MarkupContent;
  range?: Range;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export const enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export interface CompletionItem {
  label: string;
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string | MarkupContent;
  insertText?: string;
}

// ---------------------------------------------------------------------------
// Definition + document symbols
// ---------------------------------------------------------------------------

export interface Location {
  uri: DocumentUri;
  range: Range;
}

export const enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

// ---------------------------------------------------------------------------
// References + rename
// ---------------------------------------------------------------------------

export interface ReferenceContext {
  includeDeclaration: boolean;
}

export interface ReferenceParams extends TextDocumentPositionParams {
  context?: ReferenceContext;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  /** URI → list of edits, applied as a single atomic operation by the editor. */
  changes?: Record<DocumentUri, TextEdit[]>;
}

export interface RenameParams extends TextDocumentPositionParams {
  newName: string;
}
