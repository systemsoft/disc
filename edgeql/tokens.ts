/**
 * EdgeQL Token types and definitions
 */

export enum TokenType {
  // Literals
  STRING = "STRING",
  INTEGER = "INTEGER",
  FLOAT = "FLOAT",
  BOOLEAN = "BOOLEAN",
  BYTES = "BYTES",
  UUID = "UUID",

  // Identifiers
  IDENT = "IDENT",
  BACKTICK_IDENT = "BACKTICK_IDENT",
  RESERVED_IDENT = "RESERVED_IDENT",

  // Query Keywords
  SELECT = "SELECT",
  INSERT = "INSERT",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
  FOR = "FOR",
  WITH = "WITH",

  // Clauses
  FILTER = "FILTER",
  ORDER = "ORDER",
  BY = "BY",
  ASC = "ASC",
  DESC = "DESC",
  LIMIT = "LIMIT",
  OFFSET = "OFFSET",
  GROUP = "GROUP",

  // Window function keywords (non-reserved)
  OVER = "OVER",
  PARTITION = "PARTITION",
  ROWS = "ROWS",
  RANGE = "RANGE",
  GROUPS = "GROUPS",
  BETWEEN = "BETWEEN",
  UNBOUNDED = "UNBOUNDED",
  PRECEDING = "PRECEDING",
  FOLLOWING = "FOLLOWING",
  CURRENT = "CURRENT",

  // Logical
  AND = "AND",
  OR = "OR",
  NOT = "NOT",
  EXISTS = "EXISTS",
  DISTINCT = "DISTINCT",
  ALL = "ALL",

  // Type Operations
  IS = "IS",
  TYPEOF = "TYPEOF",
  INTROSPECT = "INTROSPECT",
  DETACHED = "DETACHED",
  GLOBAL = "GLOBAL",

  // Set Operations
  UNION = "UNION",
  EXCEPT = "EXCEPT",
  INTERSECT = "INTERSECT",
  IN = "IN",

  // Conditionals
  IF = "IF",
  ELSE = "ELSE",
  THEN = "THEN",
  WHEN = "WHEN",
  CASE = "CASE",

  // Cardinality
  REQUIRED = "REQUIRED",
  OPTIONAL = "OPTIONAL",
  SINGLE = "SINGLE",
  MULTI = "MULTI",
  SET = "SET",

  // Conflict
  UNLESS = "UNLESS",
  CONFLICT = "CONFLICT",
  ON = "ON",

  // String Operations
  LIKE = "LIKE",
  ILIKE = "ILIKE",

  // Special
  MODULE = "MODULE",
  TYPE = "TYPE",
  TRUE = "TRUE",
  FALSE = "FALSE",
  EMPTY = "EMPTY",

  // Operators
  ASSIGN = "ASSIGN", // :=
  SUBASSIGN = "SUBASSIGN", // -=
  ADDASSIGN = "ADDASSIGN", // +=
  ARROW = "ARROW", // ->
  COALESCE = "COALESCE", // ??
  NAMESPACE = "NAMESPACE", // ::
  BACKLINK = "BACKLINK", // .<
  OPTIONALLINK = "OPTIONALLINK", // .?>
  FLOORDIV = "FLOORDIV", // //
  CONCAT = "CONCAT", // ++
  POW = "POW", // **

  // Comparison
  EQUALS = "EQUALS", // =
  NOTEQUALS = "NOTEQUALS", // !=
  LESS = "LESS", // <
  GREATER = "GREATER", // >
  LESSEQ = "LESSEQ", // <=
  GREATEREQ = "GREATEREQ", // >=
  DISTINCTFROM = "DISTINCTFROM", // ?!=
  NOTDISTINCTFROM = "NOTDISTINCTFROM", // ?=

  // Arithmetic
  PLUS = "PLUS", // +
  MINUS = "MINUS", // -
  STAR = "STAR", // *
  SLASH = "SLASH", // /
  PERCENT = "PERCENT", // %

  // Punctuation
  DOT = "DOT", // .
  COMMA = "COMMA", // ,
  SEMICOLON = "SEMICOLON", // ;
  COLON = "COLON", // :

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
  HASH = "HASH", // #
  EOF = "EOF", // End of file
  NEWLINE = "NEWLINE", // Line break
  WHITESPACE = "WHITESPACE", // Space, tab
  COMMENT = "COMMENT", // # comment
}

export const KEYWORDS = new Map<string, TokenType>([
  // Query keywords
  ["select", TokenType.SELECT],
  ["insert", TokenType.INSERT],
  ["update", TokenType.UPDATE],
  ["delete", TokenType.DELETE],
  ["for", TokenType.FOR],
  ["with", TokenType.WITH],

  // Clauses
  ["filter", TokenType.FILTER],
  ["order", TokenType.ORDER],
  ["by", TokenType.BY],
  ["asc", TokenType.ASC],
  ["desc", TokenType.DESC],
  ["limit", TokenType.LIMIT],
  ["offset", TokenType.OFFSET],
  ["group", TokenType.GROUP],

  // Window function keywords
  ["over", TokenType.OVER],
  ["partition", TokenType.PARTITION],
  ["rows", TokenType.ROWS],
  ["range", TokenType.RANGE],
  ["groups", TokenType.GROUPS],
  ["between", TokenType.BETWEEN],
  ["unbounded", TokenType.UNBOUNDED],
  ["preceding", TokenType.PRECEDING],
  ["following", TokenType.FOLLOWING],
  ["current", TokenType.CURRENT],

  // Logical
  ["and", TokenType.AND],
  ["or", TokenType.OR],
  ["not", TokenType.NOT],
  ["exists", TokenType.EXISTS],
  ["distinct", TokenType.DISTINCT],
  ["all", TokenType.ALL],

  // Type operations
  ["is", TokenType.IS],
  ["typeof", TokenType.TYPEOF],
  ["introspect", TokenType.INTROSPECT],
  ["detached", TokenType.DETACHED],
  ["global", TokenType.GLOBAL],

  // Set operations
  ["union", TokenType.UNION],
  ["except", TokenType.EXCEPT],
  ["intersect", TokenType.INTERSECT],
  ["in", TokenType.IN],

  // Conditionals
  ["if", TokenType.IF],
  ["else", TokenType.ELSE],
  ["then", TokenType.THEN],
  ["when", TokenType.WHEN],
  ["case", TokenType.CASE],

  // Cardinality
  ["required", TokenType.REQUIRED],
  ["optional", TokenType.OPTIONAL],
  ["single", TokenType.SINGLE],
  ["multi", TokenType.MULTI],
  ["set", TokenType.SET],

  // Conflict
  ["unless", TokenType.UNLESS],
  ["conflict", TokenType.CONFLICT],
  ["on", TokenType.ON],

  // String operations
  ["like", TokenType.LIKE],
  ["ilike", TokenType.ILIKE],

  // Special
  ["module", TokenType.MODULE],
  ["type", TokenType.TYPE],
  ["true", TokenType.TRUE],
  ["false", TokenType.FALSE],
  ["empty", TokenType.EMPTY],
]);

// Reserved keywords that cannot be used as identifiers
export const RESERVED_KEYWORDS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "for",
  "with",
  "filter",
  "order",
  "by",
  "and",
  "or",
  "not",
  "if",
  "else",
  "true",
  "false",
  "is",
  "in",
  "union",
  "except",
  "intersect",
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
