/**
 * SDL Parser - Parses SDL tokens into AST
 */

import { SyntaxError } from "../lib/errors.ts";
import { Token, TokenType } from "./tokens.ts";
import { SDLLexer } from "./lexer.ts";
import * as AST from "./ast.ts";

export class SDLParser {
  private tokens: Token[];
  private current = 0;

  constructor(source: string) {
    const lexer = new SDLLexer(source);
    this.tokens = lexer.tokenize();
  }

  parse(): AST.SDLDocument {
    const declarations: AST.Declaration[] = [];

    while (!this.isAtEnd()) {
      const decl = this.parseTopLevelDeclaration();
      if (decl) {
        declarations.push(decl);
      }
    }

    return { kind: "SDLDocument", declarations };
  }

  private parseTopLevelDeclaration(): AST.Declaration | null {
    // Skip semicolons and whitespace at top level
    while (
      this.match(TokenType.SEMICOLON) || this.match(TokenType.WHITESPACE) ||
      this.match(TokenType.NEWLINE)
    ) {
      // Do nothing
    }

    if (this.isAtEnd() || this.check(TokenType.RBRACE)) {
      return null;
    }

    // Check for abstract modifier
    const isAbstract = this.match(TokenType.ABSTRACT);

    if (this.match(TokenType.MODULE)) {
      if (isAbstract) {
        throw this.error("Module cannot be abstract");
      }
      return this.parseModuleDeclaration();
    }

    if (this.match(TokenType.TYPE)) {
      return this.parseTypeDeclaration(isAbstract);
    }

    if (this.match(TokenType.SCALAR)) {
      this.consume(TokenType.TYPE, "Expected 'type' after 'scalar'");
      return this.parseScalarTypeDeclaration(isAbstract);
    }

    if (this.match(TokenType.ALIAS)) {
      if (isAbstract) {
        throw this.error("Alias cannot be abstract");
      }
      return this.parseAliasDeclaration();
    }

    if (this.match(TokenType.FUNCTION)) {
      if (isAbstract) {
        throw this.error("Function cannot be abstract");
      }
      return this.parseFunctionDeclaration();
    }

    if (this.match(TokenType.GLOBAL)) {
      if (isAbstract) {
        throw this.error("Global cannot be abstract");
      }
      return this.parseGlobalDeclaration();
    }

    if (this.match(TokenType.LINK)) {
      return this.parseAbstractLinkDeclaration(isAbstract);
    }

    if (this.match(TokenType.ANNOTATION)) {
      return this.parseAnnotationDeclaration(isAbstract);
    }

    const token = this.peek();
    throw this.error(
      `Unexpected token: '${token.value}' (type: ${token.type})`,
    );
  }

  private parseModuleDeclaration(): AST.ModuleDeclaration {
    const name = this.parseQualifiedName();
    this.consume(TokenType.LBRACE, "Expected '{' after module name");

    const declarations: AST.Declaration[] = [];

    while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      const decl = this.parseTopLevelDeclaration();
      if (decl) {
        declarations.push(decl);
      }
    }

    this.consume(TokenType.RBRACE, "Expected '}' after module body");

    return { kind: "ModuleDeclaration", name, declarations };
  }

  private parseTypeDeclaration(abstract?: boolean): AST.TypeDeclaration {
    const name = this.parseIdentifier();

    let extending: AST.TypeRef[] | undefined;
    if (this.match(TokenType.EXTENDING)) {
      extending = this.parseTypeRefList();
    }

    const members: AST.TypeMember[] = [];

    if (this.match(TokenType.LBRACE)) {
      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        const member = this.parseTypeMember();
        if (member) {
          members.push(member);
        }
      }
      this.consume(TokenType.RBRACE, "Expected '}' after type body");
    } else {
      this.consume(
        TokenType.SEMICOLON,
        "Expected ';' or '{' after type declaration",
      );
    }

    return { kind: "TypeDeclaration", abstract, name, extending, members };
  }

  private parseScalarTypeDeclaration(
    abstract?: boolean,
  ): AST.ScalarTypeDeclaration {
    const name = this.parseIdentifier();

    let extending: AST.TypeRef[] | undefined;
    if (this.match(TokenType.EXTENDING)) {
      extending = this.parseTypeRefList();
    }

    const constraints: AST.Constraint[] = [];
    const annotations: AST.Annotation[] = [];

    if (this.match(TokenType.LBRACE)) {
      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        if (this.match(TokenType.CONSTRAINT)) {
          constraints.push(this.parseConstraint());
        } else if (this.match(TokenType.ANNOTATION)) {
          annotations.push(this.parseAnnotation());
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }
      this.consume(TokenType.RBRACE, "Expected '}' after scalar type body");
    } else {
      this.consume(
        TokenType.SEMICOLON,
        "Expected ';' or '{' after scalar type declaration",
      );
    }

    return {
      kind: "ScalarTypeDeclaration",
      abstract,
      name,
      extending,
      constraints,
      annotations,
    };
  }

  private parseAliasDeclaration(): AST.AliasDeclaration {
    const name = this.parseIdentifier();
    this.consume(TokenType.ASSIGN, "Expected ':=' in alias declaration");
    const using = this.parseExpression();
    this.consume(TokenType.SEMICOLON, "Expected ';' after alias declaration");

    return { kind: "AliasDeclaration", name, using };
  }

  private parseFunctionDeclaration(): AST.FunctionDeclaration {
    const name = this.parseIdentifier();

    this.consume(TokenType.LPAREN, "Expected '(' after function name");
    const parameters = this.parseFunctionParameters();
    this.consume(TokenType.RPAREN, "Expected ')' after parameters");

    this.consume(TokenType.ARROW, "Expected '->' after parameters");
    const returnType = this.parseTypeRef();

    let using: AST.Expression | undefined;
    if (this.match(TokenType.USING)) {
      this.consume(TokenType.LPAREN, "Expected '(' after 'using'");
      using = this.parseExpression();
      this.consume(TokenType.RPAREN, "Expected ')' after expression");
    }

    this.consume(
      TokenType.SEMICOLON,
      "Expected ';' after function declaration",
    );

    return { kind: "FunctionDeclaration", name, parameters, returnType, using };
  }

  private parseGlobalDeclaration(): AST.GlobalDeclaration {
    const qualifiers = this.parsePointerQualifiers();
    const name = this.parseIdentifier();
    this.consume(TokenType.COLON, "Expected ':' after global name");
    const type = this.parseTypeRef();

    let defaultValue: AST.Expression | undefined;
    let readonly = false;

    if (this.match(TokenType.LBRACE)) {
      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        if (this.match(TokenType.DEFAULT)) {
          this.consume(TokenType.ASSIGN, "Expected ':=' after 'default'");
          defaultValue = this.parseExpression();
          this.consume(TokenType.SEMICOLON, "Expected ';' after default value");
        } else if (this.match(TokenType.READONLY)) {
          this.consume(TokenType.ASSIGN, "Expected ':=' after 'readonly'");
          readonly = this.parseBooleanLiteral();
          this.consume(
            TokenType.SEMICOLON,
            "Expected ';' after readonly value",
          );
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }
      this.consume(TokenType.RBRACE, "Expected '}' after global body");
      this.consume(
        TokenType.SEMICOLON,
        "Expected ';' after global declaration",
      );
    } else {
      this.consume(
        TokenType.SEMICOLON,
        "Expected ';' or '{' after global declaration",
      );
    }

    return {
      kind: "GlobalDeclaration",
      name,
      type,
      required: qualifiers.required,
      multi: qualifiers.multi,
      default: defaultValue,
      readonly,
    };
  }

  private parseAnnotationDeclaration(
    abstract?: boolean,
  ): AST.AnnotationDeclaration {
    const name = this.parseIdentifier();

    let type: AST.TypeRef | undefined;
    if (this.match(TokenType.COLON)) {
      type = this.parseTypeRef();
    }

    this.consume(
      TokenType.SEMICOLON,
      "Expected ';' after annotation declaration",
    );

    return { kind: "AnnotationDeclaration", abstract, name, type };
  }

  private parseAbstractLinkDeclaration(
    abstract?: boolean,
  ): AST.LinkDeclaration {
    const name = this.parseIdentifier();

    // Check for extending clause
    let extending: AST.TypeRef[] | undefined;
    if (this.match(TokenType.EXTENDING)) {
      extending = this.parseTypeRefList();
    }

    // Abstract link declarations may have no target type (just a body with
    // properties and constraints), or they may have an arrow target.
    let target: AST.TypeRef;
    if (this.match(TokenType.ARROW)) {
      target = this.parseTypeRef();
    } else {
      // No target -- use a placeholder TypeRef
      target = AST.createTypeRef(AST.createQualifiedName(["std::BaseObject"]));
    }

    const link: AST.LinkDeclaration = {
      kind: "LinkDeclaration",
      name,
      target,
      abstract,
    };

    if (extending && extending.length > 0) {
      link.extending = extending;
    }

    if (this.match(TokenType.LBRACE)) {
      const properties: AST.PropertyDeclaration[] = [];
      const constraints: AST.Constraint[] = [];
      const annotations: AST.Annotation[] = [];

      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        const propQualifiers = this.parsePointerQualifiers();

        if (this.match(TokenType.PROPERTY)) {
          properties.push(this.parsePropertyDeclaration(propQualifiers));
        } else if (this.match(TokenType.CONSTRAINT)) {
          constraints.push(this.parseConstraint());
        } else if (this.match(TokenType.ANNOTATION)) {
          annotations.push(this.parseAnnotation());
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }

      this.consume(TokenType.RBRACE, "Expected '}' after abstract link body");

      if (properties.length > 0) link.properties = properties;
      if (constraints.length > 0) link.constraints = constraints;
      if (annotations.length > 0) link.annotations = annotations;
    }

    // Consume optional trailing semicolon
    this.match(TokenType.SEMICOLON);

    return link;
  }

  private parseTypeMember(): AST.TypeMember | null {
    // Skip semicolons
    while (this.match(TokenType.SEMICOLON)) {
      // Do nothing
    }

    if (this.check(TokenType.RBRACE)) {
      return null;
    }

    const qualifiers = this.parsePointerQualifiers();

    if (this.match(TokenType.PROPERTY)) {
      return this.parsePropertyDeclaration(qualifiers);
    }

    if (this.match(TokenType.LINK)) {
      return this.parseLinkDeclaration(qualifiers);
    }

    if (this.match(TokenType.CONSTRAINT)) {
      return this.parseConstraint();
    }

    if (this.match(TokenType.INDEX)) {
      return this.parseIndex();
    }

    if (this.match(TokenType.ANNOTATION)) {
      return this.parseAnnotation();
    }

    if (this.match(TokenType.ACCESS)) {
      return this.parseAccessPolicy();
    }

    if (this.match(TokenType.TRIGGER)) {
      return this.parseTriggerDeclaration();
    }

    // Check for computed property/link (name := expression)
    if (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)) {
      const checkpoint = this.current;
      const name = this.parseIdentifier();

      if (this.match(TokenType.ASSIGN)) {
        // Computed property
        const computed = this.parseExpression();
        this.consume(
          TokenType.SEMICOLON,
          "Expected ';' after computed property",
        );

        return {
          kind: "PropertyDeclaration",
          name,
          type: AST.createTypeRef(AST.createQualifiedName(["auto"])), // Type will be inferred
          computed,
          ...qualifiers,
        };
      } else if (this.match(TokenType.COLON)) {
        // Regular property
        const type = this.parseTypeRef();
        const prop = this.parsePropertyBody(name, type, qualifiers);
        return prop;
      } else if (this.check(TokenType.EXTENDING)) {
        // Link shorthand with extending clause: name extending X -> Type
        let linkExtending: AST.TypeRef[] | undefined;
        if (this.match(TokenType.EXTENDING)) {
          linkExtending = this.parseTypeRefList();
        }
        this.consume(TokenType.ARROW, "Expected '->' after extending clause");
        const extTarget = this.parseTypeRef();
        const extLink = this.parseLinkBody(
          name,
          extTarget,
          qualifiers,
          linkExtending,
        );
        return extLink;
      } else if (this.match(TokenType.ARROW)) {
        // Link shorthand
        const target = this.parseTypeRef();
        const link = this.parseLinkBody(name, target, qualifiers);
        return link;
      } else if (
        this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)
      ) {
        // Looks like a property declaration but missing colon
        throw this.error("Expected ':' after property name");
      }

      // Restore position if not a property/link
      this.current = checkpoint;
    }

    throw this.error(`Unexpected token in type body: ${this.peek().value}`);
  }

  private parsePropertyDeclaration(qualifiers: any): AST.PropertyDeclaration {
    const name = this.parseIdentifier();
    this.consume(TokenType.COLON, "Expected ':' after property name");
    const type = this.parseTypeRef();

    return this.parsePropertyBody(name, type, qualifiers);
  }

  private parsePropertyBody(
    name: AST.Identifier,
    type: AST.TypeRef,
    qualifiers: any,
  ): AST.PropertyDeclaration {
    const property: AST.PropertyDeclaration = {
      kind: "PropertyDeclaration",
      name,
      type,
      ...qualifiers,
    };

    if (this.match(TokenType.LBRACE)) {
      const constraints: AST.Constraint[] = [];
      const annotations: AST.Annotation[] = [];
      const rewrites: AST.RewriteDeclaration[] = [];

      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        if (this.match(TokenType.CONSTRAINT)) {
          constraints.push(this.parseConstraint());
        } else if (this.match(TokenType.ANNOTATION)) {
          annotations.push(this.parseAnnotation());
        } else if (this.match(TokenType.DEFAULT)) {
          this.consume(TokenType.ASSIGN, "Expected ':=' after 'default'");
          property.default = this.parseExpression();
          this.consume(TokenType.SEMICOLON, "Expected ';' after default value");
        } else if (this.match(TokenType.READONLY)) {
          this.consume(TokenType.ASSIGN, "Expected ':=' after 'readonly'");
          property.readonly = this.parseBooleanLiteral();
          this.consume(
            TokenType.SEMICOLON,
            "Expected ';' after readonly value",
          );
        } else if (this.match(TokenType.REWRITE)) {
          rewrites.push(this.parseRewriteDeclaration());
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }

      this.consume(TokenType.RBRACE, "Expected '}' after property body");

      if (constraints.length > 0) property.constraints = constraints;
      if (annotations.length > 0) property.annotations = annotations;
      if (rewrites.length > 0) property.rewrites = rewrites;
    } else {
      this.consume(
        TokenType.SEMICOLON,
        "Expected ';' or '{' after property declaration",
      );
    }

    return property;
  }

  private parseLinkDeclaration(qualifiers: any): AST.LinkDeclaration {
    const name = this.parseIdentifier();

    // Check for extending clause before the arrow
    let extending: AST.TypeRef[] | undefined;
    if (this.match(TokenType.EXTENDING)) {
      extending = this.parseTypeRefList();
    }

    this.consume(TokenType.ARROW, "Expected '->' after link name");
    const target = this.parseTypeRef();

    return this.parseLinkBody(name, target, qualifiers, extending);
  }

  private parseLinkBody(
    name: AST.Identifier,
    target: AST.TypeRef,
    qualifiers: any,
    extending?: AST.TypeRef[],
  ): AST.LinkDeclaration {
    const link: AST.LinkDeclaration = {
      kind: "LinkDeclaration",
      name,
      target,
      ...qualifiers,
    };

    if (extending && extending.length > 0) {
      link.extending = extending;
    }

    if (this.match(TokenType.LBRACE)) {
      const properties: AST.PropertyDeclaration[] = [];
      const constraints: AST.Constraint[] = [];
      const annotations: AST.Annotation[] = [];

      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        const propQualifiers = this.parsePointerQualifiers();

        if (this.match(TokenType.PROPERTY)) {
          properties.push(this.parsePropertyDeclaration(propQualifiers));
        } else if (this.match(TokenType.CONSTRAINT)) {
          constraints.push(this.parseConstraint());
        } else if (this.match(TokenType.ANNOTATION)) {
          annotations.push(this.parseAnnotation());
        } else if (this.match(TokenType.DEFAULT)) {
          this.consume(TokenType.ASSIGN, "Expected ':=' after 'default'");
          link.default = this.parseExpression();
          this.consume(TokenType.SEMICOLON, "Expected ';' after default value");
        } else if (this.match(TokenType.READONLY)) {
          this.consume(TokenType.ASSIGN, "Expected ':=' after 'readonly'");
          link.readonly = this.parseBooleanLiteral();
          this.consume(
            TokenType.SEMICOLON,
            "Expected ';' after readonly value",
          );
        } else if (this.match(TokenType.EXTENDING)) {
          // extending inside link body: extending AbstractLink1, AbstractLink2;
          const bodyExtending = this.parseTypeRefList();
          if (!link.extending) {
            link.extending = bodyExtending;
          } else {
            link.extending.push(...bodyExtending);
          }
          this.consume(
            TokenType.SEMICOLON,
            "Expected ';' after extending clause",
          );
        } else if (this.match(TokenType.ON)) {
          // on target delete ... | on source delete ...
          const directionToken = this.peek();
          if (
            directionToken.type !== TokenType.IDENT ||
            (directionToken.value !== "target" &&
              directionToken.value !== "source")
          ) {
            throw this.error(
              `Expected 'target' or 'source' after 'on', got '${directionToken.value}'`,
            );
          }
          this.advance(); // consume direction ident

          if (directionToken.value === "target") {
            this.consume(
              TokenType.DELETE,
              "Expected 'delete' after 'target'",
            );
            link.onTargetDelete = this.parseDeletePolicy();
          } else {
            // source
            this.consume(
              TokenType.DELETE,
              "Expected 'delete' after 'source'",
            );
            link.onSourceDelete = this.parseSourceDeletePolicy();
          }
          this.consume(TokenType.SEMICOLON, "Expected ';' after delete policy");
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }

      this.consume(TokenType.RBRACE, "Expected '}' after link body");

      if (properties.length > 0) link.properties = properties;
      if (constraints.length > 0) link.constraints = constraints;
      if (annotations.length > 0) link.annotations = annotations;
    } else {
      this.consume(
        TokenType.SEMICOLON,
        "Expected ';' or '{' after link declaration",
      );
    }

    return link;
  }

  private parseConstraint(): AST.Constraint {
    let name: AST.Identifier | undefined;
    let delegated = false;

    if (this.match(TokenType.DELEGATED)) {
      delegated = true;
    }

    // Check if there's a named constraint
    if (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)) {
      const checkpoint = this.current;
      const possibleName = this.parseIdentifier();

      if (
        this.check(TokenType.LPAREN) || this.check(TokenType.ON) ||
        this.check(TokenType.SEMICOLON) || this.check(TokenType.LBRACE)
      ) {
        name = possibleName;
      } else {
        // It's not a name, restore position
        this.current = checkpoint;
      }
    }

    let on: AST.Expression | undefined;
    if (this.match(TokenType.ON)) {
      this.consume(TokenType.LPAREN, "Expected '(' after 'on'");
      on = this.parseExpression();
      this.consume(TokenType.RPAREN, "Expected ')' after expression");
    }

    let args: AST.Expression[] | undefined;
    if (name && this.match(TokenType.LPAREN)) {
      args = this.parseExpressionList();
      this.consume(TokenType.RPAREN, "Expected ')' after constraint arguments");
    }

    const constraint: AST.Constraint = {
      kind: "Constraint",
      name,
      delegated,
      on,
      args,
    };

    // Parse constraint body if present
    if (this.match(TokenType.LBRACE)) {
      const annotations: AST.Annotation[] = [];

      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        if (this.match(TokenType.ANNOTATION)) {
          annotations.push(this.parseAnnotation());
        } else if (this.match(TokenType.IDENT)) {
          // Check for errmessage
          const ident = this.previous();
          if (ident.value === "errmessage") {
            this.consume(TokenType.ASSIGN, "Expected ':=' after 'errmessage'");
            constraint.errmessage = this.parseStringLiteral();
            this.consume(TokenType.SEMICOLON, "Expected ';' after errmessage");
          }
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }

      this.consume(TokenType.RBRACE, "Expected '}' after constraint body");
      if (annotations.length > 0) constraint.annotations = annotations;
    } else {
      this.consume(TokenType.SEMICOLON, "Expected ';' or '{' after constraint");
    }

    return constraint;
  }

  private parseIndex(): AST.Index {
    let name: AST.Identifier | undefined;

    // Check if there's a named index
    if (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)) {
      const checkpoint = this.current;
      const possibleName = this.parseIdentifier();

      if (this.check(TokenType.ON)) {
        name = possibleName;
      } else {
        // It's not a name, restore position
        this.current = checkpoint;
      }
    }

    this.consume(TokenType.ON, "Expected 'on' in index declaration");
    this.consume(TokenType.LPAREN, "Expected '(' after 'on'");
    const on = this.parseExpression();
    this.consume(TokenType.RPAREN, "Expected ')' after expression");

    const index: AST.Index = { kind: "Index", name, on };

    // Parse index body if present
    if (this.match(TokenType.LBRACE)) {
      const annotations: AST.Annotation[] = [];

      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        if (this.match(TokenType.ANNOTATION)) {
          annotations.push(this.parseAnnotation());
        } else {
          throw this.error(
            `Unexpected token '${this.peek().value}' (type: ${this.peek().type}) in block body — did you mean a constraint, annotation, or member declaration?`,
          );
        }
      }

      this.consume(TokenType.RBRACE, "Expected '}' after index body");
      if (annotations.length > 0) index.annotations = annotations;
    } else {
      this.consume(TokenType.SEMICOLON, "Expected ';' or '{' after index");
    }

    return index;
  }

  private parseAnnotation(): AST.Annotation {
    const name = this.parseQualifiedName();

    let value: AST.Expression | undefined;
    if (this.match(TokenType.ASSIGN)) {
      value = this.parseExpression();
    }

    this.consume(TokenType.SEMICOLON, "Expected ';' after annotation");

    return { kind: "Annotation", name, value };
  }

  private parseAccessPolicy(): AST.AccessPolicy {
    this.consume(TokenType.POLICY, "Expected 'policy' after 'access'");
    const name = this.parseIdentifier();

    const actions: AST.AccessAction[] = [];
    let condition: AST.Expression | undefined;
    const annotations: AST.Annotation[] = [];

    this.consume(TokenType.LBRACE, "Expected '{' after policy name");

    while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      if (this.match(TokenType.ALLOW) || this.match(TokenType.DENY)) {
        const allow = this.previous().type === TokenType.ALLOW;
        const operations = this.parseAccessOperations();
        actions.push({ kind: "AccessAction", allow, operations });
        this.consume(TokenType.SEMICOLON, "Expected ';' after access action");
      } else if (this.match(TokenType.USING)) {
        this.consume(TokenType.LPAREN, "Expected '(' after 'using'");
        condition = this.parseExpression();
        this.consume(TokenType.RPAREN, "Expected ')' after expression");
        this.consume(TokenType.SEMICOLON, "Expected ';' after using clause");
      } else if (this.match(TokenType.ANNOTATION)) {
        annotations.push(this.parseAnnotation());
      } else {
        this.advance(); // Skip unknown tokens
      }
    }

    this.consume(TokenType.RBRACE, "Expected '}' after policy body");

    const policy: AST.AccessPolicy = {
      kind: "AccessPolicy",
      name,
      actions,
      condition,
    };
    if (annotations.length > 0) policy.annotations = annotations;

    return policy;
  }

  private parseTriggerDeclaration(): AST.TriggerDeclaration {
    const name = this.parseIdentifier();

    // Parse timing: "after" or "before" (contextual identifiers)
    const timingToken = this.peek();
    let timing: AST.TriggerTiming;
    if (
      timingToken.type === TokenType.IDENT &&
      (timingToken.value === "after" || timingToken.value === "before")
    ) {
      timing = timingToken.value as AST.TriggerTiming;
      this.advance();
    } else {
      throw this.error(
        `Expected 'after' or 'before' in trigger declaration, got '${timingToken.value}'`,
      );
    }

    // Parse comma-separated events (insert, update, delete)
    const events = this.parseTriggerEvents();

    // Parse scope: "for each" or "for all" (contextual identifiers)
    const forToken = this.peek();
    if (forToken.type !== TokenType.IDENT || forToken.value !== "for") {
      throw this.error(
        `Expected 'for' in trigger declaration, got '${forToken.value}'`,
      );
    }
    this.advance();

    const scopeToken = this.peek();
    let scope: AST.TriggerScope;
    if (
      scopeToken.type === TokenType.IDENT &&
      (scopeToken.value === "each" || scopeToken.value === "all")
    ) {
      scope = scopeToken.value as AST.TriggerScope;
      this.advance();
    } else {
      throw this.error(
        `Expected 'each' or 'all' after 'for' in trigger declaration, got '${scopeToken.value}'`,
      );
    }

    // Parse "do" keyword (contextual identifier)
    const doToken = this.peek();
    if (doToken.type !== TokenType.IDENT || doToken.value !== "do") {
      throw this.error(
        `Expected 'do' in trigger declaration, got '${doToken.value}'`,
      );
    }
    this.advance();

    // Parse body expression inside parens
    this.consume(TokenType.LPAREN, "Expected '(' after 'do'");
    const body = this.parseExpression();
    this.consume(
      TokenType.RPAREN,
      "Expected ')' after trigger body expression",
    );

    this.consume(
      TokenType.SEMICOLON,
      "Expected ';' after trigger declaration",
    );

    return {
      kind: "TriggerDeclaration",
      name,
      timing,
      events,
      scope,
      body,
    };
  }

  private parseTriggerEvents(): AST.TriggerEvent[] {
    const events: AST.TriggerEvent[] = [];

    do {
      if (this.match(TokenType.INSERT)) {
        events.push("insert");
      } else if (this.match(TokenType.UPDATE)) {
        events.push("update");
      } else if (this.match(TokenType.DELETE)) {
        events.push("delete");
      } else if (this.check(TokenType.IDENT)) {
        const val = this.peek().value;
        if (val === "insert" || val === "update" || val === "delete") {
          events.push(val as AST.TriggerEvent);
          this.advance();
        } else {
          throw this.error(
            `Expected trigger event (insert, update, delete), got '${val}'`,
          );
        }
      } else {
        throw this.error(
          `Expected trigger event (insert, update, delete), got '${this.peek().value}'`,
        );
      }
    } while (this.match(TokenType.COMMA));

    return events;
  }

  private parseRewriteDeclaration(): AST.RewriteDeclaration {
    // Parse comma-separated events: insert and/or update
    const events: AST.RewriteEvent[] = [];

    do {
      if (this.match(TokenType.INSERT)) {
        events.push("insert");
      } else if (this.match(TokenType.UPDATE)) {
        events.push("update");
      } else if (this.check(TokenType.IDENT)) {
        const val = this.peek().value;
        if (val === "insert" || val === "update") {
          events.push(val as AST.RewriteEvent);
          this.advance();
        } else {
          throw this.error(
            `Expected rewrite event (insert, update), got '${val}'`,
          );
        }
      } else {
        throw this.error(
          `Expected rewrite event (insert, update), got '${this.peek().value}'`,
        );
      }
    } while (this.match(TokenType.COMMA));

    // Parse contextual "using" keyword
    if (this.match(TokenType.USING)) {
      // Matched the USING keyword token
    } else if (
      this.check(TokenType.IDENT) && this.peek().value === "using"
    ) {
      this.advance();
    } else {
      throw this.error(
        `Expected 'using' after rewrite events, got '${this.peek().value}'`,
      );
    }

    // Parse the expression in parentheses
    this.consume(TokenType.LPAREN, "Expected '(' after 'using'");

    // Collect the expression text between the parens
    let parenDepth = 1;
    const exprTokens: string[] = [];

    while (!this.isAtEnd() && parenDepth > 0) {
      const token = this.peek();

      if (token.type === TokenType.LPAREN) {
        parenDepth++;
        exprTokens.push(token.value);
        this.advance();
      } else if (token.type === TokenType.RPAREN) {
        parenDepth--;
        if (parenDepth === 0) {
          break;
        }
        exprTokens.push(token.value);
        this.advance();
      } else {
        exprTokens.push(token.value);
        this.advance();
      }
    }

    this.consume(
      TokenType.RPAREN,
      "Expected ')' after rewrite expression",
    );

    this.consume(
      TokenType.SEMICOLON,
      "Expected ';' after rewrite declaration",
    );

    return {
      kind: "RewriteDeclaration",
      events,
      using: exprTokens.join(""),
    };
  }

  private parseFunctionParameters(): AST.FunctionParameter[] {
    const parameters: AST.FunctionParameter[] = [];

    if (!this.check(TokenType.RPAREN)) {
      do {
        const name = this.parseIdentifier();
        this.consume(TokenType.COLON, "Expected ':' after parameter name");
        const type = this.parseTypeRef();

        let typemod: AST.FunctionParameter["typemod"];
        let defaultValue: AST.Expression | undefined;

        if (this.match(TokenType.EQUALS)) {
          defaultValue = this.parseExpression();
        }

        parameters.push({
          kind: "FunctionParameter",
          name,
          type,
          typemod,
          default: defaultValue,
        });
      } while (this.match(TokenType.COMMA));
    }

    return parameters;
  }

  private parsePointerQualifiers(): {
    required?: boolean;
    multi?: boolean;
    abstract?: boolean;
    overloaded?: boolean;
  } {
    const qualifiers: any = {};

    while (true) {
      if (this.match(TokenType.REQUIRED)) {
        qualifiers.required = true;
      } else if (this.match(TokenType.MULTI)) {
        qualifiers.multi = true;
      } else if (this.match(TokenType.ABSTRACT)) {
        qualifiers.abstract = true;
      } else if (this.match(TokenType.OVERLOADED)) {
        qualifiers.overloaded = true;
      } else {
        break;
      }
    }

    return qualifiers;
  }

  private parseAccessOperations(): AST.AccessOperation[] {
    const operations: AST.AccessOperation[] = [];

    do {
      if (this.match(TokenType.SELECT)) {
        operations.push("select");
      } else if (this.match(TokenType.INSERT)) {
        operations.push("insert");
      } else if (this.match(TokenType.UPDATE)) {
        operations.push("update");
      } else if (this.match(TokenType.DELETE)) {
        operations.push("delete");
      } else if (this.check(TokenType.IDENT) && this.peek().value === "all") {
        this.advance();
        operations.push("all");
      } else {
        throw this.error(`Expected access operation, got ${this.peek().value}`);
      }
    } while (this.match(TokenType.COMMA));

    return operations;
  }

  private parseDeletePolicy(): AST.LinkDeclaration["onTargetDelete"] {
    const token = this.peek();

    if (token.type === TokenType.IDENT) {
      switch (token.value) {
        case "restrict":
          this.advance();
          return "restrict";
        case "cascade":
          this.advance();
          return "cascade";
        case "allow":
          this.advance();
          return "allow";
        case "deferred":
          this.advance();
          this.consume(TokenType.IDENT, "Expected 'restrict' after 'deferred'");
          return "deferred restrict";
        case "set": {
          this.advance();
          const nextToken = this.peek();
          if (
            nextToken.type === TokenType.IDENT &&
            nextToken.value === "empty"
          ) {
            this.advance();
            return "set empty";
          }
          throw this.error(
            `Expected 'empty' after 'set', got '${nextToken.value}'`,
          );
        }
      }
    }

    throw this.error(`Invalid delete policy: ${token.value}`);
  }

  private parseSourceDeletePolicy(): AST.LinkDeclaration["onSourceDelete"] {
    const token = this.peek();

    // "allow"
    if (token.type === TokenType.ALLOW) {
      this.advance();
      return "allow";
    }

    if (token.type === TokenType.IDENT && token.value === "allow") {
      this.advance();
      return "allow";
    }

    // "delete target"
    if (token.type === TokenType.DELETE) {
      this.advance();
      const targetToken = this.peek();
      if (
        targetToken.type === TokenType.IDENT &&
        targetToken.value === "target"
      ) {
        this.advance();
        return "delete target";
      }
      throw this.error(
        `Expected 'target' after 'delete', got '${targetToken.value}'`,
      );
    }

    throw this.error(`Invalid source delete policy: ${token.value}`);
  }

  private parseTypeRef(): AST.TypeRef {
    const name = this.parseQualifiedName();

    let array = false;
    const optional = false;
    let params: AST.TypeRef[] | undefined;

    // Check for parameterized type syntax: array<str>, tuple<int64, str>, range<int32>
    if (this.match(TokenType.LESS)) {
      params = [];
      params.push(this.parseTypeRef());
      while (this.match(TokenType.COMMA)) {
        params.push(this.parseTypeRef());
      }
      this.consume(TokenType.GREATER, "Expected '>' after type parameter(s)");
    }

    // Check for array syntax
    if (this.match(TokenType.LBRACKET)) {
      this.consume(TokenType.RBRACKET, "Expected ']' after '['");
      array = true;
    }

    // Check for optional syntax (not in SDL, but might be needed)

    return AST.createTypeRef(name, optional, array, params);
  }

  private parseTypeRefList(): AST.TypeRef[] {
    const types: AST.TypeRef[] = [];

    do {
      types.push(this.parseTypeRef());
    } while (this.match(TokenType.COMMA));

    return types;
  }

  private parseExpression(): AST.Expression {
    return this.parseConditionalExpression();
  }

  private parseConditionalExpression(): AST.Expression {
    let expr = this.parseOrExpression();

    if (this.match(TokenType.IF)) {
      const test = this.parseOrExpression();
      this.consume(TokenType.ELSE, "Expected 'else' in conditional expression");
      const alternate = this.parseConditionalExpression();

      expr = {
        kind: "ConditionalExpression",
        test,
        consequent: expr,
        alternate,
      };
    }

    return expr;
  }

  private parseOrExpression(): AST.Expression {
    let left = this.parseAndExpression();

    while (this.check(TokenType.IDENT) && this.peek().value === "or") {
      this.advance();
      const right = this.parseAndExpression();
      left = { kind: "BinaryOp", op: "or", left, right };
    }

    return left;
  }

  private parseAndExpression(): AST.Expression {
    let left = this.parseEqualityExpression();

    while (this.check(TokenType.IDENT) && this.peek().value === "and") {
      this.advance();
      const right = this.parseEqualityExpression();
      left = { kind: "BinaryOp", op: "and", left, right };
    }

    return left;
  }

  private parseEqualityExpression(): AST.Expression {
    let left = this.parseComparisonExpression();

    while (true) {
      let op: string | null = null;

      if (this.match(TokenType.EQUALS)) op = "=";
      else if (this.match(TokenType.NOTEQUALS)) op = "!=";
      else if (this.match(TokenType.QUESTIONEQ)) op = "?=";
      else if (this.match(TokenType.QUESTIONNEQ)) op = "?!=";

      if (op) {
        const right = this.parseComparisonExpression();
        left = { kind: "BinaryOp", op, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  private parseComparisonExpression(): AST.Expression {
    let left = this.parseAdditiveExpression();

    while (true) {
      let op: string | null = null;

      if (this.match(TokenType.LESS)) op = "<";
      else if (this.match(TokenType.LESSEQ)) op = "<=";
      else if (this.match(TokenType.GREATER)) op = ">";
      else if (this.match(TokenType.GREATEREQ)) op = ">=";

      if (op) {
        const right = this.parseAdditiveExpression();
        left = { kind: "BinaryOp", op, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  private parseAdditiveExpression(): AST.Expression {
    let left = this.parseMultiplicativeExpression();

    while (true) {
      let op: string | null = null;

      if (this.match(TokenType.PLUS)) op = "+";
      else if (this.match(TokenType.MINUS)) op = "-";
      else if (this.match(TokenType.PLUSPLUS)) op = "++";

      if (op) {
        const right = this.parseMultiplicativeExpression();
        left = { kind: "BinaryOp", op, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  private parseMultiplicativeExpression(): AST.Expression {
    let left = this.parseUnaryExpression();

    while (true) {
      let op: string | null = null;

      if (this.match(TokenType.STAR)) op = "*";
      else if (this.match(TokenType.SLASH)) op = "/";
      else if (this.match(TokenType.PERCENT)) op = "%";

      if (op) {
        const right = this.parseUnaryExpression();
        left = { kind: "BinaryOp", op, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  private parseUnaryExpression(): AST.Expression {
    if (this.match(TokenType.MINUS)) {
      const operand = this.parseUnaryExpression();
      return { kind: "UnaryOp", op: "-", operand };
    }

    if (this.check(TokenType.IDENT) && this.peek().value === "not") {
      this.advance();
      const operand = this.parseUnaryExpression();
      return { kind: "UnaryOp", op: "not", operand };
    }

    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): AST.Expression {
    let expr = this.parsePrimaryExpression();

    while (true) {
      if (this.match(TokenType.DOT)) {
        const path = [this.parseIdentifier().value];
        expr = { kind: "PathExpression", path: [".", ...path] };
      } else if (this.match(TokenType.LPAREN)) {
        // Function call
        const args = this.parseExpressionList();
        this.consume(TokenType.RPAREN, "Expected ')' after function arguments");

        if (expr.kind === "PathExpression") {
          const name = AST.createQualifiedName(expr.path);
          expr = { kind: "FunctionCall", name, args };
        } else {
          throw this.error("Invalid function call");
        }
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimaryExpression(): AST.Expression {
    // Literals
    if (this.check(TokenType.STRING)) {
      return AST.createLiteral("string", this.parseStringLiteral());
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

    // Parameters
    if (this.check(TokenType.PARAMETER)) {
      const name = this.advance().value;
      return { kind: "Parameter", name };
    }

    // Parenthesized expression
    if (this.match(TokenType.LPAREN)) {
      const expr = this.parseExpression();
      this.consume(TokenType.RPAREN, "Expected ')' after expression");
      return expr;
    }

    // Path expression starting with dot (e.g., .property)
    if (this.match(TokenType.DOT)) {
      const path = [".", this.parseIdentifier().value];
      return { kind: "PathExpression", path };
    }

    // Handle keywords that can start expressions (like "select", "global")
    if (this.check(TokenType.SELECT)) {
      return this.parseEdgeQLExpression();
    }

    if (this.check(TokenType.GLOBAL)) {
      this.advance();
      const name = this.parseIdentifier();
      return { kind: "PathExpression", path: ["global", name.value] };
    }

    // Identifier or qualified name (could be function name)
    if (this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)) {
      const name = this.parseQualifiedName();
      return { kind: "PathExpression", path: name.parts };
    }

    throw this.error(`Unexpected token in expression: ${this.peek().value}`);
  }

  private parseExpressionList(): AST.Expression[] {
    const expressions: AST.Expression[] = [];

    if (!this.check(TokenType.RPAREN)) {
      do {
        expressions.push(this.parseExpression());
      } while (this.match(TokenType.COMMA));
    }

    return expressions;
  }

  private parseIdentifier(): AST.Identifier {
    if (this.check(TokenType.IDENT)) {
      const value = this.advance().value;
      return AST.createIdentifier(value, false);
    }

    if (this.check(TokenType.BACKTICK_IDENT)) {
      const value = this.advance().value;
      return AST.createIdentifier(value, true);
    }

    throw this.error(`Expected identifier, got ${this.peek().value}`);
  }

  private parseQualifiedName(): AST.QualifiedName {
    const parts: string[] = [];

    if (
      this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT) ||
      this.check(TokenType.DEFAULT)
    ) {
      // Handle keywords that can be used as identifiers (like "default")
      const token = this.peek();
      if (
        token.type === TokenType.DEFAULT || token.type === TokenType.IDENT ||
        token.type === TokenType.BACKTICK_IDENT
      ) {
        parts.push(token.value);
        this.advance();
      }

      while (this.match(TokenType.DOUBLECOLON)) {
        if (
          this.check(TokenType.IDENT) || this.check(TokenType.BACKTICK_IDENT)
        ) {
          parts.push(this.parseIdentifier().value);
        } else {
          throw this.error(`Expected identifier after '::'`);
        }
      }
    } else {
      throw this.error(`Expected qualified name, got ${this.peek().value}`);
    }

    return AST.createQualifiedName(parts);
  }

  private parseStringLiteral(): string {
    if (!this.check(TokenType.STRING)) {
      throw this.error(`Expected string literal, got ${this.peek().value}`);
    }
    return this.advance().value;
  }

  private parseBooleanLiteral(): boolean {
    if (this.check(TokenType.BOOLEAN)) {
      return this.advance().value === "true";
    }

    if (this.check(TokenType.TRUE) || this.check(TokenType.FALSE)) {
      return this.advance().type === TokenType.TRUE;
    }

    throw this.error(`Expected boolean literal, got ${this.peek().value}`);
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

  private parseEdgeQLExpression(): AST.Expression {
    // For now, parse EdgeQL expressions as simplified PathExpressions
    // This is a temporary solution until full EdgeQL support is implemented
    const tokens: string[] = [];
    let parenDepth = 0;

    while (!this.isAtEnd()) {
      const token = this.peek();

      if (token.type === TokenType.LPAREN) {
        parenDepth++;
        tokens.push(token.value);
        this.advance();
      } else if (token.type === TokenType.RPAREN) {
        if (parenDepth === 0) {
          // This is the closing paren of our parent expression
          break;
        }
        parenDepth--;
        tokens.push(token.value);
        this.advance();
      } else if (token.type === TokenType.SEMICOLON && parenDepth === 0) {
        // End of statement
        break;
      } else {
        tokens.push(token.value);
        this.advance();
      }
    }

    return { kind: "PathExpression", path: tokens };
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
