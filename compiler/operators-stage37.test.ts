/**
 * Stage 37: Operators — Bitwise, Regex & EXPLAIN
 *
 * Phase 1: Bitwise operators: & (AND), | (OR), ^ (XOR), << (LSHIFT), >> (RSHIFT), ~ (BITNOT)
 * Phase 2: Regex operators: ~ (match), !~ (not match), ~* (imatch), !~* (not imatch)
 * Phase 3: EXPLAIN queries
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { assertThrows } from "@std/assert/throws";
import { EdgeQLLexer } from "../edgeql/lexer.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { TokenType } from "../edgeql/tokens.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }

  return codegen.generate(result.value);
}

function tokenize(source: string): { type: TokenType; value: string }[] {
  const lexer = new EdgeQLLexer(source);
  return lexer.tokenize().map((t) => ({ type: t.type, value: t.value }));
}

// ===========================================================================
// PHASE 1: Bitwise Operators — Lexer
// ===========================================================================

Deno.test("Bitwise lexer — & tokenizes as AMPERSAND", () => {
  const tokens = tokenize("a & b");
  const ampToken = tokens.find((t) => t.type === TokenType.AMPERSAND);
  assertEquals(ampToken?.value, "&");
});

Deno.test("Bitwise lexer — && still tokenizes as RANGE_OVERLAPS", () => {
  const tokens = tokenize("a && b");
  const overlapToken = tokens.find((t) => t.type === TokenType.RANGE_OVERLAPS);
  assertEquals(overlapToken?.value, "&&");
});

Deno.test("Bitwise lexer — | tokenizes as PIPE", () => {
  const tokens = tokenize("a | b");
  const pipeToken = tokens.find((t) => t.type === TokenType.PIPE);
  assertEquals(pipeToken?.value, "|");
});

Deno.test("Bitwise lexer — ^ tokenizes as CARET", () => {
  const tokens = tokenize("a ^ b");
  const caretToken = tokens.find((t) => t.type === TokenType.CARET);
  assertEquals(caretToken?.value, "^");
});

Deno.test("Bitwise lexer — << tokenizes as LSHIFT", () => {
  const tokens = tokenize("a << b");
  const lshiftToken = tokens.find((t) => t.type === TokenType.LSHIFT);
  assertEquals(lshiftToken?.value, "<<");
});

Deno.test("Bitwise lexer — >> tokenizes as RSHIFT", () => {
  const tokens = tokenize("a >> b");
  const rshiftToken = tokens.find((t) => t.type === TokenType.RSHIFT);
  assertEquals(rshiftToken?.value, ">>");
});

Deno.test("Bitwise lexer — ~ tokenizes as TILDE", () => {
  const tokens = tokenize("~a");
  const tildeToken = tokens.find((t) => t.type === TokenType.TILDE);
  assertEquals(tildeToken?.value, "~");
});

// ===========================================================================
// PHASE 1: Bitwise Operators — Compilation
// ===========================================================================

Deno.test("Bitwise — a & b compiles to &", () => {
  const sql = compileEdgeQL("SELECT 255 & 15");
  assertStringIncludes(sql, "&");
  assertStringIncludes(sql, "255");
  assertStringIncludes(sql, "15");
});

Deno.test("Bitwise — a | b compiles to |", () => {
  const sql = compileEdgeQL("SELECT 12 | 10");
  assertStringIncludes(sql, "|");
  assertStringIncludes(sql, "12");
  assertStringIncludes(sql, "10");
});

Deno.test("Bitwise — a ^ b compiles to # (PG XOR)", () => {
  const sql = compileEdgeQL("SELECT 5 ^ 3");
  assertStringIncludes(sql, "#");
  assertStringIncludes(sql, "5");
  assertStringIncludes(sql, "3");
});

Deno.test("Bitwise — a << b compiles to <<", () => {
  const sql = compileEdgeQL("SELECT 1 << 4");
  assertStringIncludes(sql, "<<");
  assertStringIncludes(sql, "1");
  assertStringIncludes(sql, "4");
});

Deno.test("Bitwise — a >> b compiles to >>", () => {
  const sql = compileEdgeQL("SELECT 16 >> 2");
  assertStringIncludes(sql, ">>");
  assertStringIncludes(sql, "16");
  assertStringIncludes(sql, "2");
});

Deno.test("Bitwise — ~a compiles to unary ~", () => {
  const sql = compileEdgeQL("SELECT ~42");
  assertStringIncludes(sql, "~");
  assertStringIncludes(sql, "42");
});

Deno.test("Bitwise — nested: (a & b) | c", () => {
  const sql = compileEdgeQL("SELECT 7 & 3 | 8");
  assertStringIncludes(sql, "&");
  assertStringIncludes(sql, "|");
});

Deno.test("Bitwise — precedence: bitwise lower than arithmetic", () => {
  // a + b & c should parse as (a + b) & c
  const parser = new EdgeQLParser("SELECT 1 + 2 & 3");
  const ast = parser.parse();
  // The top-level expression should be & with left = (1+2) and right = 3
  const selectExpr = ast as { expr: { kind: string; op: string } };
  assertEquals(selectExpr.expr.kind, "BinaryOp");
  assertEquals(selectExpr.expr.op, "&");
});

// ===========================================================================
// PHASE 2: Regex Operators — Lexer
// ===========================================================================

Deno.test("Regex lexer — !~ tokenizes as REGEX_NOT_MATCH", () => {
  const tokens = tokenize("a !~ b");
  const token = tokens.find((t) => t.type === TokenType.REGEX_NOT_MATCH);
  assertEquals(token?.value, "!~");
});

Deno.test("Regex lexer — ~* tokenizes as REGEX_IMATCH", () => {
  const tokens = tokenize("a ~* b");
  const token = tokens.find((t) => t.type === TokenType.REGEX_IMATCH);
  assertEquals(token?.value, "~*");
});

Deno.test("Regex lexer — !~* tokenizes as REGEX_NOT_IMATCH", () => {
  const tokens = tokenize("a !~* b");
  const token = tokens.find((t) => t.type === TokenType.REGEX_NOT_IMATCH);
  assertEquals(token?.value, "!~*");
});

// ===========================================================================
// PHASE 2: Regex Operators — Compilation
// ===========================================================================

Deno.test("Regex — str ~ pattern compiles to ~", () => {
  const sql = compileEdgeQL(`SELECT 'hello' ~ 'hel'`);
  assertStringIncludes(sql, "~");
  assertStringIncludes(sql, "'hello'");
  assertStringIncludes(sql, "'hel'");
});

Deno.test("Regex — str !~ pattern compiles to !~", () => {
  const sql = compileEdgeQL(`SELECT 'hello' !~ 'xyz'`);
  assertStringIncludes(sql, "!~");
});

Deno.test("Regex — str ~* pattern compiles to ~*", () => {
  const sql = compileEdgeQL(`SELECT 'Hello' ~* 'hello'`);
  assertStringIncludes(sql, "~*");
});

Deno.test("Regex — str !~* pattern compiles to !~*", () => {
  const sql = compileEdgeQL(`SELECT 'Hello' !~* 'xyz'`);
  assertStringIncludes(sql, "!~*");
});

// ===========================================================================
// PHASE 2: Regex vs Bitwise NOT — disambiguation
// ===========================================================================

Deno.test("Regex vs Bitwise — ~a is unary bitwise NOT", () => {
  const parser = new EdgeQLParser("SELECT ~42");
  const ast = parser.parse();
  const selectExpr = ast as { expr: { kind: string; op: string } };
  assertEquals(selectExpr.expr.kind, "UnaryOp");
  assertEquals(selectExpr.expr.op, "~");
});

Deno.test("Regex vs Bitwise — a ~ b is binary regex match", () => {
  const parser = new EdgeQLParser(`SELECT 'hello' ~ 'h.*o'`);
  const ast = parser.parse();
  const selectExpr = ast as { expr: { kind: string; op: string } };
  assertEquals(selectExpr.expr.kind, "BinaryOp");
  assertEquals(selectExpr.expr.op, "~");
});

// ===========================================================================
// PHASE 3: EXPLAIN — Parsing
// ===========================================================================

Deno.test("EXPLAIN — basic EXPLAIN SELECT parses", () => {
  const parser = new EdgeQLParser("EXPLAIN SELECT User { name }");
  const ast = parser.parse();
  assertEquals(ast.kind, "ExplainQuery");
  const explain = ast as { analyze?: boolean; buffers?: boolean; query: { kind: string } };
  assertEquals(explain.analyze, false);
  assertEquals(explain.buffers, false);
  assertEquals(explain.query.kind, "SelectQuery");
});

Deno.test("EXPLAIN — EXPLAIN ANALYZE parses", () => {
  const parser = new EdgeQLParser("EXPLAIN ANALYZE SELECT User { name }");
  const ast = parser.parse();
  assertEquals(ast.kind, "ExplainQuery");
  const explain = ast as { analyze?: boolean };
  assertEquals(explain.analyze, true);
});

Deno.test("EXPLAIN — EXPLAIN ANALYZE BUFFERS parses", () => {
  const parser = new EdgeQLParser(
    "EXPLAIN ANALYZE BUFFERS SELECT User { name }",
  );
  const ast = parser.parse();
  assertEquals(ast.kind, "ExplainQuery");
  const explain = ast as { analyze?: boolean; buffers?: boolean };
  assertEquals(explain.analyze, true);
  assertEquals(explain.buffers, true);
});

// ===========================================================================
// PHASE 3: EXPLAIN — Compilation
// ===========================================================================

Deno.test("EXPLAIN — compiles to EXPLAIN (FORMAT JSON) SQL", () => {
  const sql = compileEdgeQL("EXPLAIN SELECT User { name }");
  assertStringIncludes(sql, "EXPLAIN");
  assertStringIncludes(sql, "FORMAT JSON");
});

Deno.test("EXPLAIN ANALYZE — includes ANALYZE in options", () => {
  const sql = compileEdgeQL("EXPLAIN ANALYZE SELECT User { name }");
  assertStringIncludes(sql, "EXPLAIN");
  assertStringIncludes(sql, "ANALYZE");
  assertStringIncludes(sql, "FORMAT JSON");
});

Deno.test("EXPLAIN ANALYZE BUFFERS — includes both options", () => {
  const sql = compileEdgeQL(
    "EXPLAIN ANALYZE BUFFERS SELECT User { name }",
  );
  assertStringIncludes(sql, "EXPLAIN");
  assertStringIncludes(sql, "ANALYZE");
  assertStringIncludes(sql, "BUFFERS");
  assertStringIncludes(sql, "FORMAT JSON");
});

Deno.test("EXPLAIN — wraps inner SELECT query correctly", () => {
  const sql = compileEdgeQL("EXPLAIN SELECT User { name }");
  // Should contain the EXPLAIN prefix and inner SELECT statement
  assertStringIncludes(sql, "EXPLAIN (FORMAT JSON)");
  assertStringIncludes(sql, "users");
});
