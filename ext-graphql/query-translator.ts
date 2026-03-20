/**
 * Translates GraphQL queries to EdgeQL queries.
 *
 * Implements a simplified recursive descent parser for the GraphQL
 * query language subset needed by Disc. Handles basic queries,
 * mutations, arguments, nested selections, and aliases.
 * Does NOT handle fragments, directives, or subscriptions.
 */

import type { Schema } from "../compiler/context.ts";

// ── Parsed structures ─────────────────────────────────────────────────

export interface ParsedGraphQLQuery {
  type: "query" | "mutation";
  operationName?: string;
  selections: GraphQLSelection[];
  variables?: Record<string, unknown>;
}

export interface GraphQLSelection {
  alias?: string;
  arguments: Record<string, unknown>;
  fieldName: string;
  subSelections?: GraphQLSelection[];
}

export interface TranslationResult {
  edgeql: string;
  variables: Record<string, unknown>;
}

// ── Parser ────────────────────────────────────────────────────────────

/**
 * Simplified GraphQL query parser.
 *
 * Handles the subset of GraphQL needed for Disc:
 * - query { ... } and mutation { ... }
 * - Named operations: query GetUser { ... }
 * - Field selections with arguments: user(id: "123") { name }
 * - Nested selections: user { posts { title } }
 * - Field aliases: userName: name
 * - String, number, boolean, null literals in arguments
 * - Variable references ($varName) in arguments
 */
export function parseGraphQLQuery(query: string): ParsedGraphQLQuery {
  const parser = new GraphQLParser(query);
  return parser.parse();
}

class GraphQLParser {
  private pos = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  parse(): ParsedGraphQLQuery {
    this.skipWhitespace();

    let type: "query" | "mutation" = "query";
    let operationName: string | undefined;

    // Check for explicit operation type
    if (this.lookAhead("mutation")) {
      this.consume("mutation");
      type = "mutation";
      this.skipWhitespace();

      // Optional operation name
      if (this.peek() !== "{" && this.peek() !== "(") {
        operationName = this.readName();
        this.skipWhitespace();
      }
    } else if (this.lookAhead("query")) {
      this.consume("query");
      type = "query";
      this.skipWhitespace();

      // Optional operation name
      if (this.peek() !== "{" && this.peek() !== "(") {
        operationName = this.readName();
        this.skipWhitespace();
      }
    }

    // Skip variable definitions (simplified: just skip parens)
    if (this.peek() === "(") {
      this.skipVariableDefinitions();
      this.skipWhitespace();
    }

    // Parse selection set
    const selections = this.parseSelectionSet();

    return { operationName, selections, type };
  }

  private parseSelectionSet(): GraphQLSelection[] {
    this.expect("{");
    this.skipWhitespace();

    const selections: GraphQLSelection[] = [];

    while (this.peek() !== "}" && this.pos < this.input.length) {
      selections.push(this.parseSelection());
      this.skipWhitespace();
      // Skip optional commas between selections
      if (this.peek() === ",") {
        this.pos++;
        this.skipWhitespace();
      }
    }

    this.expect("}");
    return selections;
  }

  private parseSelection(): GraphQLSelection {
    this.skipWhitespace();

    // Read first name — could be alias or field name
    const firstName = this.readName();
    this.skipWhitespace();

    let alias: string | undefined;
    let fieldName: string;

    // Check for alias (name: fieldName)
    if (this.peek() === ":") {
      this.pos++; // consume ':'
      this.skipWhitespace();
      alias = firstName;
      fieldName = this.readName();
      this.skipWhitespace();
    } else {
      fieldName = firstName;
    }

    // Parse arguments
    let args: Record<string, unknown> = {};
    if (this.peek() === "(") {
      args = this.parseArguments();
      this.skipWhitespace();
    }

    // Parse sub-selections
    let subSelections: GraphQLSelection[] | undefined;
    if (this.peek() === "{") {
      subSelections = this.parseSelectionSet();
      this.skipWhitespace();
    }

    return { alias, arguments: args, fieldName, subSelections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expect("(");
    this.skipWhitespace();

    const args: Record<string, unknown> = {};

    while (this.peek() !== ")" && this.pos < this.input.length) {
      const name = this.readName();
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      const value = this.parseValue();
      args[name] = value;
      this.skipWhitespace();

      // Optional comma
      if (this.peek() === ",") {
        this.pos++;
        this.skipWhitespace();
      }
    }

    this.expect(")");
    return args;
  }

  private parseValue(): unknown {
    const ch = this.peek();

    // String literal
    if (ch === '"') {
      return this.parseString();
    }

    // Variable reference
    if (ch === "$") {
      this.pos++;
      const name = this.readName();
      return { __variable: name };
    }

    // Object literal
    if (ch === "{") {
      return this.parseObjectValue();
    }

    // Array literal
    if (ch === "[") {
      return this.parseArrayValue();
    }

    // Number, boolean, null, or enum value
    const word = this.readName();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;

    // Try to parse as number
    const num = Number(word);
    if (!isNaN(num)) return num;

    // Enum value
    return word;
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    while (this.pos < this.input.length && this.peek() !== '"') {
      if (this.peek() === "\\") {
        this.pos++;
        const escaped = this.peek();
        this.pos++;
        switch (escaped) {
          case "n":
            result += "\n";
            break;
          case "t":
            result += "\t";
            break;
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          default:
            result += escaped;
        }
      } else {
        result += this.input[this.pos];
        this.pos++;
      }
    }
    this.expect('"');
    return result;
  }

  private parseObjectValue(): Record<string, unknown> {
    this.expect("{");
    this.skipWhitespace();
    const obj: Record<string, unknown> = {};

    while (this.peek() !== "}" && this.pos < this.input.length) {
      const key = this.readName();
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      obj[key] = this.parseValue();
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.pos++;
        this.skipWhitespace();
      }
    }

    this.expect("}");
    return obj;
  }

  private parseArrayValue(): unknown[] {
    this.expect("[");
    this.skipWhitespace();
    const arr: unknown[] = [];

    while (this.peek() !== "]" && this.pos < this.input.length) {
      arr.push(this.parseValue());
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.pos++;
        this.skipWhitespace();
      }
    }

    this.expect("]");
    return arr;
  }

  private skipVariableDefinitions(): void {
    this.expect("(");
    let depth = 1;
    while (depth > 0 && this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      this.pos++;
    }
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.pos++;
      } else if (ch === "#") {
        // Skip line comment
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  private peek(): string {
    return this.pos < this.input.length ? this.input[this.pos] : "";
  }

  private expect(ch: string): void {
    if (this.input[this.pos] !== ch) {
      throw new Error(
        `GraphQL parse error: expected '${ch}' at position ${this.pos}, got '${
          this.input[this.pos] ?? "EOF"
        }'`,
      );
    }
    this.pos++;
  }

  private consume(word: string): void {
    for (let i = 0; i < word.length; i++) {
      if (this.input[this.pos + i] !== word[i]) {
        throw new Error(
          `GraphQL parse error: expected '${word}' at position ${this.pos}`,
        );
      }
    }
    this.pos += word.length;
  }

  private lookAhead(word: string): boolean {
    for (let i = 0; i < word.length; i++) {
      if (this.input[this.pos + i] !== word[i]) return false;
    }
    // Ensure the word ends at a boundary (not part of a longer name)
    const nextChar = this.input[this.pos + word.length];
    if (nextChar && /[a-zA-Z0-9_]/.test(nextChar)) return false;
    return true;
  }

  private readName(): string {
    const start = this.pos;
    while (
      this.pos < this.input.length &&
      /[a-zA-Z0-9_]/.test(this.input[this.pos])
    ) {
      this.pos++;
    }
    if (this.pos === start) {
      throw new Error(
        `GraphQL parse error: expected name at position ${this.pos}, got '${
          this.input[this.pos] ?? "EOF"
        }'`,
      );
    }
    return this.input.slice(start, this.pos);
  }
}

// ── Translator ────────────────────────────────────────────────────────

/**
 * Resolve a GraphQL root field name to a Disc schema type name.
 *
 * Handles patterns:
 * - "user" -> "User" (fetch-by-id)
 * - "allUsers" -> "User" (list query)
 * - "createUser" -> "User" (mutation)
 * - "updateUser" -> "User" (mutation)
 * - "deleteUser" -> "User" (mutation)
 */
function resolveTypeName(
  fieldName: string,
  schema: Schema,
): string | undefined {
  // Direct PascalCase match
  const pascal = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

  // Try direct match first
  for (const [name] of schema.types) {
    const shortName = name.includes("::") ? name.split("::").pop()! : name;
    if (shortName === pascal) return shortName;
  }

  // "allUsers" -> "User" (strip "all" prefix and trailing "s")
  if (fieldName.startsWith("all") && fieldName.endsWith("s")) {
    const candidate = fieldName.slice(3, -1);
    for (const [name] of schema.types) {
      const shortName = name.includes("::") ? name.split("::").pop()! : name;
      if (shortName === candidate) return shortName;
    }
  }

  // "createUser", "updateUser", "deleteUser"
  for (const prefix of ["create", "update", "delete"]) {
    if (fieldName.startsWith(prefix)) {
      const candidate = fieldName.slice(prefix.length);
      for (const [name] of schema.types) {
        const shortName = name.includes("::") ? name.split("::").pop()! : name;
        if (shortName === candidate) return shortName;
      }
    }
  }

  return undefined;
}

/**
 * Build the EdgeQL shape string from a list of GraphQL selections.
 */
function buildShape(selections: GraphQLSelection[]): string {
  const parts: string[] = [];
  for (const sel of selections) {
    if (sel.subSelections && sel.subSelections.length > 0) {
      parts.push(`${sel.fieldName}: {${buildShape(sel.subSelections)}}`);
    } else {
      parts.push(sel.fieldName);
    }
  }
  return parts.join(", ");
}

/**
 * Format a value for use in EdgeQL.
 */
function formatEdgeQLValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "{}";
  if (
    typeof value === "object" && value !== null && "__variable" in value
  ) {
    return `<str>$${(value as { __variable: string }).__variable}`;
  }
  return String(value);
}

/**
 * Translate a parsed GraphQL query to EdgeQL.
 *
 * Query patterns:
 * - { user(id: "123") { name, email } }
 *   -> SELECT User { name, email } FILTER .id = <uuid>"123"
 *
 * - { allUsers(first: 10, offset: 0) { name } }
 *   -> SELECT User { name } LIMIT 10 OFFSET 0
 *
 * Mutation patterns:
 * - mutation { createUser(input: { name: "Alice" }) { id } }
 *   -> INSERT User { name := "Alice" }
 *
 * - mutation { updateUser(id: "123", input: { name: "Bob" }) { id } }
 *   -> UPDATE User FILTER .id = <uuid>"123" SET { name := "Bob" }
 *
 * - mutation { deleteUser(id: "123") }
 *   -> DELETE User FILTER .id = <uuid>"123"
 */
export function translateToEdgeQL(
  parsed: ParsedGraphQLQuery,
  schema: Schema,
): TranslationResult {
  const results: string[] = [];
  const variables: Record<string, unknown> = {};

  for (const selection of parsed.selections) {
    const typeName = resolveTypeName(selection.fieldName, schema);
    if (!typeName) {
      throw new Error(
        `Cannot resolve GraphQL field "${selection.fieldName}" to a Disc type`,
      );
    }

    if (parsed.type === "mutation") {
      results.push(
        translateMutation(selection, typeName, variables),
      );
    } else {
      results.push(
        translateQuery(selection, typeName, variables),
      );
    }
  }

  return { edgeql: results.join("; "), variables };
}

function translateQuery(
  selection: GraphQLSelection,
  typeName: string,
  variables: Record<string, unknown>,
): string {
  const shape = selection.subSelections
    ? ` {${buildShape(selection.subSelections)}}`
    : "";

  const args = selection.arguments;
  let filter = "";
  let limit = "";
  let offset = "";

  // Fetch-by-id: user(id: "abc")
  if (args.id !== undefined) {
    const idVal = formatEdgeQLValue(args.id);
    filter = ` FILTER .id = <uuid>${idVal}`;
  }

  // List query: allUsers(first: 10, offset: 5, filter: ".active = true")
  if (args.first !== undefined) {
    limit = ` LIMIT ${Number(args.first)}`;
  }
  if (args.offset !== undefined) {
    offset = ` OFFSET ${Number(args.offset)}`;
  }
  if (args.filter !== undefined && typeof args.filter === "string") {
    filter = ` FILTER ${args.filter}`;
  }

  // Merge external variables
  if (selection.arguments) {
    for (const [_key, value] of Object.entries(selection.arguments)) {
      if (
        typeof value === "object" && value !== null && "__variable" in value
      ) {
        variables[
          (value as { __variable: string }).__variable
        ] = undefined;
      }
    }
  }

  return `SELECT ${typeName}${shape}${filter}${limit}${offset}`;
}

function translateMutation(
  selection: GraphQLSelection,
  typeName: string,
  _variables: Record<string, unknown>,
): string {
  const fieldName = selection.fieldName;
  const args = selection.arguments;

  if (fieldName.startsWith("create")) {
    const input = args.input as Record<string, unknown> | undefined;
    if (!input) {
      throw new Error(`createMutation requires an 'input' argument`);
    }
    const assignments = Object.entries(input)
      .map(([k, v]) => `${k} := ${formatEdgeQLValue(v)}`)
      .join(", ");
    return `INSERT ${typeName} {${assignments}}`;
  }

  if (fieldName.startsWith("update")) {
    const id = args.id;
    const input = args.input as Record<string, unknown> | undefined;
    if (id === undefined) {
      throw new Error(`updateMutation requires an 'id' argument`);
    }
    if (!input) {
      throw new Error(`updateMutation requires an 'input' argument`);
    }
    const idVal = formatEdgeQLValue(id);
    const assignments = Object.entries(input)
      .map(([k, v]) => `${k} := ${formatEdgeQLValue(v)}`)
      .join(", ");
    return `UPDATE ${typeName} FILTER .id = <uuid>${idVal} SET {${assignments}}`;
  }

  if (fieldName.startsWith("delete")) {
    const id = args.id;
    if (id === undefined) {
      throw new Error(`deleteMutation requires an 'id' argument`);
    }
    const idVal = formatEdgeQLValue(id);
    return `DELETE ${typeName} FILTER .id = <uuid>${idVal}`;
  }

  throw new Error(`Unknown mutation: ${fieldName}`);
}
