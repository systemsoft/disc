/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Access Policy Parser
 *
 * Parses access policy definitions from SDL and standalone policy files
 */

/*** UTILITY ------------------------------------------ ***/

import { Span } from "../lib/types.ts";
import { SyntaxError } from "../lib/errors.ts";
import { Token, TokenType } from "../schema/tokens.ts";

import {
  AccessComparisonNode,
  AccessExpressionNode,
  AccessOperationNode,
  AccessPolicyNode,
  AccessRuleNode,
  createAccessOperation,
  createAccessPolicy,
  createAccessRule
} from "./ast.ts";

/*** EXPORT ------------------------------------------- ***/

export class AccessPolicyParser {
  private current = 0;
  private tokens: Token[];

  constructor(tokens: Token[], _source: string) {
    this.tokens = tokens;
  }

  /**
   * Parse an access policy definition
   */
  parseAccessPolicy(): AccessPolicyNode {
    const start = this.currentToken();

    // access policy <name>
    this.expect("access");
    this.expect("policy");

    const name = this.expectIdentifier();

    // Optional: for <type>
    let objectType: string | undefined;

    if (this.match("for"))
      objectType = this.expectIdentifier();

    this.expect("{");

    const rules: AccessRuleNode[] = [];
    let errmessage: string | undefined;
    let using: AccessExpressionNode | undefined;
    let withCheck: AccessExpressionNode | undefined;

    while (!this.check("}") && !this.isAtEnd()) {
      if (this.match("allow") || this.match("deny")) {
        const rule = this.parseAccessRule(this.previous().value === "allow" ? "allow" : "deny");
        rules.push(rule);
      } else if (this.match("using")) {
        this.expect("(");
        using = this.parseExpression();
        this.expect(")");
        this.expect(";");
      } else if (this.match("with")) {
        this.expect("check");
        this.expect("(");
        withCheck = this.parseExpression();
        this.expect(")");
        this.expect(";");
      } else if (this.match("errmessage")) {
        // `errmessage := 'custom denial reason';` (Gel #4095)
        this.expect(":=");
        errmessage = this.expectStringLiteral();
        this.expect(";");
      } else {
        throw new SyntaxError(`Unexpected token in access policy: ${this.peek().value}`, { location: this.getLocation(this.peek()) });
      }
    }

    this.expect("}");
    const end = this.previous();

    const span: Span = {
      end: { column: end.column, line: end.line, offset: end.offset },
      start: { column: start.column, line: start.line, offset: start.offset }
    };

    return createAccessPolicy(name, rules, {
      errmessage,
      objectType,
      span,
      using,
      withCheck
    });
  }

  /*** PRIVATE ------------------------------------------ ***/

  private advance(): Token {
    if (!this.isAtEnd())
      this.current++;

    return this.previous();
  }

  private check(type: string): boolean {
    if (this.isAtEnd())
      return false;

    return this.peek().value === type || this.peek().type === type;
  }

  private currentToken(): Token {
    return this.tokens[this.current];
  }

  private expect(type: string): Token {
    if (this.check(type))
      return this.advance();

    throw new SyntaxError(`Expected "${type}" but got "${this.peek().value}"`, { location: this.getLocation(this.peek()) });
  }

  private expectIdentifier(): string {
    const token = this.peek();

    if (token.type !== TokenType.IDENT)
      throw new SyntaxError(`Expected identifier but got "${token.value}"`, { location: this.getLocation(token) });

    this.advance();
    return token.value;
  }

  private expectStringLiteral(): string {
    const token = this.peek();

    if (token.type !== TokenType.STRING)
      throw new SyntaxError(`Expected string literal but got "${token.value}"`, { location: this.getLocation(token) });

    this.advance();
    return token.value;
  }

  private getLocation(token: Token) {
    return {
      column: token.column,
      file: undefined,
      line: token.line,
      offset: token.offset
    };
  }

  private isAtEnd(): boolean {
    return this.current >= this.tokens.length ||
      this.peek().type === TokenType.EOF;
  }

  private match(...types: string[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }

    return false;
  }

  /**
   * Parse an access operation
   */
  private parseAccessOperation(): AccessOperationNode {
    const opToken = this.advance();
    const start = this.currentToken();
    const validOps = ["select", "insert", "update", "delete", "all"];

    if (!validOps.includes(opToken.value)) {
      throw new SyntaxError(
        `Invalid access operation: ${opToken.value}. Must be one of: ${validOps.join(", ")}`,
        { location: this.getLocation(opToken) }
      );
    }

    const operation = opToken.value as AccessOperationNode["operation"];
    let columns: string[] | undefined;

    // Optional column list for update
    if (operation === "update" && this.match("(")) {
      columns = [];

      do {
        columns.push(this.expectIdentifier());
      } while (this.match(","));

      this.expect(")");
    }

    const end = this.previous();

    const span: Span = {
      end: { column: end.column, line: end.line, offset: end.offset },
      start: { column: start.column, line: start.line, offset: start.offset }
    };

    return createAccessOperation(operation, columns, span);
  }

  /**
   * Parse an access rule (allow/deny statement)
   */
  private parseAccessRule(action: "allow" | "deny"): AccessRuleNode {
    const operations: AccessOperationNode[] = [];
    const start = this.previous();

    // Parse operations list
    do {
      const op = this.parseAccessOperation();
      operations.push(op);
    } while (this.match(","));

    // Optional condition
    let condition: AccessExpressionNode | undefined;

    if (this.match("when"))
      condition = this.parseExpression();

    this.expect(";");
    const end = this.previous();

    const span: Span = {
      end: { column: end.column, line: end.line, offset: end.offset },
      start: { column: start.column, line: start.line, offset: start.offset }
    };

    return createAccessRule(action, operations, condition, span);
  }

  private parseComparison(): AccessExpressionNode {
    const compOps = ["=", "!=", "<", ">", "<=", ">=", "in", "like", "ilike"];
    const left = this.parsePrimary();
    const op = this.peek().value;

    if (compOps.includes(op)) {
      this.advance();
      const right = this.parsePrimary();

      return {
        kind: "AccessComparison",
        left,
        operator: op as AccessComparisonNode["operator"],
        right
      };
    }

    // Handle "not in"
    if (this.match("not") && this.match("in")) {
      const right = this.parsePrimary();

      return {
        kind: "AccessComparison",
        left,
        operator: "not in",
        right
      };
    }

    return left;
  }

  /**
   * Parse an expression (used in conditions, using, with check)
   */
  private parseExpression(): AccessExpressionNode {
    return this.parseLogicalOr();
  }

  private parseLogicalAnd(): AccessExpressionNode {
    let left = this.parseLogicalNot();

    while (this.match("and")) {
      const operator = "and";
      const right = this.parseLogicalNot();

      left = {
        kind: "AccessLogical",
        operands: [left, right],
        operator
      };
    }

    return left;
  }

  private parseLogicalNot(): AccessExpressionNode {
    if (this.match("not")) {
      const operand = this.parseLogicalNot();

      return {
        kind: "AccessLogical",
        operands: [operand],
        operator: "not"
      };
    }

    return this.parseComparison();
  }

  private parseLogicalOr(): AccessExpressionNode {
    let left = this.parseLogicalAnd();

    while (this.match("or")) {
      const operator = "or";
      const right = this.parseLogicalAnd();

      left = {
        kind: "AccessLogical",
        operands: [left, right],
        operator
      };
    }

    return left;
  }

  private parsePathOrFunction(): AccessExpressionNode {
    const path: string[] = [];
    /**
     * Tracks the separator that joins each pair of path segments:
     * "." for property access, "::" for module-qualified names like
     * `runtime::has_permission`. We only emit `::`-separated names for
     * function-call targets; mixing the two stays valid because we
     * reconstruct the qualified name from `separators` when assembling
     * the function-call AST.
     */
    const separators: string[] = [];
    // Handle leading dot for current object reference
    const isRelative = this.match(".");

    // Parse dotted/double-colon path
    if (!isRelative || this.peek().type === TokenType.IDENT) {
      /*** First identifier (or break if there isn’t one — covered by the relative-path edge
           case below). ***/
      if (this.peek().type === TokenType.IDENT)
        path.push(this.expectIdentifier());

      /*** Subsequent segments — accept either separator. `runtime::has_permission` tokenizes as
           IDENT DOUBLECOLON IDENT, so we keep consuming pairs until the next token isn’t a
           recognized separator. ***/
      while (true) {
        let sep: string | null = null;

        if (this.match("."))
          sep = ".";
        else if (this.match("::"))
          sep = "::";
        else
          break;

        if (this.peek().type !== TokenType.IDENT) {
          /*** Trailing separator — bail out so existing relative-path semantics (a bare leading dot)
               still fire. ***/
          break;
        }

        path.push(this.expectIdentifier());
        separators.push(sep);
      }
    }

    /*** If we have a relative path with no identifiers after the dot, treat it as current object ***/
    if (isRelative && path.length === 0)
      path.push("__self__");

    // Check for function call
    if (this.match("(")) {
      /*** Reconstruct the full qualified name preserving the separator between each pair of
           segments — `runtime::has_permission`, `mod::nested::fn`, or plain `has_role`. ***/
      const joined = path.reduce((acc, seg, i) => {
        if (i === 0)
          return seg;

        return acc + separators[i - 1] + seg;
      }, "");

      const name = isRelative ? "." + joined : joined;
      const args: AccessExpressionNode[] = [];

      if (!this.check(")")) {
        do {
          args.push(this.parseExpression());
        } while (this.match(","));
      }

      this.expect(")");

      return {
        args,
        kind: "AccessFunction",
        name
      };
    }

    // Just a path
    if (isRelative)
      path.unshift(".");

    return {
      kind: "AccessPath",
      path
    };
  }

  private parsePrimary(): AccessExpressionNode {
    // Literals
    if (this.match("true") || this.match("false")) {
      return {
        kind: "AccessLiteral",
        type: "boolean",
        value: this.previous().value === "true"
      };
    }

    if (this.match("null")) {
      return {
        kind: "AccessLiteral",
        type: "null",
        value: null
      };
    }

    const token = this.peek();

    // String literal
    if (token.type === TokenType.STRING) {
      this.advance();

      return {
        kind: "AccessLiteral",
        type: "string",
        value: token.value
      };
    }

    // Number literal
    if (token.type === TokenType.INTEGER || token.type === TokenType.FLOAT) {
      this.advance();

      return {
        kind: "AccessLiteral",
        type: "number",
        value: parseFloat(token.value)
      };
    }

    // Array literal
    if (this.match("[")) {
      const elements: AccessExpressionNode[] = [];

      if (!this.check("]")) {
        do {
          elements.push(this.parseExpression());
        } while (this.match(","));
      }

      this.expect("]");

      // Return array as a special literal type
      return {
        kind: "AccessLiteral",
        type: "array" as any,
        value: elements
      };
    }

    // Parenthesized expression
    if (this.match("(")) {
      const expr = this.parseExpression();
      this.expect(")");

      return expr;
    }

    // Global variables (current_user, current_role, etc.)
    if (this.match("current_user") || this.match("current_role") || this.match("current_session")) {
      const globalName = this.previous().value;

      // Check if accessing properties of the global
      if (this.match(".")) {
        const path = [globalName];

        do {
          path.push(this.expectIdentifier());
        } while (this.match("."));

        return {
          kind: "AccessPath",
          path
        };
      }

      return {
        kind: "AccessGlobal",
        name: globalName
      };
    }

    // Path or function call (can start with . or identifier)
    if (token.type === TokenType.IDENT || token.value === ".")
      return this.parsePathOrFunction();

    throw new SyntaxError(`Unexpected token in expression: ${token.value}`, { location: this.getLocation(token) });
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }
}
