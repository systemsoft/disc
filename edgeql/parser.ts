/**
 * EdgeQL Parser - Parses EdgeQL tokens into AST
 */

import { SyntaxError } from "../lib/errors.ts";
import { Token, TokenType } from "./tokens.ts";
import { EdgeQLLexer } from "./lexer.ts";
import * as AST from "./ast.ts";

export class EdgeQLParser {
  private tokens: Token[];
  private current = 0;
  private skipShapeInPostfix = false;

  constructor(source: string) {
    const lexer = new EdgeQLLexer(source);
    this.tokens = lexer.tokenize();
  }

  parse(): AST.Query {
    const query = this.parseQuery();

    if (!this.isAtEnd()) {
      this.consume(TokenType.SEMICOLON, "Expected ';' or end of input");
    }

    return query;
  }

  private parseQuery(): AST.Query {
    let query: AST.Query;

    // WITH block
    if (this.check(TokenType.WITH)) {
      query = this.parseWithBlock();
    } // FOR query
    else if (this.check(TokenType.FOR)) {
      query = this.parseForQuery();
    } // SELECT query
    else if (this.check(TokenType.SELECT)) {
      query = this.parseSelectQuery();
    } // INSERT query
    else if (this.check(TokenType.INSERT)) {
      query = this.parseInsertQuery();
    } // UPDATE query
    else if (this.check(TokenType.UPDATE)) {
      query = this.parseUpdateQuery();
    } // DELETE query
    else if (this.check(TokenType.DELETE)) {
      query = this.parseDeleteQuery();
    } // GROUP query
    else if (this.check(TokenType.GROUP)) {
      query = this.parseGroupQuery();
    } // DESCRIBE query
    else if (this.check(TokenType.DESCRIBE)) {
      query = this.parseDescribe();
    } else {
      throw this.error(`Expected query statement, got ${this.peek().value}`);
    }

    // Check for set operations at the query level (UNION, EXCEPT, INTERSECT)
    while (
      this.check(TokenType.UNION) || this.check(TokenType.EXCEPT) ||
      this.check(TokenType.INTERSECT)
    ) {
      const opToken = this.advance();
      const op = opToken.type === TokenType.UNION
        ? "UNION"
        : opToken.type === TokenType.EXCEPT
        ? "EXCEPT"
        : "INTERSECT";

      const right = this.parseQuery();

      // Convert queries to expressions
      const leftExpr: AST.Expression = { kind: "Subquery", query };
      const rightExpr: AST.Expression = { kind: "Subquery", query: right };
      const unionExpr = AST.createBinaryOp(op, leftExpr, rightExpr);

      // Wrap in a SELECT query
      query = {
        kind: "SelectQuery",
        distinct: false,
        expr: unionExpr,
      };
    }

    return query;
  }

  private parseWithBlock(): AST.WithBlock {
    this.consume(TokenType.WITH, "Expected 'WITH'");

    // Check for WITH MODULE <name> — sets module scope for type resolution
    let module: string | undefined;
    if (this.check(TokenType.MODULE)) {
      this.advance(); // consume MODULE
      module = this.parseIdentifier().name;

      // If followed by a comma, continue parsing regular WITH bindings.
      // Otherwise the next token is the query body (SELECT, INSERT, etc.)
      if (!this.match(TokenType.COMMA)) {
        const body = this.parseQuery();
        return { kind: "WithBlock", module, bindings: [], body };
      }
    }

    const bindings: AST.WithBinding[] = [];

    do {
      let recursive = false;

      // Check for RECURSIVE modifier with look-ahead.
      // "recursive" is parsed as an IDENT. We distinguish the modifier from a
      // binding named "recursive" by peeking at the token after it: if the
      // next token is NOT `:=`, then "recursive" is a modifier and the real
      // binding name follows.
      if (
        this.check(TokenType.IDENT) &&
        this.peek().value.toLowerCase() === "recursive"
      ) {
        const nextPos = this.current + 1;
        if (
          nextPos < this.tokens.length &&
          this.tokens[nextPos].type !== TokenType.ASSIGN
        ) {
          this.advance(); // consume "recursive"
          recursive = true;
        }
      }

      const name = this.parseIdentifier();
      this.consume(TokenType.ASSIGN, "Expected ':=' in WITH binding");
      const value = this.parseExpression();

      bindings.push({
        kind: "WithBinding",
        name,
        value,
        recursive: recursive || undefined,
      });
    } while (this.match(TokenType.COMMA));

    const body = this.parseQuery();

    return { kind: "WithBlock", module, bindings, body };
  }

  private parseForQuery(): AST.ForQuery {
    this.consume(TokenType.FOR, "Expected 'FOR'");

    const variable = this.parseIdentifier();
    this.consume(TokenType.IN, "Expected 'IN' after variable");

    // Parse iterator without consuming UNION at the top level
    const iterator = this.parseIfElseExpression();

    this.consume(TokenType.UNION, "Expected 'UNION' after iterator");
    this.consume(TokenType.LPAREN, "Expected '(' after UNION");

    const body = this.parseQuery();

    this.consume(TokenType.RPAREN, "Expected ')' after query body");

    return { kind: "ForQuery", variable, iterator, body };
  }

  private parseSelectQuery(): AST.SelectQuery {
    this.consume(TokenType.SELECT, "Expected 'SELECT'");

    const distinct = this.match(TokenType.DISTINCT);

    // Save state to prevent shape consumption
    this.skipShapeInPostfix = true;
    const expr = this.parseExpression();
    this.skipShapeInPostfix = false;

    let shape: AST.Shape | undefined;
    if (this.check(TokenType.LBRACE)) {
      shape = this.parseShape();
    }

    let filter: AST.Expression | undefined;
    if (this.match(TokenType.FILTER)) {
      filter = this.parseExpression();
    }

    let orderBy: AST.OrderByClause[] | undefined;
    if (this.match(TokenType.ORDER)) {
      this.consume(TokenType.BY, "Expected 'BY' after 'ORDER'");
      orderBy = this.parseOrderByList();
    }

    let offset: AST.Expression | undefined;
    if (this.match(TokenType.OFFSET)) {
      offset = this.parseExpression();
    }

    let limit: AST.Expression | undefined;
    if (this.match(TokenType.LIMIT)) {
      limit = this.parseExpression();
    }

    return {
      kind: "SelectQuery",
      distinct,
      expr,
      shape,
      filter,
      orderBy,
      offset,
      limit,
    };
  }

  private parseInsertQuery(): AST.InsertQuery {
    this.consume(TokenType.INSERT, "Expected 'INSERT'");

    const type = this.parseTypeName();
    const shape = this.parseShape();

    let unless: AST.ConflictClause | undefined;
    if (this.match(TokenType.UNLESS)) {
      this.consume(TokenType.CONFLICT, "Expected 'CONFLICT' after 'UNLESS'");

      let on: AST.Expression | undefined;
      if (this.match(TokenType.ON)) {
        on = this.parseExpression();
      }

      let elseClause: AST.Query | AST.Expression | undefined;
      if (this.match(TokenType.ELSE)) {
        elseClause = this.check(TokenType.LPAREN)
          ? this.parseSubquery()
          : this.parseExpression();
      }

      unless = {
        kind: "ConflictClause",
        on: on || AST.createLiteral("empty", null),
        else: elseClause,
      };
    }

    return { kind: "InsertQuery", type, shape, unless };
  }

  private parseUpdateQuery(): AST.UpdateQuery {
    this.consume(TokenType.UPDATE, "Expected 'UPDATE'");

    const type = this.parseTypeName();

    let filter: AST.Expression | undefined;
    if (this.match(TokenType.FILTER)) {
      filter = this.parseExpression();
    }

    this.consume(TokenType.SET, "Expected 'SET' in UPDATE");
    const shape = this.parseShape();

    return { kind: "UpdateQuery", type, filter, shape };
  }

  private parseDeleteQuery(): AST.DeleteQuery {
    this.consume(TokenType.DELETE, "Expected 'DELETE'");

    const type = this.parseTypeName();

    let filter: AST.Expression | undefined;
    if (this.match(TokenType.FILTER)) {
      filter = this.parseExpression();
    }

    let orderBy: AST.OrderByClause[] | undefined;
    if (this.match(TokenType.ORDER)) {
      this.consume(TokenType.BY, "Expected 'BY' after 'ORDER'");
      orderBy = this.parseOrderByList();
    }

    let limit: AST.Expression | undefined;
    if (this.match(TokenType.LIMIT)) {
      limit = this.parseExpression();
    }

    return { kind: "DeleteQuery", type, filter, orderBy, limit };
  }

  private parseGroupQuery(): AST.GroupQuery {
    this.consume(TokenType.GROUP, "Expected 'GROUP'");

    const expr = this.parseExpression();

    const using: AST.WithBinding[] = [];
    if (
      this.check(TokenType.IDENT) && this.peek().value.toLowerCase() === "using"
    ) {
      this.advance(); // consume 'using'
      do {
        const name = this.parseIdentifier();
        this.consume(TokenType.ASSIGN, "Expected ':=' in USING binding");
        const value = this.parseExpression();
        using.push({ kind: "WithBinding", name, value });
      } while (this.match(TokenType.COMMA));
    }

    this.consume(TokenType.BY, "Expected 'BY' in GROUP");

    const elements: AST.Expression[] = [];
    do {
      elements.push(this.parseExpression());
    } while (this.match(TokenType.COMMA));

    const by: AST.GroupByClause = { kind: "GroupByClause", elements };

    // Optional FILTER clause (compiles to SQL HAVING)
    let filter: AST.Expression | undefined;
    if (this.match(TokenType.FILTER)) {
      filter = this.parseExpression();
    }

    return { kind: "GroupQuery", expr, using, by, filter };
  }

  private parseDescribe(): AST.DescribeTypeQuery | AST.DescribeSchemaQuery {
    this.consume(TokenType.DESCRIBE, "Expected 'DESCRIBE'");

    if (this.match(TokenType.TYPE)) {
      // DESCRIBE TYPE <typeName>
      const parts: string[] = [];
      parts.push(this.parseIdentifier().name);

      while (this.match(TokenType.NAMESPACE)) {
        parts.push(this.parseIdentifier().name);
      }

      return { kind: "DescribeType", typeName: parts.join("::") };
    }

    if (this.match(TokenType.SCHEMA)) {
      return { kind: "DescribeSchema" };
    }

    throw this.error(
      `Expected 'TYPE' or 'SCHEMA' after 'DESCRIBE', got '${this.peek().value}'`,
    );
  }

  private parseOrderByList(): AST.OrderByClause[] {
    const clauses: AST.OrderByClause[] = [];

    do {
      const expr = this.parseExpression();

      let direction: "ASC" | "DESC" | undefined;
      if (this.match(TokenType.ASC)) {
        direction = "ASC";
      } else if (this.match(TokenType.DESC)) {
        direction = "DESC";
      }

      let emptyOrder: "EMPTY FIRST" | "EMPTY LAST" | undefined;
      if (this.match(TokenType.EMPTY)) {
        if (
          this.check(TokenType.IDENT) &&
          this.peek().value.toLowerCase() === "first"
        ) {
          this.advance();
          emptyOrder = "EMPTY FIRST";
        } else if (
          this.check(TokenType.IDENT) &&
          this.peek().value.toLowerCase() === "last"
        ) {
          this.advance();
          emptyOrder = "EMPTY LAST";
        }
      }

      clauses.push({ kind: "OrderByClause", expr, direction, emptyOrder });
    } while (this.match(TokenType.COMMA));

    return clauses;
  }

  private parseShape(): AST.Shape {
    this.consume(TokenType.LBRACE, "Expected '{'");

    const elements: AST.ShapeElement[] = [];

    while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      const element = this.parseShapeElement();
      elements.push(element);

      // If there are more elements, require a comma
      if (!this.check(TokenType.RBRACE)) {
        this.consume(TokenType.COMMA, "Expected ',' or '}'");
      } else {
        // Allow optional trailing comma
        this.match(TokenType.COMMA);
        break;
      }
    }

    this.consume(TokenType.RBRACE, "Expected '}'");

    return AST.createShape(elements);
  }

  private parseShapeElement(): AST.ShapeElement {
    let name: AST.Identifier | undefined;
    let computable = false;
    let cardinality: AST.Cardinality | undefined;

    // Check for cardinality modifiers
    if (this.match(TokenType.REQUIRED)) {
      cardinality = { kind: "Cardinality", required: true };
    } else if (this.match(TokenType.OPTIONAL)) {
      cardinality = { kind: "Cardinality", required: false };
    }

    if (this.match(TokenType.MULTI)) {
      cardinality = { ...cardinality, kind: "Cardinality", multi: true };
    } else if (this.match(TokenType.SINGLE)) {
      cardinality = { ...cardinality, kind: "Cardinality", multi: false };
    }

    // Check for polymorphic shape field: [IS Type].property
    if (this.check(TokenType.LBRACKET)) {
      const bracketCheckpoint = this.current;
      this.advance(); // consume [
      if (this.match(TokenType.IS)) {
        const typeName = this.parseTypeName();
        this.consume(
          TokenType.RBRACKET,
          "Expected ']' after type in polymorphic shape",
        );
        this.consume(
          TokenType.DOT,
          "Expected '.' after [IS Type] in polymorphic shape",
        );
        const propIdent = this.parseIdentifier();
        const propName = propIdent.name;

        // Build the expression as an Identifier for the property
        const expr: AST.Expression = AST.createIdentifier(propName);

        // Check for nested shape
        let shape: AST.Shape | undefined;
        if (this.check(TokenType.LBRACE)) {
          shape = this.parseShape();
        }

        return {
          kind: "ShapeElement",
          expr,
          name: propIdent,
          cardinality,
          shape,
          typeFilter: typeName.name.parts.join("::"),
        };
      } else {
        // Not a polymorphic shape, rewind
        this.current = bracketCheckpoint;
      }
    }

    // Check if it's a computed property (name := expr)
    const checkpoint = this.current;
    if (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)) {
      const ident = this.parseIdentifier();

      if (this.match(TokenType.ASSIGN)) {
        // Computed property
        name = ident;
        computable = true;
        const expr = this.parseExpression();

        // Check for nested shape
        let shape: AST.Shape | undefined;
        if (this.check(TokenType.LBRACE)) {
          shape = this.parseShape();
        }

        return AST.createShapeElement(expr, {
          name,
          computable,
          cardinality,
          shape,
        });
      } else if (this.match(TokenType.COLON)) {
        // Aliased property
        name = ident;

        // Check if the next token is a brace (nested shape)
        let expr: AST.Expression;
        let shape: AST.Shape | undefined;

        if (this.check(TokenType.LBRACE)) {
          // It's a nested shape, not an expression
          shape = this.parseShape();
          // Use the property name as the expression
          expr = AST.createIdentifier(name.name);
        } else {
          // It's an expression
          expr = this.parseExpression();

          // Check for nested shape after the expression
          if (this.check(TokenType.LBRACE)) {
            shape = this.parseShape();
          }
        }

        return AST.createShapeElement(expr, {
          name,
          computable: false,
          cardinality,
          shape,
        });
      } else {
        // Reset if not a computed or aliased property
        this.current = checkpoint;
      }
    }

    // Regular property expression
    const expr = this.parseExpression();

    // Check for nested shape
    let shape: AST.Shape | undefined;
    if (this.check(TokenType.LBRACE)) {
      shape = this.parseShape();
    }

    return AST.createShapeElement(expr, { cardinality, shape });
  }

  private parseExpression(): AST.Expression {
    return this.parseIfElseExpression();
  }

  private parseIfElseExpression(): AST.Expression {
    const expr = this.parseOrExpression();

    if (this.match(TokenType.IF)) {
      const condition = this.parseOrExpression();
      this.consume(TokenType.ELSE, "Expected 'ELSE' in conditional");
      const elseExpr = this.parseIfElseExpression();

      return {
        kind: "IfElse",
        condition,
        then: expr,
        else: elseExpr,
      };
    }

    return expr;
  }

  private parseOrExpression(): AST.Expression {
    let expr = this.parseAndExpression();

    while (this.match(TokenType.OR)) {
      const right = this.parseAndExpression();
      expr = AST.createBinaryOp("OR", expr, right);
    }

    return expr;
  }

  private parseAndExpression(): AST.Expression {
    let expr = this.parseNotExpression();

    while (this.match(TokenType.AND)) {
      const right = this.parseNotExpression();
      expr = AST.createBinaryOp("AND", expr, right);
    }

    return expr;
  }

  private parseNotExpression(): AST.Expression {
    if (this.match(TokenType.NOT)) {
      const operand = this.parseNotExpression();
      return AST.createUnaryOp("NOT", operand);
    }

    return this.parseLikeExpression();
  }

  private parseLikeExpression(): AST.Expression {
    let expr = this.parseInExpression();

    while (true) {
      if (this.match(TokenType.LIKE)) {
        const right = this.parseInExpression();
        expr = AST.createBinaryOp("LIKE", expr, right);
      } else if (this.match(TokenType.ILIKE)) {
        const right = this.parseInExpression();
        expr = AST.createBinaryOp("ILIKE", expr, right);
      } else {
        break;
      }
    }

    return expr;
  }

  private parseInExpression(): AST.Expression {
    let expr = this.parseIsExpression();

    if (this.match(TokenType.IN)) {
      const right = this.parseIsExpression();
      expr = AST.createBinaryOp("IN", expr, right);
    } else if (this.match(TokenType.NOT)) {
      if (this.match(TokenType.IN)) {
        const right = this.parseIsExpression();
        expr = AST.createBinaryOp("NOT IN", expr, right);
      } else {
        // Put back the NOT token
        this.current--;
      }
    }

    return expr;
  }

  private parseIsExpression(): AST.Expression {
    let expr = this.parseComparisonExpression();

    if (this.match(TokenType.IS)) {
      if (this.match(TokenType.NOT)) {
        const right = this.parseComparisonExpression();
        expr = AST.createBinaryOp("IS NOT", expr, right);
      } else {
        const right = this.parseComparisonExpression();
        expr = AST.createBinaryOp("IS", expr, right);
      }
    }

    return expr;
  }

  private parseComparisonExpression(): AST.Expression {
    let expr = this.parseCoalesceExpression();

    while (true) {
      if (this.match(TokenType.EQUALS)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("=", expr, right);
      } else if (this.match(TokenType.NOTEQUALS)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("!=", expr, right);
      } else if (this.match(TokenType.LESS)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("<", expr, right);
      } else if (this.match(TokenType.GREATER)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp(">", expr, right);
      } else if (this.match(TokenType.LESSEQ)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("<=", expr, right);
      } else if (this.match(TokenType.GREATEREQ)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp(">=", expr, right);
      } else if (this.match(TokenType.NOTDISTINCTFROM)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("?=", expr, right);
      } else if (this.match(TokenType.DISTINCTFROM)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("?!=", expr, right);
      } else if (this.match(TokenType.LIKE)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("LIKE", expr, right);
      } else if (this.match(TokenType.ILIKE)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("ILIKE", expr, right);
      } else if (this.match(TokenType.IN)) {
        const right = this.parseCoalesceExpression();
        expr = AST.createBinaryOp("IN", expr, right);
      } else if (this.match(TokenType.IS)) {
        if (this.match(TokenType.NOT)) {
          const right = this.parseCoalesceExpression();
          expr = AST.createBinaryOp("IS NOT", expr, right);
        } else {
          const right = this.parseCoalesceExpression();
          expr = AST.createBinaryOp("IS", expr, right);
        }
      } else {
        break;
      }
    }

    return expr;
  }

  private parseCoalesceExpression(): AST.Expression {
    let expr = this.parseConcatExpression();

    while (this.match(TokenType.COALESCE)) {
      const right = this.parseConcatExpression();
      expr = AST.createBinaryOp("??", expr, right);
    }

    return expr;
  }

  private parseConcatExpression(): AST.Expression {
    let expr = this.parseAdditiveExpression();

    while (this.match(TokenType.CONCAT)) {
      const right = this.parseAdditiveExpression();
      expr = AST.createBinaryOp("++", expr, right);
    }

    return expr;
  }

  private parseAdditiveExpression(): AST.Expression {
    let expr = this.parseMultiplicativeExpression();

    while (true) {
      if (this.match(TokenType.PLUS)) {
        const right = this.parseMultiplicativeExpression();
        expr = AST.createBinaryOp("+", expr, right);
      } else if (this.match(TokenType.MINUS)) {
        const right = this.parseMultiplicativeExpression();
        expr = AST.createBinaryOp("-", expr, right);
      } else {
        break;
      }
    }

    return expr;
  }

  private parseMultiplicativeExpression(): AST.Expression {
    let expr = this.parsePowerExpression();

    while (true) {
      if (this.match(TokenType.STAR)) {
        const right = this.parsePowerExpression();
        expr = AST.createBinaryOp("*", expr, right);
      } else if (this.match(TokenType.SLASH)) {
        const right = this.parsePowerExpression();
        expr = AST.createBinaryOp("/", expr, right);
      } else if (this.match(TokenType.FLOORDIV)) {
        const right = this.parsePowerExpression();
        expr = AST.createBinaryOp("//", expr, right);
      } else if (this.match(TokenType.PERCENT)) {
        const right = this.parsePowerExpression();
        expr = AST.createBinaryOp("%", expr, right);
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePowerExpression(): AST.Expression {
    let expr = this.parseUnaryExpression();

    if (this.match(TokenType.POW)) {
      const right = this.parsePowerExpression(); // Right associative
      expr = AST.createBinaryOp("**", expr, right);
    }

    return expr;
  }

  private parseUnaryExpression(): AST.Expression {
    if (this.match(TokenType.PLUS)) {
      const operand = this.parseUnaryExpression();
      return AST.createUnaryOp("+", operand);
    }

    if (this.match(TokenType.MINUS)) {
      const operand = this.parseUnaryExpression();
      return AST.createUnaryOp("-", operand);
    }

    if (this.match(TokenType.DISTINCT)) {
      const operand = this.parseUnaryExpression();
      return AST.createUnaryOp("DISTINCT", operand);
    }

    if (this.match(TokenType.EXISTS)) {
      const operand = this.parseUnaryExpression();
      return AST.createUnaryOp("EXISTS", operand);
    }

    if (this.match(TokenType.DETACHED)) {
      const operand = this.parseUnaryExpression();
      return AST.createUnaryOp("DETACHED", operand);
    }

    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): AST.Expression {
    let expr = this.parsePrimaryExpression();

    while (true) {
      // Property or link access
      if (this.match(TokenType.DOT)) {
        // Check for numeric tuple index access (e.g., .0, .1, .2)
        if (this.check(TokenType.INTEGER)) {
          const indexToken = this.advance();
          const index = parseInt(indexToken.value);
          expr = {
            kind: "TupleAccessExpr",
            tuple: expr,
            accessType: "index",
            index,
          };
        } else if (
          (expr.kind === "TupleExpr" || expr.kind === "NamedTuple" ||
            expr.kind === "TupleAccessExpr") &&
          (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT))
        ) {
          // Named tuple field access (e.g., (name := 'foo').name)
          const fieldName = this.parseIdentifier().name;
          expr = {
            kind: "TupleAccessExpr",
            tuple: expr,
            accessType: "name",
            fieldName,
          };
        } else {
          const step = this.parsePathStep();

          // Convert to path if not already
          if (expr.kind === "Path") {
            expr.steps.push(step);
          } else if (expr.kind === "Identifier" || expr.kind === "TypeName") {
            // Convert identifier/typename to path
            const firstStep: AST.PathStep = {
              kind: "PathStep",
              type: "property",
              name: expr.kind === "Identifier"
                ? expr.name
                : expr.name.parts.join("::"),
              optional: false,
            };
            expr = AST.createPath([firstStep, step]);
          } else {
            throw this.error("Cannot apply path access to this expression");
          }
        }
      } // Backward link
      else if (this.match(TokenType.BACKLINK)) {
        const name = this.parseIdentifier().name;

        let filter: AST.Expression | undefined;
        if (this.match(TokenType.LBRACKET)) {
          // Type filter like .<owner[IS Issue]
          if (this.match(TokenType.IS)) {
            filter = this.parseTypeName();
          } else {
            filter = this.parseExpression();
          }
          this.consume(TokenType.RBRACKET, "Expected ']'");
        }

        const step: AST.PathStep = {
          kind: "PathStep",
          type: "backlink",
          name,
          filter,
        };

        if (expr.kind === "Path") {
          expr.steps.push(step);
        } else {
          expr = AST.createPath([step]);
        }
      } // Link property access with @
      else if (this.match(TokenType.AT)) {
        const propName = this.parseIdentifier().name;

        if (expr.kind === "Path" && expr.steps.length > 0) {
          const lastStep = expr.steps[expr.steps.length - 1];
          lastStep.linkProps = propName;
        }
      } // Function call
      else if (this.match(TokenType.LPAREN)) {
        const args = this.parseFunctionArguments();
        this.consume(TokenType.RPAREN, "Expected ')'");

        let funcName: AST.QualifiedName;
        if (expr.kind === "Identifier") {
          funcName = AST.createQualifiedName([expr.name]);
        } else if (expr.kind === "Path") {
          // Convert path to qualified name for function call
          const parts = expr.steps.map((s) => s.name);
          funcName = AST.createQualifiedName(parts);
        } else if (expr.kind === "TypeName") {
          // Qualified name parsed as TypeName (e.g., schema::types)
          funcName = expr.name;
        } else {
          throw this.error("Invalid function call");
        }

        // Check for OVER clause (window function)
        if (this.check(TokenType.OVER)) {
          expr = this.parseWindowFunctionCall(funcName, args);
        } else {
          expr = AST.createFunctionCall(funcName, args);
        }
      } // Type intersection [IS Type] or array/set indexing
      else if (this.match(TokenType.LBRACKET)) {
        // Check for [IS Type] type intersection
        if (this.match(TokenType.IS)) {
          const typeName = this.parseTypeName();
          this.consume(
            TokenType.RBRACKET,
            "Expected ']' after type intersection",
          );

          const typeIntersectionStep: AST.PathStep = {
            kind: "PathStep",
            type: "type_intersection",
            name: typeName.name.parts.join("::"),
          };

          // Convert to path if not already
          if (expr.kind === "Path") {
            expr.steps.push(typeIntersectionStep);
          } else if (expr.kind === "Identifier" || expr.kind === "TypeName") {
            const firstName = expr.kind === "Identifier"
              ? expr.name
              : expr.name.parts.join("::");
            const firstStep: AST.PathStep = {
              kind: "PathStep",
              type: "property",
              name: firstName,
              optional: false,
            };
            expr = AST.createPath([firstStep, typeIntersectionStep]);
          } else {
            throw this.error(
              "Cannot apply type intersection to this expression",
            );
          }
        } else {
          // Index or slice expression: expr[n] or expr[a:b]
          if (this.check(TokenType.COLON)) {
            // [:b] or [:]
            this.advance(); // consume ':'
            if (this.check(TokenType.RBRACKET)) {
              this.advance();
              expr = AST.createSliceExpression(expr);
            } else {
              const end = this.parseExpression();
              this.consume(TokenType.RBRACKET, "Expected ']'");
              expr = AST.createSliceExpression(expr, undefined, end);
            }
          } else {
            const first = this.parseExpression();
            if (this.check(TokenType.COLON)) {
              // [a:b] or [a:]
              this.advance(); // consume ':'
              if (this.check(TokenType.RBRACKET)) {
                this.advance();
                expr = AST.createSliceExpression(expr, first);
              } else {
                const end = this.parseExpression();
                this.consume(TokenType.RBRACKET, "Expected ']'");
                expr = AST.createSliceExpression(expr, first, end);
              }
            } else {
              // [n] — plain index
              this.consume(TokenType.RBRACKET, "Expected ']'");
              expr = AST.createIndexExpression(expr, first);
            }
          }
        }
      } // Shape (only if not skipping)
      else if (!this.skipShapeInPostfix && this.check(TokenType.LBRACE)) {
        const shape = this.parseShape();
        expr = { kind: "ShapeExpr", expr, shape };
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePathStep(): AST.PathStep {
    const name = this.parseIdentifier().name;

    let optional = false;
    if (this.match(TokenType.OPTIONALLINK)) {
      optional = true;
    }

    return {
      kind: "PathStep",
      type: "property",
      name,
      optional,
    };
  }

  private parsePrimaryExpression(): AST.Expression {
    // Literals
    if (this.check(TokenType.STRING)) {
      const value = this.advance().value;
      return AST.createLiteral("string", value);
    }

    if (this.check(TokenType.INTEGER)) {
      const value = this.advance().value;
      return AST.createLiteral("integer", parseInt(value));
    }

    if (this.check(TokenType.FLOAT)) {
      const value = this.advance().value;
      return AST.createLiteral("float", parseFloat(value));
    }

    if (this.check(TokenType.BOOLEAN)) {
      const value = this.advance().value === "true";
      return AST.createLiteral("boolean", value);
    }

    if (this.check(TokenType.BYTES)) {
      const value = this.advance().value;
      return AST.createLiteral("bytes", value);
    }

    if (this.match(TokenType.EMPTY)) {
      return AST.createLiteral("empty", null);
    }

    // Parameters
    if (this.check(TokenType.PARAMETER)) {
      const name = this.advance().value;
      return AST.createParameter(name);
    }

    // Type cast <type>expr
    if (this.match(TokenType.LESS)) {
      const type = this.parseTypeName();
      this.consume(TokenType.GREATER, "Expected '>' after type");

      // Check for cardinality cast
      let cardinality: AST.Cardinality | undefined;
      if (
        type.name.parts[0] === "REQUIRED" || type.name.parts[0] === "OPTIONAL"
      ) {
        cardinality = {
          kind: "Cardinality",
          required: type.name.parts[0] === "REQUIRED",
        };
        // Parse the actual type
        const actualType = this.parseTypeName();
        this.consume(TokenType.GREATER, "Expected '>' after type");
        const expr = this.parsePrimaryExpression();
        return { kind: "TypeCast", type: actualType, expr, cardinality };
      }

      const expr = this.parsePrimaryExpression();
      return { kind: "TypeCast", type, expr };
    }

    // Parenthesized expression or tuple
    if (this.match(TokenType.LPAREN)) {
      // Empty tuple
      if (this.check(TokenType.RPAREN)) {
        this.advance();
        return { kind: "TupleExpr", elements: [] };
      }

      // Check if it's a named tuple
      const checkpoint = this.current;
      if (this.check(TokenType.IDENT)) {
        this.advance();
        if (this.match(TokenType.ASSIGN)) {
          // Named tuple
          this.current = checkpoint;
          return this.parseNamedTuple();
        } else {
          // Regular expression
          this.current = checkpoint;
        }
      }

      const firstExpr = this.parseExpression();

      // Check if it's a tuple
      if (this.match(TokenType.COMMA)) {
        const elements = [firstExpr];

        do {
          if (this.check(TokenType.RPAREN)) break; // Allow trailing comma
          elements.push(this.parseExpression());
        } while (this.match(TokenType.COMMA));

        this.consume(TokenType.RPAREN, "Expected ')'");
        return { kind: "TupleExpr", elements };
      }

      this.consume(TokenType.RPAREN, "Expected ')'");

      // Parenthesized expression is just the expression itself

      return firstExpr;
    }

    // Set literal
    if (this.match(TokenType.LBRACE)) {
      const elements: AST.Expression[] = [];

      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        elements.push(this.parseExpression());

        if (!this.match(TokenType.COMMA)) break;
      }

      this.consume(TokenType.RBRACE, "Expected '}'");
      return { kind: "SetExpr", elements };
    }

    // Array literal
    if (this.match(TokenType.LBRACKET)) {
      const elements: AST.Expression[] = [];

      while (!this.check(TokenType.RBRACKET) && !this.isAtEnd()) {
        elements.push(this.parseExpression());

        if (!this.match(TokenType.COMMA)) break;
      }

      this.consume(TokenType.RBRACKET, "Expected ']'");
      return { kind: "ArrayExpr", elements };
    }

    // INTROSPECT
    if (this.match(TokenType.INTROSPECT)) {
      const type = this.parseTypeName();
      return { kind: "Introspection", type };
    }

    // GLOBAL
    if (this.match(TokenType.GLOBAL)) {
      const name = this.parseIdentifier();
      return name;
    }

    // TYPEOF
    if (this.match(TokenType.TYPEOF)) {
      const expr = this.parsePrimaryExpression();
      const name = AST.createQualifiedName(["typeof"]);
      return AST.createFunctionCall(name, [
        { kind: "FunctionArg", value: expr },
      ]);
    }

    // Keyword used as namespace prefix (e.g., schema::types())
    // When a keyword like SCHEMA is followed by ::, treat it as a qualified
    // name rather than a keyword so that schema::get_type() etc. parse correctly.
    if (
      this.check(TokenType.SCHEMA) &&
      this.current + 1 < this.tokens.length &&
      this.tokens[this.current + 1].type === TokenType.NAMESPACE
    ) {
      const parts: string[] = [];
      parts.push(this.advance().value.toLowerCase());

      while (this.match(TokenType.NAMESPACE)) {
        parts.push(this.parseIdentifier().name);
      }

      return AST.createTypeName(parts);
    }

    // Type name or identifier
    if (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)) {
      const parts: string[] = [];

      parts.push(this.parseIdentifier().name);

      while (this.match(TokenType.NAMESPACE)) {
        parts.push(this.parseIdentifier().name);
      }

      // Check if it's a type name (starts with uppercase or is qualified)
      if (parts.length > 1 || /^[A-Z]/.test(parts[0])) {
        return AST.createTypeName(parts);
      }

      return AST.createIdentifier(parts[0]);
    }

    // Path starting with . (relative path)
    if (this.check(TokenType.DOT)) {
      // Create a path starting with the current object
      return AST.createPath([]);
    }

    // Backward link path starting with .<
    if (this.check(TokenType.BACKLINK)) {
      // Will be handled in parsePostfixExpression
      return AST.createPath([]);
    }

    // Subquery (SELECT, INSERT, etc. in expression position)
    if (
      this.check(TokenType.SELECT) || this.check(TokenType.INSERT) ||
      this.check(TokenType.UPDATE) || this.check(TokenType.DELETE) ||
      this.check(TokenType.FOR) || this.check(TokenType.WITH)
    ) {
      const query = this.parseQuery();
      return { kind: "Subquery", query };
    }

    throw this.error(`Unexpected token: ${this.peek().value}`);
  }

  private parseNamedTuple(): AST.NamedTuple {
    const elements: AST.NamedTupleElement[] = [];

    do {
      if (this.check(TokenType.RPAREN)) break;

      const name = this.parseIdentifier().name;
      this.consume(TokenType.ASSIGN, "Expected ':=' in named tuple");
      const value = this.parseExpression();

      elements.push({ kind: "NamedTupleElement", name, value });
    } while (this.match(TokenType.COMMA));

    this.consume(TokenType.RPAREN, "Expected ')'");

    return { kind: "NamedTuple", elements };
  }

  private parseFunctionArguments(): AST.FunctionArg[] {
    const args: AST.FunctionArg[] = [];

    if (this.check(TokenType.RPAREN)) {
      return args;
    }

    do {
      // Check for named argument
      let name: string | undefined;
      const checkpoint = this.current;

      if (this.check(TokenType.IDENT)) {
        const ident = this.advance();
        if (this.match(TokenType.ASSIGN)) {
          name = ident.value;
        } else {
          this.current = checkpoint;
        }
      }

      const value = this.parseExpression();
      args.push({ kind: "FunctionArg", name, value });
    } while (this.match(TokenType.COMMA));

    return args;
  }

  private parseWindowFunctionCall(
    name: AST.QualifiedName,
    args: AST.FunctionArg[],
  ): AST.WindowFunctionCall {
    this.consume(TokenType.OVER, "Expected 'OVER'");
    this.consume(TokenType.LPAREN, "Expected '(' after OVER");

    const over = this.parseWindowOverClause();

    this.consume(TokenType.RPAREN, "Expected ')' to close OVER clause");

    return {
      kind: "WindowFunctionCall",
      name,
      args,
      over,
    };
  }

  private parseWindowOverClause(): AST.WindowOverClause {
    let partitionBy: AST.Expression[] | undefined;
    let orderBy: AST.OrderByClause[] | undefined;
    let frame: AST.WindowFrameClause | undefined;

    // Parse PARTITION BY
    if (this.check(TokenType.PARTITION)) {
      this.advance(); // consume PARTITION
      this.consume(TokenType.BY, "Expected 'BY' after 'PARTITION'");

      partitionBy = [];
      do {
        partitionBy.push(this.parseExpression());
      } while (this.match(TokenType.COMMA));
    }

    // Parse ORDER BY
    if (this.match(TokenType.ORDER)) {
      this.consume(TokenType.BY, "Expected 'BY' after 'ORDER'");
      orderBy = this.parseOrderByList();
    }

    // Parse frame spec: ROWS|RANGE|GROUPS BETWEEN ... AND ...
    if (
      this.check(TokenType.ROWS) || this.check(TokenType.RANGE) ||
      this.check(TokenType.GROUPS)
    ) {
      const modeToken = this.advance();
      const mode = modeToken.value.toUpperCase() as "ROWS" | "RANGE" | "GROUPS";

      if (this.match(TokenType.BETWEEN)) {
        const start = this.parseFrameBound();
        this.consume(TokenType.AND, "Expected 'AND' in frame spec");
        const end = this.parseFrameBound();

        frame = {
          kind: "WindowFrameClause",
          mode,
          start,
          end,
        };
      } else {
        // Single bound (no BETWEEN): e.g., ROWS UNBOUNDED PRECEDING
        const start = this.parseFrameBound();

        frame = {
          kind: "WindowFrameClause",
          mode,
          start,
        };
      }

      // Parse optional EXCLUDE clause
      if (
        frame && this.check(TokenType.IDENT) &&
        this.peek().value.toLowerCase() === "exclude"
      ) {
        this.advance(); // consume "exclude"

        if (this.check(TokenType.CURRENT)) {
          this.advance(); // consume CURRENT
          // expect ROW as identifier
          if (
            this.check(TokenType.IDENT) &&
            this.peek().value.toLowerCase() === "row"
          ) {
            this.advance();
            frame.exclude = "CURRENT ROW";
          } else {
            throw this.error("Expected 'ROW' after 'CURRENT' in EXCLUDE");
          }
        } else if (this.check(TokenType.GROUP)) {
          this.advance();
          frame.exclude = "GROUP";
        } else if (this.check(TokenType.IDENT)) {
          const val = this.peek().value.toLowerCase();
          if (val === "ties") {
            this.advance();
            frame.exclude = "TIES";
          } else if (val === "no") {
            this.advance();
            // expect "others" as identifier
            if (
              this.check(TokenType.IDENT) &&
              this.peek().value.toLowerCase() === "others"
            ) {
              this.advance();
              frame.exclude = "NO OTHERS";
            } else {
              throw this.error(
                "Expected 'OTHERS' after 'NO' in EXCLUDE",
              );
            }
          } else {
            throw this.error(
              "Expected 'CURRENT ROW', 'GROUP', 'TIES', or 'NO OTHERS' after 'EXCLUDE'",
            );
          }
        } else {
          throw this.error(
            "Expected 'CURRENT ROW', 'GROUP', 'TIES', or 'NO OTHERS' after 'EXCLUDE'",
          );
        }
      }
    }

    return {
      kind: "WindowOverClause",
      partitionBy,
      orderBy,
      frame,
    };
  }

  private parseFrameBound(): AST.FrameBound {
    // UNBOUNDED PRECEDING
    if (this.check(TokenType.UNBOUNDED)) {
      this.advance();
      if (this.check(TokenType.PRECEDING)) {
        this.advance();
        return { kind: "FrameBound", type: "UNBOUNDED PRECEDING" };
      }
      if (this.check(TokenType.FOLLOWING)) {
        this.advance();
        return { kind: "FrameBound", type: "UNBOUNDED FOLLOWING" };
      }
      throw this.error("Expected 'PRECEDING' or 'FOLLOWING' after 'UNBOUNDED'");
    }

    // CURRENT ROW
    if (this.check(TokenType.CURRENT)) {
      this.advance();
      // Expect ROW as an identifier
      if (
        this.check(TokenType.IDENT) &&
        this.peek().value.toLowerCase() === "row"
      ) {
        this.advance();
        return { kind: "FrameBound", type: "CURRENT ROW" };
      }
      throw this.error("Expected 'ROW' after 'CURRENT'");
    }

    // <N> PRECEDING or <N> FOLLOWING
    const offset = this.parseExpression();
    if (this.check(TokenType.PRECEDING)) {
      this.advance();
      return { kind: "FrameBound", type: "OFFSET PRECEDING", offset };
    }
    if (this.check(TokenType.FOLLOWING)) {
      this.advance();
      return { kind: "FrameBound", type: "OFFSET FOLLOWING", offset };
    }

    throw this.error(
      "Expected 'PRECEDING', 'FOLLOWING', 'CURRENT ROW', or 'UNBOUNDED' in frame bound",
    );
  }

  private parseSubquery(): AST.Subquery {
    this.consume(TokenType.LPAREN, "Expected '('");
    const query = this.parseQuery();
    this.consume(TokenType.RPAREN, "Expected ')'");

    return { kind: "Subquery", query };
  }

  private parseIdentifier(): AST.Identifier {
    if (this.check(TokenType.IDENT)) {
      const name = this.advance().value;
      return AST.createIdentifier(name, false);
    }

    if (this.check(TokenType.BACKTICK_IDENT)) {
      const name = this.advance().value;
      return AST.createIdentifier(name, true);
    }

    throw this.error(`Expected identifier, got ${this.peek().value}`);
  }

  private parseTypeName(): AST.TypeName {
    const parts: string[] = [];

    parts.push(this.parseIdentifier().name);

    while (this.match(TokenType.NAMESPACE)) {
      parts.push(this.parseIdentifier().name);
    }

    return AST.createTypeName(parts);
  }

  // Utility methods
  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    throw this.error(message);
  }

  private error(message: string): SyntaxError {
    const token = this.peek();
    return new SyntaxError(message, {
      location: {
        line: token.line,
        column: token.column,
        offset: token.offset,
      },
    });
  }
}
