/**
 * Translates GraphQL queries to EdgeQL queries.
 *
 * Implements a simplified recursive descent parser for the GraphQL
 * query language subset needed by Disc. Handles queries, mutations,
 * arguments, nested selections, aliases, fragments (named + inline),
 * directives (`@skip` / `@include`), and the `__typename` /
 * `__schema` / `__type` introspection fields. Subscriptions remain
 * out of scope.
 */

import type { Schema } from "../compiler/context.ts";

// ── Parsed structures ─────────────────────────────────────────────────

export interface ParsedGraphQLQuery {
  type: "query" | "mutation";
  operationName?: string;
  selections: GraphQLSelection[];
  variables?: Record<string, unknown>;
  /**
   * Named fragment definitions declared at the top level of the
   * document, keyed by fragment name. Spreads (`...Name`) reference
   * these. Populated by the parser; consumed by `inlineFragments`.
   */
  fragments?: Record<string, GraphQLFragmentDefinition>;
}

export interface GraphQLDirective {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GraphQLFragmentDefinition {
  name: string;
  typeCondition: string;
  selections: GraphQLSelection[];
  directives?: GraphQLDirective[];
}

/**
 * A node in the parsed selection set. Plain field selections set
 * `fieldName` and (optionally) `subSelections`. Fragment-spread nodes
 * set `kind: "FragmentSpread"` plus `fragmentName`. Inline-fragment
 * nodes set `kind: "InlineFragment"` plus `typeCondition` and the
 * inlined `subSelections`. After `inlineFragments()` runs, only
 * `kind: "Field"` nodes remain in `ParsedGraphQLQuery.selections`.
 */
export interface GraphQLSelection {
  kind?: "Field" | "FragmentSpread" | "InlineFragment";
  alias?: string;
  arguments: Record<string, unknown>;
  fieldName: string;
  subSelections?: GraphQLSelection[];
  directives?: GraphQLDirective[];
  /** Set when kind === "FragmentSpread". */
  fragmentName?: string;
  /** Set when kind === "InlineFragment". */
  typeCondition?: string;
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
 * - Directives on fields: name @skip(if: true), name @include(if: $v)
 * - Fragment spreads: ...UserFields
 * - Inline fragments: ... on User { name }
 * - Fragment definitions at document level: fragment X on Y { ... }
 * - Introspection meta-fields: __typename, __schema, __type
 *
 * The parser returns the raw selection tree; call `inlineFragments`
 * (or use `parseGraphQLQuery` which does it inline) to expand spreads
 * and inline fragments before translation.
 */
export function parseGraphQLQuery(query: string): ParsedGraphQLQuery {
  const parser = new GraphQLParser(query);
  const parsed = parser.parse();
  return inlineFragments(parsed);
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
    let selections: GraphQLSelection[] = [];
    const fragments: Record<string, GraphQLFragmentDefinition> = {};

    // Lead with fragment definitions if the document opens with one;
    // GraphQL allows fragments before the operation as well as after.
    while (this.lookAhead("fragment")) {
      const frag = this.parseFragmentDefinition();
      fragments[frag.name] = frag;
      this.skipWhitespace();
    }

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

    // A document with only fragments and no operation is allowed —
    // bare fragments compile but only matter when an operation
    // references them. Treat that as an empty query.
    if (this.peek() === "{") {
      selections = this.parseSelectionSet();
      this.skipWhitespace();
    }

    // Trailing fragment definitions
    while (this.lookAhead("fragment")) {
      const frag = this.parseFragmentDefinition();
      fragments[frag.name] = frag;
      this.skipWhitespace();
    }

    return {
      operationName,
      selections,
      type,
      fragments: Object.keys(fragments).length > 0 ? fragments : undefined
    };
  }

  /**
   * Parse `fragment Name on TypeName <directives?> { selections }`.
   */
  private parseFragmentDefinition(): GraphQLFragmentDefinition {
    this.consume("fragment");
    this.skipWhitespace();
    const name = this.readName();
    this.skipWhitespace();
    if (!this.lookAhead("on")) {
      throw new Error(
        `GraphQL parse error: expected 'on' after fragment name '${name}'`
      );
    }
    this.consume("on");
    this.skipWhitespace();
    const typeCondition = this.readName();
    this.skipWhitespace();
    const directives = this.parseDirectives();
    this.skipWhitespace();
    const selections = this.parseSelectionSet();
    return {
      name,
      typeCondition,
      selections,
      directives: directives.length > 0 ? directives : undefined
    };
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

    // Spread (`...`) — fragment spread or inline fragment.
    if (
      this.peek() === "." &&
      this.input[this.pos + 1] === "." &&
      this.input[this.pos + 2] === "."
    ) {
      this.pos += 3;
      this.skipWhitespace();

      // Inline fragment: `... on Type { selections }` (or no type
      // condition: `... { selections }`).
      if (this.lookAhead("on") || this.peek() === "{") {
        let typeCondition: string | undefined;
        if (this.lookAhead("on")) {
          this.consume("on");
          this.skipWhitespace();
          typeCondition = this.readName();
          this.skipWhitespace();
        }
        const directives = this.parseDirectives();
        this.skipWhitespace();
        const subSelections = this.parseSelectionSet();
        return {
          kind: "InlineFragment",
          alias: undefined,
          arguments: {},
          fieldName: typeCondition ?? "<inline>",
          subSelections,
          directives: directives.length > 0 ? directives : undefined,
          typeCondition
        };
      }

      // Fragment spread: `...FragmentName`
      const fragmentName = this.readName();
      this.skipWhitespace();
      const directives = this.parseDirectives();
      return {
        kind: "FragmentSpread",
        alias: undefined,
        arguments: {},
        fieldName: fragmentName,
        directives: directives.length > 0 ? directives : undefined,
        fragmentName
      };
    }

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

    // Parse directives (zero or more `@name(args?)`).
    const directives = this.parseDirectives();
    this.skipWhitespace();

    // Parse sub-selections
    let subSelections: GraphQLSelection[] | undefined;
    if (this.peek() === "{") {
      subSelections = this.parseSelectionSet();
      this.skipWhitespace();
    }

    return {
      kind: "Field",
      alias,
      arguments: args,
      fieldName,
      subSelections,
      directives: directives.length > 0 ? directives : undefined
    };
  }

  /**
   * Parse zero-or-more directives `@name(args?)`. Returns [] when no
   * `@` follows. The caller is responsible for context-appropriate
   * placement (after field name+args, after fragment definition, etc.).
   */
  private parseDirectives(): GraphQLDirective[] {
    const out: GraphQLDirective[] = [];
    this.skipWhitespace();
    while (this.peek() === "@") {
      this.pos++; // consume '@'
      const name = this.readName();
      let args: Record<string, unknown> = {};
      this.skipWhitespace();
      if (this.peek() === "(") {
        args = this.parseArguments();
      }
      out.push({ name, arguments: args });
      this.skipWhitespace();
    }
    return out;
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
    if (ch === "\"") {
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
    if (word === "true")
      return true;
    if (word === "false")
      return false;
    if (word === "null")
      return null;

    // Try to parse as number
    const num = Number(word);
    if (!isNaN(num))
      return num;

    // Enum value
    return word;
  }

  private parseString(): string {
    this.expect("\"");
    let result = "";
    while (this.pos < this.input.length && this.peek() !== "\"") {
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
          case "\"":
            result += "\"";
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
    this.expect("\"");
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
      if (ch === "(")
        depth++;
      else if (ch === ")")
        depth--;
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
        `GraphQL parse error: expected '${ch}' at position ${this.pos}, got '${this.input[this.pos] ?? "EOF"}'`
      );
    }
    this.pos++;
  }

  private consume(word: string): void {
    for (let i = 0; i < word.length; i++) {
      if (this.input[this.pos + i] !== word[i]) {
        throw new Error(
          `GraphQL parse error: expected '${word}' at position ${this.pos}`
        );
      }
    }
    this.pos += word.length;
  }

  private lookAhead(word: string): boolean {
    for (let i = 0; i < word.length; i++) {
      if (this.input[this.pos + i] !== word[i])
        return false;
    }
    // Ensure the word ends at a boundary (not part of a longer name)
    const nextChar = this.input[this.pos + word.length];
    if (nextChar && /[a-zA-Z0-9_]/.test(nextChar))
      return false;
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
        `GraphQL parse error: expected name at position ${this.pos}, got '${this.input[this.pos] ?? "EOF"}'`
      );
    }
    return this.input.slice(start, this.pos);
  }
}

// ── Fragment / directive resolution ───────────────────────────────────

/**
 * Walk the parsed query and replace each fragment-spread node with
 * the inlined selections from its definition; expand inline fragments
 * the same way. After this runs, every selection in the tree has
 * `kind: "Field"` (or undefined, for legacy callers that didn't set
 * the field). Cycles are detected and rejected with a clear error so
 * the parser doesn't recurse forever.
 *
 * Also drops selections whose `@skip(if: true)` or
 * `@include(if: false)` directives evaluate to a literal boolean.
 * Variable-ref directives are left in the tree — runtime will filter
 * after the variable is bound.
 */
export function inlineFragments(
  parsed: ParsedGraphQLQuery
): ParsedGraphQLQuery {
  const fragments = parsed.fragments ?? {};
  const seen = new Set<string>();

  function expand(selections: GraphQLSelection[]): GraphQLSelection[] {
    const out: GraphQLSelection[] = [];
    for (const sel of selections) {
      if (!directivePermits(sel))
        continue;

      if (sel.kind === "FragmentSpread" && sel.fragmentName) {
        const def = fragments[sel.fragmentName];
        if (!def) {
          throw new Error(
            `Unknown fragment '${sel.fragmentName}'`
          );
        }
        if (seen.has(sel.fragmentName)) {
          throw new Error(
            `Cycle in fragment spreads at '${sel.fragmentName}'`
          );
        }
        seen.add(sel.fragmentName);
        out.push(...expand(def.selections));
        seen.delete(sel.fragmentName);
        continue;
      }

      if (sel.kind === "InlineFragment" && sel.subSelections) {
        out.push(...expand(sel.subSelections));
        continue;
      }

      // Plain field: recurse into subSelections so nested fragments
      // and nested directives are resolved too.
      const next: GraphQLSelection = { ...sel, kind: "Field" };
      if (sel.subSelections) {
        next.subSelections = expand(sel.subSelections);
      }
      out.push(next);
    }
    return out;
  }

  return { ...parsed, selections: expand(parsed.selections) };
}

/**
 * Resolve `@skip(if: …)` / `@include(if: …)` to a single boolean.
 * Returns `true` (keep) when no decision can be made (e.g. the `if`
 * argument is a variable reference) — runtime filtering is deferred.
 */
function directivePermits(sel: GraphQLSelection): boolean {
  if (!sel.directives || sel.directives.length === 0)
    return true;
  for (const dir of sel.directives) {
    const ifVal = dir.arguments.if;
    // Variable-ref → defer to runtime, keep the field.
    if (typeof ifVal === "object" && ifVal !== null && "__variable" in ifVal) {
      continue;
    }
    if (dir.name === "skip" && ifVal === true)
      return false;
    if (dir.name === "include" && ifVal === false)
      return false;
  }
  return true;
}

// ── Introspection resolver ────────────────────────────────────────────

/**
 * Returns true if the parsed query's top-level selection is an
 * introspection meta-field (`__schema` / `__type`). Plain
 * `__typename` at the operation root is NOT introspection — it just
 * returns the operation type name and follows the regular query path.
 */
export function isIntrospectionQuery(parsed: ParsedGraphQLQuery): boolean {
  return parsed.selections.some(
    sel => sel.fieldName === "__schema" || sel.fieldName === "__type"
  );
}

/**
 * Resolve the introspection portion of a parsed GraphQL query against
 * the Disc schema. Returns the `data` payload that goes back to the
 * client — fields not requested are omitted, matching the GraphQL
 * spec. The implementation is intentionally minimal: it covers the
 * fields tools (codegen, GraphiQL, Apollo Studio) actually request to
 * render schema browsers, and stops short of the full introspection
 * spec (deprecation reasons, directive metadata, enum value details).
 */
export function resolveIntrospection(
  parsed: ParsedGraphQLQuery,
  schema: Schema
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const sel of parsed.selections) {
    if (sel.fieldName === "__schema") {
      data[sel.alias ?? "__schema"] = resolveSchemaIntrospection(sel, schema);
    } else if (sel.fieldName === "__type") {
      const nameArg = sel.arguments.name;
      const typeName = typeof nameArg === "string" ? nameArg : null;
      data[sel.alias ?? "__type"] = typeName ? resolveTypeIntrospection(sel, schema, typeName) : null;
    } else if (sel.fieldName === "__typename") {
      // Operation-level __typename returns "Query" or "Mutation".
      data[sel.alias ?? "__typename"] = parsed.type === "mutation" ? "Mutation" : "Query";
    }
  }

  return data;
}

function resolveSchemaIntrospection(
  selection: GraphQLSelection,
  schema: Schema
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const sub of selection.subSelections ?? []) {
    if (sub.fieldName === "types") {
      const out: unknown[] = [];
      for (const [, def] of schema.types) {
        out.push(introspectionTypeShape(sub, def));
      }
      result[sub.alias ?? "types"] = out;
    } else if (sub.fieldName === "queryType") {
      result[sub.alias ?? "queryType"] = { name: "Query" };
    } else if (sub.fieldName === "mutationType") {
      result[sub.alias ?? "mutationType"] = { name: "Mutation" };
    } else if (sub.fieldName === "directives") {
      // Disc supports the two GraphQL spec directives.
      result[sub.alias ?? "directives"] = [
        { name: "skip", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"] },
        { name: "include", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"] }
      ];
    }
  }
  return result;
}

function resolveTypeIntrospection(
  selection: GraphQLSelection,
  schema: Schema,
  typeName: string
): Record<string, unknown> | null {
  // Tolerate qualified ("module::Type") and unqualified ("Type") names.
  let def: { name: string; properties: Map<string, unknown>; links?: Map<string, unknown>; } | undefined;
  for (const [name, candidate] of schema.types) {
    const short = name.includes("::") ? name.split("::").pop()! : name;
    if (name === typeName || short === typeName) {
      def = candidate as typeof def;
      break;
    }
  }
  if (!def)
    return null;
  return introspectionTypeShape(selection, def);
}

function introspectionTypeShape(
  selection: GraphQLSelection,
  def: { name: string; properties: Map<string, unknown>; links?: Map<string, unknown>; }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sub of selection.subSelections ?? []) {
    if (sub.fieldName === "name") {
      const short = def.name.includes("::") ? def.name.split("::").pop()! : def.name;
      out[sub.alias ?? "name"] = short;
    } else if (sub.fieldName === "kind") {
      out[sub.alias ?? "kind"] = "OBJECT";
    } else if (sub.fieldName === "fields") {
      const fields: unknown[] = [];
      for (const [propName] of def.properties) {
        fields.push({ name: propName });
      }
      for (const [linkName] of def.links ?? new Map()) {
        fields.push({ name: linkName });
      }
      out[sub.alias ?? "fields"] = fields;
    }
  }
  return out;
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
  schema: Schema
): string | undefined {
  // Direct PascalCase match
  const pascal = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

  // Try direct match first
  for (const [name] of schema.types) {
    const shortName = name.includes("::") ? name.split("::").pop()! : name;
    if (shortName === pascal)
      return shortName;
  }

  // "allUsers" -> "User" (strip "all" prefix and trailing "s")
  if (fieldName.startsWith("all") && fieldName.endsWith("s")) {
    const candidate = fieldName.slice(3, -1);
    for (const [name] of schema.types) {
      const shortName = name.includes("::") ? name.split("::").pop()! : name;
      if (shortName === candidate)
        return shortName;
    }
  }

  // "createUser", "updateUser", "deleteUser"
  for (const prefix of ["create", "update", "delete"]) {
    if (fieldName.startsWith(prefix)) {
      const candidate = fieldName.slice(prefix.length);
      for (const [name] of schema.types) {
        const shortName = name.includes("::") ? name.split("::").pop()! : name;
        if (shortName === candidate)
          return shortName;
      }
    }
  }

  return undefined;
}

/**
 * Build the EdgeQL shape string from a list of GraphQL selections.
 * `__typename` is the spec'd introspection field that returns the
 * parent type's name — it's synthesized post-execution from the
 * resolved type rather than being a real column, so it's dropped
 * from the EdgeQL shape entirely.
 */
function buildShape(selections: GraphQLSelection[]): string {
  const parts: string[] = [];
  for (const sel of selections) {
    if (sel.fieldName === "__typename")
      continue;
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
  if (typeof value === "string")
    return `"${value}"`;
  if (typeof value === "number")
    return String(value);
  if (typeof value === "boolean")
    return String(value);
  if (value === null)
    return "{}";
  if (
    typeof value === "object" && value !== null && "__variable" in value
  ) {
    return `<str>$${(value as { __variable: string; }).__variable}`;
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
 * - mutation { createUser(input: { name: "Ada" }) { id } }
 *   -> INSERT User { name := "Ada" }
 *
 * - mutation { updateUser(id: "123", input: { name: "Billie" }) { id } }
 *   -> UPDATE User FILTER .id = <uuid>"123" SET { name := "Billie" }
 *
 * - mutation { deleteUser(id: "123") }
 *   -> DELETE User FILTER .id = <uuid>"123"
 */
export function translateToEdgeQL(
  parsed: ParsedGraphQLQuery,
  schema: Schema
): TranslationResult {
  const results: string[] = [];
  const variables: Record<string, unknown> = {};

  for (const selection of parsed.selections) {
    const typeName = resolveTypeName(selection.fieldName, schema);
    if (!typeName) {
      throw new Error(
        `Cannot resolve GraphQL field "${selection.fieldName}" to a Disc type`
      );
    }

    if (parsed.type === "mutation") {
      results.push(
        translateMutation(selection, typeName, variables)
      );
    } else {
      results.push(
        translateQuery(selection, typeName, variables)
      );
    }
  }

  return { edgeql: results.join("; "), variables };
}

function translateQuery(
  selection: GraphQLSelection,
  typeName: string,
  variables: Record<string, unknown>
): string {
  const shape = selection.subSelections ? ` {${buildShape(selection.subSelections)}}` : "";

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
          (value as { __variable: string; }).__variable
        ] = undefined;
      }
    }
  }

  return `SELECT ${typeName}${shape}${filter}${limit}${offset}`;
}

function translateMutation(
  selection: GraphQLSelection,
  typeName: string,
  _variables: Record<string, unknown>
): string {
  const fieldName = selection.fieldName;
  const args = selection.arguments;

  if (fieldName.startsWith("create")) {
    const input = args.input as Record<string, unknown> | undefined;
    if (!input) {
      throw new Error(`createMutation requires an 'input' argument`);
    }
    const assignments = Object
      .entries(input)
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
    const assignments = Object
      .entries(input)
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
