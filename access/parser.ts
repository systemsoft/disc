/**
 * Access Policy Parser
 *
 * Parses access policy definitions from SDL and standalone policy files
 */

import { Token, TokenType } from "../schema/tokens.ts";
import { SyntaxError } from "../lib/errors.ts";
import { Span } from "../lib/types.ts";
import {
  AccessPolicyNode,
  AccessRuleNode,
  AccessOperationNode,
  AccessExpressionNode,
  AccessComparisonNode,
  createAccessPolicy,
  createAccessRule,
  createAccessOperation,
} from "./ast.ts";

export class AccessPolicyParser {
  private current = 0;
  private source: string;
  private tokens: Token[];

  constructor(tokens: Token[], source: string) {
    this.source = source;
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
      } else {
        throw new SyntaxError(
          `Unexpected token in access policy: ${this.peek().value}`,
          { location: this.getLocation(this.peek()) }
        );
      }
    }

    this.expect("}");

    const end = this.previous();

    const span: Span = {
      end: end.end,
      start: start.start
    };

    return createAccessPolicy(name, rules, {
      objectType,
      span,
      using,
      withCheck
    });
  }

  /**
   * Parse an access rule (allow/deny statement)
   */
  private parseAccessRule(action: "allow" | "deny"): AccessRuleNode {
    const start = this.previous();
    const operations: AccessOperationNode[] = [];

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
      end: end.end,
      start: start.start
    };

    return createAccessRule(action, operations, condition, span);
  }

  /**
   * Parse an access operation
   */
  private parseAccessOperation(): AccessOperationNode {
    const start = this.currentToken();
    const validOps = ["select", "insert", "update", "delete", "all"];
    const opToken = this.advance();

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
      end: end.end,
      start: start.start
    };

    return createAccessOperation(operation, columns, span);
  }

  /**
   * Parse an expression (used in conditions, using, with check)
   */
  private parseExpression(): AccessExpressionNode {
    return this.parseLogicalOr();
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

  private parseComparison(): AccessExpressionNode {
    const compOps = ["=", "!=", "<", ">", "<=", ">=", "in", "like", "ilike"];
    const op = this.peek().value;
    let left = this.parsePrimary();

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

    throw new SyntaxError(
      `Unexpected token in expression: ${token.value}`,
      { location: this.getLocation(token) }
    );
  }

  private parsePathOrFunction(): AccessExpressionNode {
    const path: string[] = [];
    // Handle leading dot for current object reference
    const isRelative = this.match(".");

    // Parse dotted path
    if (!isRelative || this.peek().type === TokenType.IDENT) {
      do {
        if (this.peek().type === TokenType.IDENT)
          path.push(this.expectIdentifier());
        else
          break;
      } while (this.match("."));
    }

    // If we have a relative path with no identifiers after the dot,
    // treat it as current object
    if (isRelative && path.length === 0)
      path.push("__self__");

    // Check for function call
    if (this.match("(")) {
      const name = isRelative ? "." + path.join(".") : path.join(".");
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

  // Utility methods
  private match(...types: string[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }

    return false;
  }

  private check(type: string): boolean {
    if (this.isAtEnd())
      return false;

    return this.peek().value === type || this.peek().type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd())
      this.current++;

    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.current >= this.tokens.length ||
           this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private currentToken(): Token {
    return this.tokens[this.current];
  }

  private expect(type: string): Token {
    if (this.check(type))
      return this.advance();

    throw new SyntaxError(
      `Expected '${type}' but got '${this.peek().value}'`,
      { location: this.getLocation(this.peek()) }
    );
  }

  private expectIdentifier(): string {
    const token = this.peek();

    if (token.type !== TokenType.IDENT) {
      throw new SyntaxError(
        `Expected identifier but got '${token.value}'`,
        { location: this.getLocation(token) }
      );
    }

    this.advance();
    return token.value;
  }

  private getLocation(token: Token) {
    return {
      column: token.column,
      file: undefined,
      line: token.line,
      offset: token.start
    };
  }
}
