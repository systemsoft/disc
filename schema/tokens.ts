/**
 * SDL Token types and definitions
 */

export enum TokenType {
  // Literals
  STRING = "STRING",
  INTEGER = "INTEGER",
  FLOAT = "FLOAT",
  BOOLEAN = "BOOLEAN",

  // Identifiers
  IDENT = "IDENT",
  BACKTICK_IDENT = "BACKTICK_IDENT",

  // Keywords
  MODULE = "MODULE",
  TYPE = "TYPE",
  SCALAR = "SCALAR",
  PROPERTY = "PROPERTY",
  LINK = "LINK",
  CONSTRAINT = "CONSTRAINT",
  INDEX = "INDEX",
  ALIAS = "ALIAS",
  FUNCTION = "FUNCTION",
  GLOBAL = "GLOBAL",
  ANNOTATION = "ANNOTATION",
  ABSTRACT = "ABSTRACT",
  EXTENDING = "EXTENDING",
  REQUIRED = "REQUIRED",
  MULTI = "MULTI",
  OVERLOADED = "OVERLOADED",
  USING = "USING",
  DELEGATED = "DELEGATED",
  DEFAULT = "DEFAULT",
  READONLY = "READONLY",
  ON = "ON",
  TRUE = "TRUE",
  FALSE = "FALSE",
  IF = "IF",
  ELSE = "ELSE",

  // Access control
  ACCESS = "ACCESS",
  POLICY = "POLICY",
  ALLOW = "ALLOW",
  DENY = "DENY",
  SELECT = "SELECT",
  INSERT = "INSERT",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
  TRIGGER = "TRIGGER",

  // Operators & Punctuation
  ASSIGN = "ASSIGN", // :=
  ARROW = "ARROW", // ->
  COLON = "COLON", // :
  SEMICOLON = "SEMICOLON", // ;
  COMMA = "COMMA", // ,
  DOT = "DOT", // .
  DOUBLECOLON = "DOUBLECOLON", // ::
  EQUALS = "EQUALS", // =
  PLUS = "PLUS", // +
  MINUS = "MINUS", // -
  STAR = "STAR", // *
  SLASH = "SLASH", // /
  PERCENT = "PERCENT", // %
  PLUSPLUS = "PLUSPLUS", // ++
  LESS = "LESS", // <
  GREATER = "GREATER", // >
  LESSEQ = "LESSEQ", // <=
  GREATEREQ = "GREATEREQ", // >=
  NOTEQUALS = "NOTEQUALS", // !=
  QUESTIONEQ = "QUESTIONEQ", // ?=
  QUESTIONNEQ = "QUESTIONNEQ", // ?!=

  // Brackets
  LPAREN = "LPAREN", // (
  RPAREN = "RPAREN", // )
  LBRACE = "LBRACE", // {
  RBRACE = "RBRACE", // }
  LBRACKET = "LBRACKET", // [
  RBRACKET = "RBRACKET", // ]
  LANGLE = "LANGLE", // <
  RANGLE = "RANGLE", // >

  // Special
  PARAMETER = "PARAMETER", // $param
  AT = "AT", // @
  COMMENT = "COMMENT", // # comment
  EOF = "EOF", // End of file
  NEWLINE = "NEWLINE", // Line break
  WHITESPACE = "WHITESPACE", // Space, tab
}

export const KEYWORDS = new Map<string, TokenType>([
  ["module", TokenType.MODULE],
  ["type", TokenType.TYPE],
  ["scalar", TokenType.SCALAR],
  ["property", TokenType.PROPERTY],
  ["link", TokenType.LINK],
  ["constraint", TokenType.CONSTRAINT],
  ["index", TokenType.INDEX],
  ["alias", TokenType.ALIAS],
  ["function", TokenType.FUNCTION],
  ["global", TokenType.GLOBAL],
  ["annotation", TokenType.ANNOTATION],
  ["abstract", TokenType.ABSTRACT],
  ["extending", TokenType.EXTENDING],
  ["required", TokenType.REQUIRED],
  ["multi", TokenType.MULTI],
  ["overloaded", TokenType.OVERLOADED],
  ["using", TokenType.USING],
  ["delegated", TokenType.DELEGATED],
  ["default", TokenType.DEFAULT],
  ["readonly", TokenType.READONLY],
  ["on", TokenType.ON],
  ["true", TokenType.TRUE],
  ["false", TokenType.FALSE],
  ["if", TokenType.IF],
  ["else", TokenType.ELSE],
  ["access", TokenType.ACCESS],
  ["policy", TokenType.POLICY],
  ["allow", TokenType.ALLOW],
  ["deny", TokenType.DENY],
  ["select", TokenType.SELECT],
  ["insert", TokenType.INSERT],
  ["update", TokenType.UPDATE],
  ["delete", TokenType.DELETE],
  ["trigger", TokenType.TRIGGER],
]);

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
  offset: number;
}

export function createToken(
  type: TokenType,
  value: string,
  line: number,
  column: number,
  offset: number,
): Token {
  return { type, value, line, column, offset };
}
